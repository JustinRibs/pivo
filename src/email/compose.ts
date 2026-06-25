import fs from 'node:fs';
import path from 'node:path';
import mjml2html from 'mjml';
import { TautulliClient, formatDuration } from '../tautulli.js';
import { RadarrClient, SonarrClient, fetchRemoteImage, type UpcomingEpisode } from '../arr.js';
import { fetchUptimePercent } from '../uptime.js';
import { UPLOADS_DIR } from '../config.js';
import { lookupCloudinaryUrl } from '../db.js';
import { buildPublicId, cloudinaryConfigFromSettings, uploadImageBuffer, type CloudinaryConfig } from '../cloudinary.js';
import type { ComposedNewsletter, HistoryRow, RecentlyAddedItem, Settings, UsersTableRow } from '../types.js';
import { buildMjml, UNSUBSCRIBE_PLACEHOLDER, type FlexStats, type RenderedItem, type RenderedShow, type RenderedStatRow, type RenderedUpcomingMovie, type RenderedUpcomingShow, type Superlative, type TemplateData } from './template.js';

interface Attachment {
  filename: string;
  cid: string;
  content: Buffer;
  contentType: string;
}

export interface ComposeOptions {
  /** When true, fetch zero images and use placeholder posters. Useful for fast previews. */
  skipImages?: boolean;
}

