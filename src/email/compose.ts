import fs from 'node:fs';
import path from 'node:path';
import mjml2html from 'mjml';
import { TautulliClient, formatDuration } from '../tautulli.js';
import { RadarrClient, SonarrClient, fetchRemoteImage, type UpcomingEpisode } from '../arr.js';
import { fetchUptimePercent } from '../uptime.js';
import { polishNewsletter, type AiCallSource, type AiSummaryItem, type AwardCandidate } from '../ai.js';
import { UPLOADS_DIR } from '../config.js';
import { listRecipients, lookupCloudinaryUrl } from '../db.js';
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
  /** Which path triggered this compose. Recorded against the AI spend caps. */
  aiSource?: AiCallSource;
}

export async function composeNewsletter(settings: Settings, opts: ComposeOptions = {}): Promise<ComposedNewsletter> {
  const tautulli = new TautulliClient(settings.tautulli_url, settings.tautulli_api_key);
  const attachments: Attachment[] = [];
  let cidCounter = 0;
  const nextCid = () => `img${++cidCounter}@pivo`;
  const cloudinary = cloudinaryConfigFromSettings(settings);

  // Built lazily (and once) — only the viewer/award sections need it.
  let userNamesPromise: Promise<UserNameResolver> | undefined;
  const userNames = () => (userNamesPromise ??= buildUserNameResolver(tautulli));

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
          const names = await userNames();
          topUsers = [];
          for (const r of (tu.rows || []).slice(0, 5)) {
            const posterSrc = r.user_thumb ? await resolveImage(r.user_thumb, `user-${r.user_id}`, 80) : undefined;
            topUsers.push({
              label: names(r.user_id, r.user),
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
  // The bench is kept around after picking so the AI pass can re-choose from it.
  let superlatives: Superlative[] | undefined;
  let awardCandidates: AwardCandidate[] = [];
  if (settings.enable_superlatives) {
    try {
      const [rows, usersTable, names] = await Promise.all([
        tautulli.getHistory({ afterDays: settings.stats_window_days, length: 2000 }),
        tautulli.getUsersTable(),
        userNames()
      ]);
      awardCandidates = computeAwardCandidates(rows, usersTable, names);
      // Default lineup. Replaced below if the model is curating.
      const picked = pickAwards(awardCandidates, awardLimit(settings));
      if (picked.length > 0) superlatives = picked;
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

  // --- AI-written copy -------------------------------------------------------
  // Rephrases the award captions and, optionally, writes the intro, the inbox
  // subject/preview line, and the recently-added blurbs. The model is handed
  // only already-computed facts — including, for blurbs, the synopsis Plex
  // already gave us — and `polishNewsletter` swallows its own errors, so this
  // can never block or corrupt a send.
  let aiIntro: string | undefined;
  let aiSubject: string | undefined;
  let aiPreheader: string | undefined;
  if (settings.enable_ai_captions) {
    // Only movies and albums carry a synopsis; TV episodes omit theirs by
    // design. Items keep a reference so the rewrite can be merged back in place.
    const summaryTargets: { id: string; item: RenderedItem }[] = [];
    if (settings.ai_rewrite_summaries) {
      movies.forEach((m, i) => { if (m.summary?.trim()) summaryTargets.push({ id: `m${i + 1}`, item: m }); });
      music.forEach((a, i) => { if (a.summary?.trim()) summaryTargets.push({ id: `a${i + 1}`, item: a }); });
    }
    const items: AiSummaryItem[] = summaryTargets.map(({ id, item }) => ({
      id,
      kind: id.startsWith('m') ? 'movie' : 'album',
      title: item.title,
      year: item.year,
      summary: item.summary!.trim()
    }));

    const polished = await polishNewsletter(
      settings,
      superlatives ?? [],
      {
        windowDays: settings.stats_window_days,
        totalPlays: stats?.totalPlays,
        totalDuration: stats?.totalDuration ?? (totalWatchSec > 0 ? formatDuration(totalWatchSec) : undefined),
        // Omit a category the newsletter doesn't carry, so the model has no
        // zero to write around. `showRecent` is false when upcoming releases
        // replace the recently-added block entirely.
        newMovies: showRecent && settings.include_movies ? movies.length : undefined,
        newShows: showRecent && settings.include_tv ? shows.length : undefined,
        newMusic: showRecent && settings.include_music ? music.length : undefined
      },
      {
        source: opts.aiSource ?? 'send',
        items,
        candidates: awardCandidates,
        awardLimit: awardLimit(settings)
      }
    );
    if (polished.awards.length > 0) superlatives = polished.awards;
    aiIntro = polished.intro;
    aiSubject = polished.subject;
    aiPreheader = polished.preheader;
    // Anything the model skipped or garbled keeps its original Plex synopsis.
    for (const { id, item } of summaryTargets) {
      const rewritten = polished.summaries[id];
      if (rewritten) item.summary = rewritten;
    }
  }

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
    aiIntro,
    aiPreheader,
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

  const subject =
    aiSubject || (settings.newsletter_subject || 'New on Plex').replace(/\{\{date\}\}/g, generatedDate);
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

/** Turns a Tautulli user into the name we actually print in the email. */
type UserNameResolver = (userId?: number, fallback?: string) => string;

/**
 * Build a user_id -> display-name lookup. Prefers the name saved on the matching
 * `recipients` row (joined to the Plex account by email, the same key the
 * recipient importer uses) so the newsletter shows the names you curate rather
 * than raw Plex usernames. Falls back to Tautulli's friendly name, then the
 * username, so an unmatched viewer still reads sensibly.
 */
async function buildUserNameResolver(tautulli: TautulliClient): Promise<UserNameResolver> {
  const byId = new Map<number, string>();
  try {
    const users = await tautulli.getUsers();
    const nameByEmail = new Map<string, string>();
    for (const rec of listRecipients()) {
      const email = (rec.email || '').trim().toLowerCase();
      const name = (rec.name || '').trim();
      if (email && name) nameByEmail.set(email, name);
    }
    for (const u of users) {
      if (u.user_id == null) continue;
      const email = (u.email || '').trim().toLowerCase();
      const name = ((email && nameByEmail.get(email)) || u.friendly_name || u.username || '').trim();
      if (name) byId.set(Number(u.user_id), name);
    }
  } catch (err) {
    // Best-effort: without the map we simply fall back to Tautulli's own names.
    console.warn('Failed to map Plex users to recipients:', err);
  }

  return (userId, fallback) => {
    const mapped = userId == null ? undefined : byId.get(Number(userId));
    return (mapped || (fallback || '').trim() || (userId != null ? `User ${userId}` : 'Someone')).trim();
  };
}

function historyUserName(r: HistoryRow, names: UserNameResolver): string {
  return names(r.user_id, r.friendly_name || r.user);
}

/**
 * Derive award candidates from recent watch history + the users table.
 *
 * This is the *bench*, not the lineup — it computes every award that has a
 * genuine winner this period, which is usually more than an email should show.
 * Picking which ones run is a separate decision (see `pickAwards` and the AI
 * curation path in ai.ts), so that choice can vary week to week while every
 * number here stays code-computed.
 *
 * Each candidate carries a `note` describing what the metric actually measures.
 * That never renders — it exists so a model naming the award knows what it is
 * naming, rather than guessing from a number.
 */
function computeAwardCandidates(
  rows: HistoryRow[],
  usersTable: UsersTableRow[],
  names: UserNameResolver
): AwardCandidate[] {
  const out: AwardCandidate[] = [];
  const tsOf = (r: HistoryRow) => Number(r.started || r.date || 0);
  const hourOf = (r: HistoryRow) => new Date(tsOf(r) * 1000).getHours();
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /** Plays in an hour band, bucketed by user. */
  const byHourBand = (from: number, to: number) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (!tsOf(r)) continue;
      const h = hourOf(r);
      if (h >= from && h < to) m.set(historyUserName(r, names), (m.get(historyUserName(r, names)) || 0) + 1);
    }
    return m;
  };

  // 🦉 Night Owl — plays started between midnight and 5am (container TZ).
  const nightOwl = topEntry(byHourBand(0, 5));
  if (nightOwl && nightOwl[1] > 0) {
    out.push({
      id: 'night_owl', emoji: '🦉', title: 'Night Owl', name: nightOwl[0],
      detail: `${plural(nightOwl[1], 'late-night play')}`,
      note: 'most plays started between midnight and 5am'
    });
  }

  // 🐓 Early Bird — the 5am-9am crowd.
  const earlyBird = topEntry(byHourBand(5, 9));
  if (earlyBird && earlyBird[1] >= 2) {
    out.push({
      id: 'early_bird', emoji: '🐓', title: 'Early Bird', name: earlyBird[0],
      detail: `${plural(earlyBird[1], 'play')} before 9am`,
      note: 'most plays started between 5am and 9am'
    });
  }

  // 📺 Prime Time — reliably parked on the sofa at 8pm.
  const primeTime = topEntry(byHourBand(20, 24));
  if (primeTime && primeTime[1] >= 3) {
    out.push({
      id: 'prime_time', emoji: '📺', title: 'Prime Time', name: primeTime[0],
      detail: `${plural(primeTime[1], 'play')} in the 8-to-midnight slot`,
      note: 'most plays started between 8pm and midnight — the classic evening viewer'
    });
  }

  // 🍿 Biggest Binger — most watch time over the window.
  const secByUser = new Map<string, number>();
  for (const r of rows) {
    const sec = Number(r.duration || 0);
    if (sec > 0) secByUser.set(historyUserName(r, names), (secByUser.get(historyUserName(r, names)) || 0) + sec);
  }
  const binger = topEntry(secByUser);
  if (binger && binger[1] >= 1800) {
    out.push({
      id: 'biggest_binger', emoji: '🍿', title: 'Biggest Binger', name: binger[0],
      detail: `${formatDuration(binger[1])} watched`,
      note: 'most total watch time this period'
    });
  }

  // 🔁 Broken Record — the single most-replayed title.
  const playsByTitle = new Map<string, number>();
  for (const r of rows) {
    const key = (r.grandparent_title || r.full_title || r.title || '').trim();
    if (key) playsByTitle.set(key, (playsByTitle.get(key) || 0) + 1);
  }
  const replayed = topEntry(playsByTitle);
  if (replayed && replayed[1] >= 2) {
    out.push({
      id: 'broken_record', emoji: '🔁', title: 'Broken Record', name: replayed[0],
      detail: `${plural(replayed[1], 'play')}`,
      note: 'the single most-replayed title on the server — the winner is a title, not a person'
    });
  }

  // ⚡ Speed Demon — highest episodes-per-day burn through one series.
  const binge = new Map<string, { user: string; show: string; count: number; min: number; max: number }>();
  for (const r of rows) {
    if (r.media_type !== 'episode') continue;
    const show = (r.grandparent_title || '').trim();
    const ts = tsOf(r);
    if (!show || !ts) continue;
    const user = historyUserName(r, names);
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
    const span = speed.spanDays < 1 ? 'a single day' : plural(Math.round(speed.spanDays), 'day');
    out.push({
      id: 'speed_demon', emoji: '⚡', title: 'Speed Demon', name: speed.user,
      detail: `${speed.count} episodes of ${speed.show} in ${span}`,
      note: 'tore through one series faster than anyone else'
    });
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
    if (!ghost || plays > ghost.plays) ghost = { name: names(u.user_id, u.friendly_name || u.user), plays, days };
  }
  if (ghost) {
    out.push({
      id: 'ghost', emoji: '👻', title: 'Ghost', name: ghost.name,
      detail: `last seen ${plural(Math.round(ghost.days), 'day')} ago`,
      note: 'a former regular who has not watched anything in over a month — affectionate, not scolding'
    });
  }

  // --- Completion habits -----------------------------------------------------
  // Tautulli reports watched_status as 0, 0.5 or 1; 1 means finished.
  const startedBy = new Map<string, number>();
  const finishedBy = new Map<string, number>();
  for (const r of rows) {
    const u = historyUserName(r, names);
    startedBy.set(u, (startedBy.get(u) || 0) + 1);
    if (Number(r.watched_status || 0) >= 1) finishedBy.set(u, (finishedBy.get(u) || 0) + 1);
  }

  // 🥱 One and Done — starts plenty, finishes little.
  let quitter: { user: string; abandoned: number; started: number } | null = null;
  for (const [u, started] of startedBy) {
    const abandoned = started - (finishedBy.get(u) || 0);
    if (started < 4 || abandoned < 3) continue;
    if (!quitter || abandoned > quitter.abandoned) quitter = { user: u, abandoned, started };
  }
  if (quitter) {
    out.push({
      id: 'one_and_done', emoji: '🥱', title: 'One and Done', name: quitter.user,
      detail: `${quitter.abandoned} of ${quitter.started} left unfinished`,
      note: 'starts things and wanders off — the serial abandoner'
    });
  }

  // ✅ The Completionist — finishes what they start.
  let finisher: { user: string; finished: number; started: number } | null = null;
  for (const [u, started] of startedBy) {
    const finished = finishedBy.get(u) || 0;
    if (started < 4 || finished / started < 0.9) continue;
    if (!finisher || finished > finisher.finished) finisher = { user: u, finished, started };
  }
  if (finisher) {
    out.push({
      id: 'completionist', emoji: '✅', title: 'The Completionist', name: finisher.user,
      detail: `finished ${finisher.finished} of ${finisher.started}`,
      note: 'finishes almost everything they start — the opposite of a quitter'
    });
  }

  // 🎉 Weekend Warrior — watching is concentrated on Saturday and Sunday.
  const weekendBy = new Map<string, number>();
  for (const r of rows) {
    const ts = tsOf(r);
    if (!ts) continue;
    const day = new Date(ts * 1000).getDay();
    if (day === 0 || day === 6) weekendBy.set(historyUserName(r, names), (weekendBy.get(historyUserName(r, names)) || 0) + 1);
  }
  let weekender: { user: string; weekend: number; total: number } | null = null;
  for (const [u, weekend] of weekendBy) {
    const total = startedBy.get(u) || weekend;
    if (weekend < 3 || weekend / total < 0.6) continue;
    if (!weekender || weekend > weekender.weekend) weekender = { user: u, weekend, total };
  }
  if (weekender) {
    out.push({
      id: 'weekend_warrior', emoji: '🎉', title: 'Weekend Warrior', name: weekender.user,
      detail: `${weekender.weekend} of ${weekender.total} plays on a Saturday or Sunday`,
      note: 'barely touches the server midweek, then makes up for it at the weekend'
    });
  }

  // 🎚️ Channel Surfer — samples a lot of different things.
  const titlesBy = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = (r.grandparent_title || r.full_title || r.title || '').trim();
    if (!key) continue;
    const u = historyUserName(r, names);
    if (!titlesBy.has(u)) titlesBy.set(u, new Set());
    titlesBy.get(u)!.add(key);
  }
  let surfer: { user: string; count: number } | null = null;
  for (const [u, set] of titlesBy) {
    if (set.size < 6) continue;
    if (!surfer || set.size > surfer.count) surfer = { user: u, count: set.size };
  }
  if (surfer) {
    out.push({
      id: 'channel_surfer', emoji: '🎚️', title: 'Channel Surfer', name: surfer.user,
      detail: `${surfer.count} different titles`,
      note: 'sampled more distinct titles than anyone — never settles on one thing'
    });
  }

  // 🪑 Longest Sitting — the single biggest unbroken session.
  let sitting: { user: string; sec: number; title: string } | null = null;
  for (const r of rows) {
    const start = Number(r.started || 0);
    const stop = Number(r.stopped || 0);
    if (!start || !stop || stop <= start) continue;
    const sec = stop - start;
    if (sec < 7200) continue;
    if (!sitting || sec > sitting.sec) {
      sitting = { user: historyUserName(r, names), sec, title: (r.grandparent_title || r.full_title || r.title || '').trim() };
    }
  }
  if (sitting) {
    out.push({
      id: 'longest_sitting', emoji: '🪑', title: 'Longest Sitting', name: sitting.user,
      detail: `${formatDuration(sitting.sec)} without getting up${sitting.title ? ` (${sitting.title})` : ''}`,
      note: 'the single longest unbroken session of the period'
    });
  }

  // 🕰️ Time Traveler — dug up the oldest release in the library.
  let oldest: { user: string; year: number; title: string } | null = null;
  for (const r of rows) {
    const year = Number(r.year || 0);
    if (!year || year > 1990) continue;
    if (!oldest || year < oldest.year) {
      oldest = { user: historyUserName(r, names), year, title: (r.grandparent_title || r.full_title || r.title || '').trim() };
    }
  }
  if (oldest) {
    out.push({
      id: 'time_traveler', emoji: '🕰️', title: 'Time Traveler', name: oldest.user,
      detail: `watched ${oldest.title || 'something'} from ${oldest.year}`,
      note: 'watched the oldest release of anyone this period'
    });
  }

  // 🛋️ Marathon Night — most watch time crammed into one calendar day.
  const dayKey = (ts: number) => new Date(ts * 1000).toDateString();
  const perUserDay = new Map<string, number>();
  for (const r of rows) {
    const ts = tsOf(r);
    const sec = Number(r.duration || 0);
    if (!ts || sec <= 0) continue;
    const k = `${historyUserName(r, names)}|||${dayKey(ts)}`;
    perUserDay.set(k, (perUserDay.get(k) || 0) + sec);
  }
  const marathon = topEntry(perUserDay);
  if (marathon && marathon[1] >= 10800) {
    out.push({
      id: 'marathon_night', emoji: '🛋️', title: 'Marathon Night', name: marathon[0].split('|||')[0],
      detail: `${formatDuration(marathon[1])} in a single day`,
      note: 'the most watch time anyone packed into one calendar day'
    });
  }

  // 🎬 Double Feature — most movies in one day.
  const moviesPerDay = new Map<string, number>();
  for (const r of rows) {
    if (r.media_type !== 'movie') continue;
    const ts = tsOf(r);
    if (!ts) continue;
    const k = `${historyUserName(r, names)}|||${dayKey(ts)}`;
    moviesPerDay.set(k, (moviesPerDay.get(k) || 0) + 1);
  }
  const doubleFeature = topEntry(moviesPerDay);
  if (doubleFeature && doubleFeature[1] >= 2) {
    out.push({
      id: 'double_feature', emoji: '🎬', title: 'Double Feature', name: doubleFeature[0].split('|||')[0],
      detail: `${doubleFeature[1]} films in one day`,
      note: 'watched the most movies back-to-back in a single day'
    });
  }

  // 🐁 The Lurker — present, but only just. Needs a crowd to be funny.
  if (startedBy.size >= 3) {
    let lurker: { user: string; plays: number } | null = null;
    for (const [u, plays] of startedBy) {
      if (plays < 1) continue;
      if (!lurker || plays < lurker.plays) lurker = { user: u, plays };
    }
    if (lurker && lurker.plays <= 2) {
      out.push({
        id: 'the_lurker', emoji: '🐁', title: 'The Lurker', name: lurker.user,
        detail: `${plural(lurker.plays, 'play')} all period`,
        note: 'technically used the server, and that is about all you can say for them'
      });
    }
  }

  return out;
}

/**
 * Fallback lineup when the model isn't curating. Ordered by how well each award
 * reads to someone who wasn't watching the numbers — the crowd-pleasers first,
 * the niche ones only if there's room.
 */
const AWARD_PRIORITY = [
  'biggest_binger', 'night_owl', 'speed_demon', 'broken_record', 'marathon_night',
  'one_and_done', 'weekend_warrior', 'double_feature', 'longest_sitting', 'completionist',
  'channel_surfer', 'prime_time', 'early_bird', 'time_traveler', 'ghost', 'the_lurker'
];

/** How many awards to show. Clamped — past about eight the section stops reading as a highlight reel. */
function awardLimit(settings: Settings): number {
  const n = Number(settings.superlative_count);
  if (!Number.isFinite(n) || n <= 0) return 4;
  return Math.min(Math.round(n), 8);
}

function pickAwards(candidates: AwardCandidate[], limit: number): AwardCandidate[] {
  const rank = (a: AwardCandidate) => {
    const i = AWARD_PRIORITY.indexOf(a.id);
    return i === -1 ? AWARD_PRIORITY.length : i;
  };
  return [...candidates].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
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
  if (d.aiIntro) {
    lines.push(d.aiIntro);
    lines.push('');
  }
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