export async function composeNewsletter(settings: Settings, opts: ComposeOptions = {}): Promise<ComposedNewsletter> {
  const tautulli = new TautulliClient(settings.tautulli_url, settings.tautulli_api_key);
  const attachments: Attachment[] = [];
  let cidCounter = 0;
  const nextCid = () => `img${++cidCounter}@pivo`;
  const cloudinary = cloudinaryConfigFromSettings(settings);

  function attachAsCid(filenameHint: string, bytes: Buffer, contentType: string): string {
    const cid = nextCid();
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    attachments.push({
      filename: `${filenameHint}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_'),
      cid,
      content: bytes,
      contentType
    });
    return `cid:${cid}`;
  }

  /**
   * Resolve a Tautulli `thumb` reference to a final `src=` value for the email.
   * Returns a Cloudinary https URL when image hosting is configured (so the
   * email doesn't ship the bytes), otherwise falls back to a CID attachment.
   * On Cloudinary errors we still attach the bytes — better a heavier email
   * than a broken poster.
   */
  async function resolveImage(img: string, filenameHint: string, width = 400): Promise<string | undefined> {
    if (opts.skipImages || !img) return undefined;

    if (cloudinary) {
      const publicId = buildPublicId(cloudinary.folder, filenameHint, img);
      const url = await uploadFromTautulli(cloudinary, publicId, img, width);
      if (url) return url;
      // fall through to CID on upload failure
    }

    const fetched = await tautulli.fetchImage(img, { width });
    if (!fetched) return undefined;
    return attachAsCid(filenameHint, fetched.bytes, fetched.contentType);
  }

  /**
   * Resolve a publicly-hosted image URL (TMDB/TVDB poster from Radarr/Sonarr)
   * for use in the email. When Cloudinary is enabled we upload once and cache;
   * otherwise we just embed the remote URL directly since these CDNs are public.
   */
  async function resolveRemoteImage(remoteUrl: string | undefined, filenameHint: string, width = 200): Promise<string | undefined> {
    if (opts.skipImages || !remoteUrl) return undefined;

    if (cloudinary) {
      const publicId = buildPublicId(cloudinary.folder, filenameHint, remoteUrl);
      try {
        const cached = lookupCloudinaryUrl(publicId);
        if (cached) return cached;
        const fetched = await fetchRemoteImage(remoteUrl);
        if (!fetched) return remoteUrl;
        return await uploadImageBuffer(cloudinary, fetched.bytes, publicId, fetched.contentType);
      } catch (err) {
        console.warn(`Cloudinary upload failed for ${publicId}, falling back to remote URL:`, err);
        return remoteUrl;
      }
    }

    return remoteUrl;
  }

  async function uploadFromTautulli(
    cfg: CloudinaryConfig,
    publicId: string,
    img: string,
    width: number
  ): Promise<string | undefined> {
    try {
      // Skip the Tautulli round-trip on cache hits.
      const cached = lookupCloudinaryUrl(publicId);
      if (cached) return cached;
      const fetched = await tautulli.fetchImage(img, { width });
      if (!fetched) return undefined;
      return await uploadImageBuffer(cfg, fetched.bytes, publicId, fetched.contentType);
    } catch (err) {
      console.warn(`Cloudinary upload failed for ${publicId}, falling back to CID:`, err);
      return undefined;
    }
  }

  // --- Upcoming releases (Radarr / Sonarr) ----------------------------------
  // Fetched first so we know whether to skip Recently Added in "replace" mode.
  const upcomingWindowDays = Math.max(1, Math.min(60, Number(settings.upcoming_window_days) || 7));
  let upcomingMovies: RenderedUpcomingMovie[] | undefined;
  let upcomingShows: RenderedUpcomingShow[] | undefined;

  if (
    settings.enable_upcoming &&
    ((settings.radarr_enabled && settings.radarr_url && settings.radarr_api_key) ||
      (settings.sonarr_enabled && settings.sonarr_url && settings.sonarr_api_key))
  ) {
    const now = new Date();
    const end = new Date(now.getTime() + upcomingWindowDays * 86400_000);
    const startISO = now.toISOString();
    const endISO = end.toISOString();

    if (settings.radarr_enabled && settings.radarr_url && settings.radarr_api_key) {
      try {
        const radarr = new RadarrClient(settings.radarr_url, settings.radarr_api_key);
        const upcoming = await radarr.getUpcoming(startISO, endISO);
        upcomingMovies = [];
        for (const m of upcoming) {
          const posterSrc = await resolveRemoteImage(m.posterRemoteUrl, `upcoming-movie-${m.id}`, 200);
          upcomingMovies.push({
            title: m.title,
            year: m.year ? String(m.year) : undefined,
            overview: m.overview,
            posterSrc,
            dateLabel: formatShortDate(m.releaseDate),
            releaseLabel: releaseLabel(m.releaseType)
          });
        }
      } catch (err) {
        console.warn('Failed to load Radarr upcoming:', err);
      }
    }

    if (settings.sonarr_enabled && settings.sonarr_url && settings.sonarr_api_key) {
      try {
        const sonarr = new SonarrClient(settings.sonarr_url, settings.sonarr_api_key);
        const episodes = await sonarr.getUpcoming(startISO, endISO);
        const grouped = new Map<number, { title: string; posterRemoteUrl?: string; eps: UpcomingEpisode[] }>();
        for (const ep of episodes) {
          const entry = grouped.get(ep.seriesId);
          if (entry) entry.eps.push(ep);
          else grouped.set(ep.seriesId, { title: ep.seriesTitle, posterRemoteUrl: ep.posterRemoteUrl, eps: [ep] });
        }
        upcomingShows = [];
        for (const [seriesId, grp] of grouped) {
          const posterSrc = await resolveRemoteImage(grp.posterRemoteUrl, `upcoming-show-${seriesId}`, 200);
          upcomingShows.push({
            title: grp.title,
            posterSrc,
            episodes: grp.eps.map((e) => ({
              label: `S${pad2(e.seasonNumber)}E${pad2(e.episodeNumber)}`,
              title: e.episodeTitle,
              dateLabel: formatShortDate(e.airDateUtc)
            }))
          });
        }
      } catch (err) {
        console.warn('Failed to load Sonarr upcoming:', err);
      }
    }
  }

  const hasUpcoming = (upcomingMovies && upcomingMovies.length > 0) || (upcomingShows && upcomingShows.length > 0);
  // In "replace" mode, Recently Added is suppressed whenever Coming Soon has content.
  const showRecent = !(settings.upcoming_replaces_recent && hasUpcoming);

  // --- Recently Added -------------------------------------------------------
  const movies: RenderedItem[] = [];
  const shows: RenderedShow[] = [];
  const music: RenderedItem[] = [];

  if (showRecent) {
    // Determine "recently added" window: pull more than the cap, then filter by toggles client-side
    const fetchCount = Math.max(settings.recently_added_count * 2, 20);
    const all = await tautulli.getRecentlyAdded(fetchCount);

  if (settings.include_movies) {
    const movieItems = all.filter((i) => i.media_type === 'movie').slice(0, settings.recently_added_count);
    for (const m of movieItems) {
      const posterSrc = m.thumb ? await resolveImage(m.thumb, `movie-${m.rating_key}`, 200) : undefined;
      movies.push({
        title: m.title,
        year: m.year ? String(m.year) : undefined,
        summary: settings.show_summaries ? m.summary : undefined,
        posterSrc,
        metaParts: buildItemMeta(m)
      });
    }
  }

  if (settings.include_tv) {
    // Group episodes by show (grandparent_title)
    const episodes = all.filter((i) => i.media_type === 'episode').slice(0, settings.recently_added_count);
    const grouped = new Map<string, RecentlyAddedItem[]>();
    for (const ep of episodes) {
      const key = ep.grandparent_title || ep.parent_title || ep.title;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(ep);
    }

    for (const [showName, eps] of grouped) {
      const showThumb = eps[0].grandparent_thumb || eps[0].parent_thumb;
      const posterSrc = showThumb ? await resolveImage(showThumb, `show-${eps[0].grandparent_rating_key || eps[0].rating_key}`, 200) : undefined;
      const renderedEps = eps
        .sort((a, b) => {
          const sa = parseInt((a.parent_title || '').replace(/\D/g, '') || '0', 10);
          const sb = parseInt((b.parent_title || '').replace(/\D/g, '') || '0', 10);
          if (sa !== sb) return sa - sb;
          const ea = parseInt(((a as any).media_index || '0').toString(), 10);
          const eb = parseInt(((b as any).media_index || '0').toString(), 10);
          if (ea !== eb) return ea - eb;
          return (a.title || '').localeCompare(b.title || '');
        })
        .map((ep) => {
          const seasonNum = parseInt((ep.parent_title || '').replace(/\D/g, '') || '0', 10);
          const epNum = parseInt(((ep as any).media_index || '0').toString(), 10);
          let label = ep.parent_title || 'Episode';
          if (seasonNum && epNum) label = `S${pad2(seasonNum)}E${pad2(epNum)}`;
          else if (seasonNum) label = `Season ${seasonNum}`;
          return {
            label,
            title: ep.title
            // Per-episode summaries omitted by design — keeps the TV section compact.
          };
        });
      shows.push({ title: showName, posterSrc, episodes: renderedEps });
    }
  }

  if (settings.include_music) {
    const albumItems = all.filter((i) => i.media_type === 'album').slice(0, settings.recently_added_count);
    for (const a of albumItems) {
      const posterSrc = a.thumb ? await resolveImage(a.thumb, `album-${a.rating_key}`, 200) : undefined;
      music.push({
        title: a.title,
        subtitle: a.parent_title,
        year: a.year ? String(a.year) : undefined,
        summary: settings.show_summaries ? a.summary : undefined,
        posterSrc
      });
    }
  }
  } // end if (showRecent)

  // Optional sections
  let topMovies: RenderedStatRow[] | undefined;
  let topTV: RenderedStatRow[] | undefined;
  let topUsers: RenderedStatRow[] | undefined;
  let stats: { totalPlays: number; totalDuration: string; windowDays: number } | undefined;

  if (settings.enable_top_watched || settings.enable_top_users) {
    try {
      const home = await tautulli.getHomeStats(settings.stats_window_days, 5);
      const findStat = (id: string) => home.find((s) => s.stat_id === id);

      if (settings.enable_top_watched) {
        const tm = findStat('top_movies');
        if (tm) {
          topMovies = [];
          for (const r of (tm.rows || []).slice(0, 5)) {
            const posterSrc = r.thumb ? await resolveImage(r.thumb, `top-movie-${r.rating_key}`, 200) : undefined;
            topMovies.push({
              label: r.title || '—',
              detail: `${r.total_plays || 0} play${r.total_plays === 1 ? '' : 's'}`,
              posterSrc
            });
          }
        }
        const tt = findStat('top_tv');
        if (tt) {
          topTV = [];
          for (const r of (tt.rows || []).slice(0, 5)) {
            const posterSrc = r.thumb ? await resolveImage(r.thumb, `top-tv-${r.rating_key}`, 200) : undefined;
            topTV.push({
              label: r.title || '—',
              detail: `${r.total_plays || 0} play${r.total_plays === 1 ? '' : 's'}`,
              posterSrc
            });
          }
        }
      }

      if (settings.enable_top_users) {
        const tu = findStat('top_users');
        if (tu) {
          topUsers = [];
          for (const r of (tu.rows || []).slice(0, 5)) {
            const posterSrc = r.user_thumb ? await resolveImage(r.user_thumb, `user-${r.user_id}`, 80) : undefined;
            topUsers.push({
              label: r.user || `User ${r.user_id}`,
              detail: `${r.total_plays || 0} play${r.total_plays === 1 ? '' : 's'}`,
              posterSrc
            });
          }
        }
      }
    } catch (err) {
      // home stats are best-effort
      console.warn('Failed to load home stats:', err);
    }
  }

  // Fun stat needs the watch-time total too, so fetch totals when either is on.
  let totalWatchSec = 0;
  if (settings.enable_stats || settings.enable_fun_stats) {
    try {
      const totals = await tautulli.getHistoryTotals(settings.stats_window_days);
      totalWatchSec = totals.totalDurationSec;
      if (settings.enable_stats) {
        stats = {
          totalPlays: totals.totalPlays,
          totalDuration: formatDuration(totals.totalDurationSec),
          windowDays: settings.stats_window_days
        };
      }
    } catch (err) {
      console.warn('Failed to load stats totals:', err);
    }
  }

  // --- "Server Wrapped" superlatives ----------------------------------------
  let superlatives: Superlative[] | undefined;
  if (settings.enable_superlatives) {
    try {
      const [rows, usersTable] = await Promise.all([
        tautulli.getHistory({ afterDays: settings.stats_window_days, length: 2000 }),
        tautulli.getUsersTable()
      ]);
      const awards = computeSuperlatives(rows, usersTable);
      if (awards.length > 0) superlatives = awards;
    } catch (err) {
      console.warn('Failed to compute superlatives:', err);
    }
  }

  // --- Homelab flex bar ------------------------------------------------------
  let flex: FlexStats | undefined;
  if (settings.enable_flex_bar) {
    try {
      flex = await computeFlexStats(tautulli, settings);
    } catch (err) {
      console.warn('Failed to compute flex bar:', err);
    }
  }

  // --- Seasonal theme + fun stat --------------------------------------------
  const now = new Date();
  const season = settings.seasonal_theme_enabled ? seasonalTheme(now) : null;
  const funStat = settings.enable_fun_stats && totalWatchSec > 0 ? funStatCaption(totalWatchSec, now) : undefined;

  // Optional logo. Hosted on Cloudinary when configured, otherwise CID-attached.
  let logoSrc: string | undefined;
  if (settings.brand_logo_path) {
    const logoFull = path.join(UPLOADS_DIR, path.basename(settings.brand_logo_path));
    if (fs.existsSync(logoFull)) {
      try {
        const bytes = fs.readFileSync(logoFull);
        const ct = guessContentType(logoFull);
        if (cloudinary) {
          // The mtime makes the public_id change when the user re-uploads a logo
          // with the same filename, so the new image actually shows up.
          const mtime = fs.statSync(logoFull).mtimeMs;
          const publicId = buildPublicId(cloudinary.folder, `logo-${path.basename(logoFull)}`, `${logoFull}@${mtime}`);
          try {
            logoSrc = await uploadImageBuffer(cloudinary, bytes, publicId, ct);
          } catch (err) {
            console.warn('Cloudinary logo upload failed, falling back to CID:', err);
          }
        }
        if (!logoSrc) {
          logoSrc = attachAsCid(`logo-${path.basename(logoFull, path.extname(logoFull))}`, bytes, ct);
        }
      } catch (err) {
        console.warn('Failed to attach logo:', err);
      }
    }
  }

  const generatedDate = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });

  const includeUnsubscribe = !!settings.public_url;

  const tplData: TemplateData = {
    settings,
    movies,
    shows,
    music,
    topMovies,
    topTV,
    topUsers,
    stats,
    upcomingMovies,
    upcomingShows,
    upcomingWindowDays,
    superlatives,
    flex,
    funStat,
    accentOverride: season?.accent,
    seasonalEmoji: season?.emoji,
    generatedDate,
    logoSrc,
    includeUnsubscribe
  };

  const mjml = buildMjml(tplData);
  // mjml@4 is synchronous despite the published @types claiming a Promise
  const result = mjml2html(mjml, { validationLevel: 'soft' }) as unknown as {
    html: string;
    errors?: { formattedMessage: string }[];
  };
  if (result.errors && result.errors.length > 0) {
    for (const e of result.errors) console.warn('MJML warning:', e.formattedMessage);
  }

  const subject = (settings.newsletter_subject || 'New on Plex').replace(/\{\{date\}\}/g, generatedDate);
  const text = buildPlainText(tplData);

  return { subject, html: result.html, text, attachments };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Build the small metadata chips shown under a movie title — rating, runtime,
 * content rating, and resolution — from whatever fields Tautulli returned.
 * Anything missing is simply skipped, so the line gracefully shrinks.
 */
function buildItemMeta(m: RecentlyAddedItem): string[] | undefined {
  const parts: string[] = [];
  const rating = (m.rating || '').toString().trim();
  if (rating && Number(rating) > 0) parts.push(`★ ${rating}`);
  const runtime = formatRuntimeMs(m.duration);
  if (runtime) parts.push(runtime);
  const contentRating = (m.content_rating || '').trim();
  if (contentRating) parts.push(contentRating);
  const res = normalizeResolution(m.video_resolution);
  if (res) parts.push(res);
  return parts.length > 0 ? parts : undefined;
}

/** Tautulli reports media duration in milliseconds — render it as "2h 16m". */
function formatRuntimeMs(raw: string | undefined): string {
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 60_000) return '';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (h && min) return `${h}h ${min}m`;
  if (h) return `${h}h`;
  return `${min}m`;
}

/** Normalize Tautulli's resolution token ("1080", "4k", "sd") into a label. */
function normalizeResolution(raw: string | undefined): string {
  const r = (raw || '').toString().trim().toLowerCase();
  if (!r) return '';
  if (r === '4k' || r === '2160') return '4K';
  if (r === 'sd') return 'SD';
  if (/^\d+$/.test(r)) return `${r}p`;
  return raw!.trim();
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// --- "Server Wrapped" superlatives ------------------------------------------

function historyUserName(r: HistoryRow): string {
  return (r.friendly_name || r.user || (r.user_id ? `User ${r.user_id}` : 'Someone')).trim();
}

/**
 * Derive playful awards from recent watch history + the users table. Each award
 * is only included when there's a genuine winner, so a quiet week simply yields
 * fewer cards rather than empty ones.
 */
function computeSuperlatives(rows: HistoryRow[], usersTable: UsersTableRow[]): Superlative[] {
  const awards: Superlative[] = [];
  const tsOf = (r: HistoryRow) => Number(r.started || r.date || 0);

  // 🦉 Night Owl — most plays started between midnight and 5am (container TZ).
  const lateByUser = new Map<string, number>();
  for (const r of rows) {
    const ts = tsOf(r);
    if (!ts) continue;
    const h = new Date(ts * 1000).getHours();
    if (h >= 0 && h < 5) {
      const k = historyUserName(r);
      lateByUser.set(k, (lateByUser.get(k) || 0) + 1);
    }
  }
  const nightOwl = topEntry(lateByUser);
  if (nightOwl && nightOwl[1] > 0) {
    awards.push({ emoji: '🦉', title: 'Night Owl', name: nightOwl[0], detail: `${nightOwl[1]} late-night play${nightOwl[1] === 1 ? '' : 's'}` });
  }

  // 🍿 Biggest Binger — most watch time over the window.
  const secByUser = new Map<string, number>();
  for (const r of rows) {
    const sec = Number(r.duration || 0);
    if (sec > 0) {
      const k = historyUserName(r);
      secByUser.set(k, (secByUser.get(k) || 0) + sec);
    }
  }
  const binger = topEntry(secByUser);
  if (binger && binger[1] >= 1800) {
    awards.push({ emoji: '🍿', title: 'Biggest Binger', name: binger[0], detail: `${formatDuration(binger[1])} watched` });
  }

  // 🔁 Broken Record — the single most-replayed title.
  const playsByTitle = new Map<string, number>();
  for (const r of rows) {
    const key = (r.grandparent_title || r.full_title || r.title || '').trim();
    if (key) playsByTitle.set(key, (playsByTitle.get(key) || 0) + 1);
  }
  const replayed = topEntry(playsByTitle);
  if (replayed && replayed[1] >= 2) {
    awards.push({ emoji: '🔁', title: 'Broken Record', name: replayed[0], detail: `${replayed[1]} plays` });
  }

  // ⚡ Speed Demon — most episodes of one series, fastest. (Approximate "finished
  // a series fastest" as the highest episodes-per-day binge of a single show.)
  const binge = new Map<string, { user: string; show: string; count: number; min: number; max: number }>();
  for (const r of rows) {
    if (r.media_type !== 'episode') continue;
    const show = (r.grandparent_title || '').trim();
    if (!show) continue;
    const ts = tsOf(r);
    if (!ts) continue;
    const user = historyUserName(r);
    const key = `${user}|||${show}`;
    const e = binge.get(key);
    if (e) {
      e.count += 1;
      e.min = Math.min(e.min, ts);
      e.max = Math.max(e.max, ts);
    } else {
      binge.set(key, { user, show, count: 1, min: ts, max: ts });
    }
  }
  let speed: { user: string; show: string; count: number; spanDays: number; rate: number } | null = null;
  for (const e of binge.values()) {
    if (e.count < 3) continue;
    const spanDays = Math.max((e.max - e.min) / 86400, 0.5);
    const rate = e.count / spanDays;
    if (!speed || rate > speed.rate || (rate === speed.rate && e.count > speed.count)) {
      speed = { user: e.user, show: e.show, count: e.count, spanDays, rate };
    }
  }
  if (speed) {
    const span = speed.spanDays < 1 ? 'a single day' : `${Math.round(speed.spanDays)} day${Math.round(speed.spanDays) === 1 ? '' : 's'}`;
    awards.push({ emoji: '⚡', title: 'Speed Demon', name: speed.user, detail: `${speed.count} episodes of ${speed.show} in ${span}` });
  }

  // 👻 Ghost — the most-active user who's gone quiet for 30+ days.
  const nowSec = Date.now() / 1000;
  let ghost: { name: string; plays: number; days: number } | null = null;
  for (const u of usersTable) {
    const plays = Number(u.plays || 0);
    const lastSeen = Number(u.last_seen || 0);
    if (plays <= 0 || !lastSeen) continue;
    const days = (nowSec - lastSeen) / 86400;
    if (days < 30) continue;
    if (!ghost || plays > ghost.plays) {
      ghost = { name: (u.friendly_name || u.user || `User ${u.user_id}`).trim(), plays, days };
    }
  }
  if (ghost) {
    awards.push({ emoji: '👻', title: 'Ghost', name: ghost.name, detail: `we miss you — last seen ${Math.round(ghost.days)} days ago` });
  }

  return awards;
}

function topEntry(m: Map<string, number>): [string, number] | null {
  let best: [string, number] | null = null;
  for (const e of m.entries()) if (!best || e[1] > best[1]) best = e;
  return best;
}

// --- Homelab flex bar -------------------------------------------------------

async function computeFlexStats(tautulli: TautulliClient, settings: Settings): Promise<FlexStats> {
  const flex: FlexStats = {};
  const libs = await tautulli.getLibraries();

  let movies = 0;
  let shows = 0;
  let episodes = 0;
  let hasMovie = false;
  let hasShow = false;
  const sizeSections: (string | number)[] = [];
  for (const lib of libs) {
    const type = (lib.section_type || '').toLowerCase();
    if (type === 'movie') {
      hasMovie = true;
      movies += Number(lib.count || 0);
      sizeSections.push(lib.section_id);
    } else if (type === 'show') {
      hasShow = true;
      shows += Number(lib.count || 0);
      episodes += Number(lib.child_count || 0);
      sizeSections.push(lib.section_id);
    }
  }
  if (hasMovie) flex.movies = movies;
  if (hasShow) {
    flex.shows = shows;
    if (episodes > 0) flex.episodes = episodes;
  }

  // Storage — best-effort sum of file sizes across the main libraries.
  try {
    let totalBytes = 0;
    for (const id of sizeSections) {
      totalBytes += await tautulli.getLibraryMediaInfo(id);
    }
    if (totalBytes > 0) {
      const tb = totalBytes / 1024 ** 4;
      flex.storageTb = Math.round(tb * 10) / 10;
    }
  } catch (err) {
    console.warn('Flex bar: storage lookup failed:', err);
  }

  // Items added during the stats window.
  try {
    const recent = await tautulli.getRecentlyAdded(100);
    const cutoff = Date.now() / 1000 - settings.stats_window_days * 86400;
    const added = recent.filter((i) => Number(i.added_at || 0) >= cutoff).length;
    if (added > 0) flex.addedThisPeriod = added;
  } catch (err) {
    console.warn('Flex bar: recently-added count failed:', err);
  }

  // Uptime badge.
  if (settings.uptime_enabled && settings.uptime_kuma_url && settings.uptime_kuma_slug) {
    const pct = await fetchUptimePercent(settings.uptime_kuma_url, settings.uptime_kuma_slug);
    if (pct != null) flex.uptimePct = pct;
  }

  return flex;
}

// --- Seasonal theming -------------------------------------------------------

/** Map the current date to a festive accent + emoji, or null for "no season". */
function seasonalTheme(now: Date): { accent: string; emoji: string } | null {
  const m = now.getMonth() + 1;
  const d = now.getDate();
  if (m === 10) return { accent: '#ff7518', emoji: '🎃' };                 // Halloween (all October)
  if (m === 12 && d <= 26) return { accent: '#e5484d', emoji: '🎄' };       // Winter holidays
  if ((m === 12 && d >= 29) || (m === 1 && d <= 2)) return { accent: '#f5c518', emoji: '🎉' }; // New Year
  if (m === 2 && d <= 14) return { accent: '#ff5d8f', emoji: '💘' };        // Valentine's
  if (m === 3 && d >= 14 && d <= 17) return { accent: '#2eb872', emoji: '☘️' }; // St. Patrick's
  if (m >= 6 && m <= 8) return { accent: '#ff9f1c', emoji: '☀️' };          // Summer
  return null;
}

// --- Absurd unit conversions ------------------------------------------------

function funStatCaption(totalSec: number, now: Date): string {
  const hours = totalSec / 3600;
  const round = (n: number, dp = 0) => {
    const f = 10 ** dp;
    return (Math.round(n * f) / f).toLocaleString();
  };
  const options: string[] = [
    `that's the ISS lapping the planet ${round(hours / 1.533)} times`,
    `enough for ${round(hours / 11.4)} back-to-back marathons of the extended Lord of the Rings trilogy`,
    `roughly ${round(hours / 14)} flights from New York to Tokyo`,
    `a three-toed sloth could've ambled ${round(hours * 0.17, 1)} miles in that time`,
    `about ${round(hours / 3.2)} full screenings of Titanic`,
    `${round(hours * 60 / 90)} sunrises as seen from the Space Station`
  ];
  // Day-of-year keeps it deterministic per send but rotates over time.
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400_000);
  return options[dayOfYear % options.length];
}

function releaseLabel(t: 'digital' | 'physical' | 'cinemas'): string {
  if (t === 'digital') return 'Digital';
  if (t === 'physical') return 'Physical';
  return 'Cinemas';
}

function guessContentType(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function buildPlainText(d: TemplateData): string {
  const lines: string[] = [];
  lines.push(d.settings.brand_name);
  lines.push(d.generatedDate);
  lines.push('');
  if (d.flex && (d.flex.movies != null || d.flex.shows != null || d.flex.storageTb != null || d.flex.addedThisPeriod != null || d.flex.uptimePct != null)) {
    const parts: string[] = [];
    if (d.flex.movies != null) parts.push(`${d.flex.movies} movies`);
    if (d.flex.shows != null) parts.push(`${d.flex.shows} shows`);
    if (d.flex.storageTb != null) parts.push(`${d.flex.storageTb} TB`);
    if (d.flex.addedThisPeriod != null) parts.push(`+${d.flex.addedThisPeriod} added`);
    if (d.flex.uptimePct != null) parts.push(`${d.flex.uptimePct}% uptime`);
    lines.push(`STATE OF THE SERVER: ${parts.join(' · ')}`);
    lines.push('');
  }
  if (d.stats) {
    lines.push(`Last ${d.stats.windowDays} days: ${d.stats.totalPlays} plays, ${d.stats.totalDuration} watched.`);
    lines.push('');
  }
  if (d.funStat) {
    lines.push(`✦ ${d.funStat}`);
    lines.push('');
  }
  if (d.superlatives?.length) {
    lines.push('SERVER WRAPPED');
    for (const s of d.superlatives) lines.push(`${s.emoji} ${s.title}: ${s.name} — ${s.detail}`);
    lines.push('');
  }
  if (d.topMovies?.length) {
    lines.push('MOST WATCHED MOVIES');
    for (const r of d.topMovies) lines.push(`• ${r.label} — ${r.detail}`);
    lines.push('');
  }
  if (d.topTV?.length) {
    lines.push('MOST WATCHED TV');
    for (const r of d.topTV) lines.push(`• ${r.label} — ${r.detail}`);
    lines.push('');
  }
  if (d.topUsers?.length) {
    lines.push('TOP VIEWERS');
    for (const r of d.topUsers) lines.push(`• ${r.label} — ${r.detail}`);
    lines.push('');
  }
  if (d.movies.length) {
    lines.push(`NEW MOVIES (${d.movies.length})`);
    for (const m of d.movies) lines.push(`• ${m.title}${m.year ? ` (${m.year})` : ''}`);
    lines.push('');
  }
  if (d.shows.length) {
    const epCount = d.shows.reduce((n, s) => n + s.episodes.length, 0);
    lines.push(`NEW TV (${epCount})`);
    for (const s of d.shows) {
      lines.push(`• ${s.title}`);
      for (const e of s.episodes) lines.push(`    ${e.label} — ${e.title}`);
    }
    lines.push('');
  }
  if (d.music.length) {
    lines.push(`NEW MUSIC (${d.music.length})`);
    for (const m of d.music) lines.push(`• ${m.title}${m.subtitle ? ` — ${m.subtitle}` : ''}`);
    lines.push('');
  }
  if (d.upcomingMovies && d.upcomingMovies.length > 0) {
    lines.push(`COMING SOON · MOVIES (${d.upcomingMovies.length})`);
    for (const m of d.upcomingMovies) {
      lines.push(`• ${m.dateLabel} — ${m.title}${m.year ? ` (${m.year})` : ''} [${m.releaseLabel}]`);
    }
    lines.push('');
  }
  if (d.upcomingShows && d.upcomingShows.length > 0) {
    const epCount = d.upcomingShows.reduce((n, s) => n + s.episodes.length, 0);
    lines.push(`COMING SOON · TV (${epCount})`);
    for (const s of d.upcomingShows) {
      lines.push(`• ${s.title}`);
      for (const e of s.episodes) lines.push(`    ${e.label} — ${e.title} (${e.dateLabel})`);
    }
    lines.push('');
  }
  if (d.includeUnsubscribe) {
    lines.push('---');
    lines.push(`To unsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}`);
  }
  return lines.join('\n');
}
