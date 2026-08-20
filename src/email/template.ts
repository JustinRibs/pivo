import type { Settings } from '../types.js';
import { formatDuration } from '../tautulli.js';

export interface TemplateData {
  settings: Settings;
  movies: RenderedItem[];
  shows: RenderedShow[];
  music: RenderedItem[];
  topMovies?: RenderedStatRow[];
  topTV?: RenderedStatRow[];
  topUsers?: RenderedStatRow[];
  stats?: { totalPlays: number; totalDuration: string; windowDays: number };
  upcomingMovies?: RenderedUpcomingMovie[];
  upcomingShows?: RenderedUpcomingShow[];
  upcomingWindowDays?: number;
  /** "Server Wrapped" award winners. */
  superlatives?: Superlative[];
  /** Homelab flex bar metrics. */
  flex?: FlexStats;
  /** Playful unit-conversion caption shown under the watch-time stats. */
  funStat?: string;
  /** AI-written opener, rendered under the header text. */
  aiIntro?: string;
  /** AI-written inbox preview text, shown next to the subject line. */
  aiPreheader?: string;
  /** Seasonal accent override (e.g. spooky orange in October). Falls back to brand_accent. */
  accentOverride?: string;
  /** Seasonal emoji shown in the date eyebrow. */
  seasonalEmoji?: string;
  generatedDate: string;
  /**
   * Final `src=` value for the brand logo. Either a `cid:…` reference (when
   * attached inline) or a public https URL (when hosted on Cloudinary).
   */
  logoSrc?: string;
  /** When true, the footer renders an Unsubscribe link with the {{UNSUBSCRIBE_URL}} placeholder. */
  includeUnsubscribe?: boolean;
}

/** Placeholder string the sender substitutes per-recipient. */
export const UNSUBSCRIBE_PLACEHOLDER = '{{UNSUBSCRIBE_URL}}';

/** Canonical order + the full set of reorderable body-section keys. */
export const DEFAULT_SECTION_ORDER = [
  'flex_bar', 'stats', 'superlatives', 'top_movies', 'top_tv', 'top_users',
  'recent_movies', 'recent_tv', 'recent_music',
  'upcoming_movies', 'upcoming_shows'
] as const;

/**
 * Parse the persisted `section_order` JSON, drop anything unknown, then append
 * any known keys the saved order is missing (e.g. after an upgrade adds one).
 */
function resolveSectionOrder(raw: string | undefined): string[] {
  const known = new Set<string>(DEFAULT_SECTION_ORDER);
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const order = Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string' && known.has(k)) : [];
  // Insert any missing known keys at their canonical position (rather than the
  // end), so sections added in an upgrade land where they were designed to sit.
  DEFAULT_SECTION_ORDER.forEach((k, i) => {
    if (!order.includes(k)) order.splice(Math.min(i, order.length), 0, k);
  });
  return order;
}

/**
 * `posterSrc` is a ready-to-render `src=` value: either `cid:img1@…` (inline
 * attachment) or `https://…` (when Cloudinary hosting is enabled). The
 * template emits it as-is — see compose.ts for how it's chosen.
 */
export interface RenderedItem {
  title: string;
  subtitle?: string;
  summary?: string;
  posterSrc?: string;
  badge?: string;
  year?: string;
  /** Small metadata chips under the title, e.g. ["★ 8.4", "2h 16m", "PG-13", "1080p"]. */
  metaParts?: string[];
}

export interface RenderedShow {
  title: string;
  posterSrc?: string;
  episodes: { label: string; title: string; summary?: string }[];
}

export interface RenderedStatRow {
  label: string;
  detail: string;
  posterSrc?: string;
}

export interface RenderedUpcomingMovie {
  title: string;
  year?: string;
  overview?: string;
  posterSrc?: string;
  /** Human label like "Fri, May 23". */
  dateLabel: string;
  /** "Digital", "Physical", or "Cinemas". */
  releaseLabel: string;
}

export interface RenderedUpcomingShow {
  title: string;
  posterSrc?: string;
  episodes: { label: string; title: string; dateLabel: string }[];
}

export interface Superlative {
  /** Stable metric key (e.g. `night_owl`). Survives renaming, so AI-written
   *  titles can be matched back to the fact they belong to. */
  id?: string;
  emoji: string;
  /** Award name, e.g. "Night Owl". May be rewritten by the model. */
  title: string;
  /** Winner — a user or a title. */
  name: string;
  /** Supporting detail, e.g. "23 late-night plays". */
  detail: string;
}

export interface FlexStats {
  movies?: number;
  shows?: number;
  episodes?: number;
  storageTb?: number;
  addedThisPeriod?: number;
  uptimePct?: number | null;
}

const COLORS = {
  bg: '#0e0e10',
  text: '#f5f5f7',
  textSoft: '#d4d4d8',
  muted: '#a1a1aa',
  divider: '#222226',
  hairline: '#1c1c20'
};

function esc(s: string | undefined | null): string {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortSummary(s: string | undefined, max = 110): string {
  if (!s) return '';
  const trimmed = s.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

/** Mix a hex color toward white by `amt` (0–1). Used to build accent gradients. */
function lightenHex(hex: string, amt = 0.35): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return hex || '#e5a00d';
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) + (255 - ((n >> 16) & 255)) * amt);
  const g = Math.round(((n >> 8) & 255) + (255 - ((n >> 8) & 255)) * amt);
  const b = Math.round((n & 255) + (255 - (n & 255)) * amt);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * A 1px section rule that fades from the accent on the left into the divider
 * color. Solid `divider` is set first so Outlook (no gradient support) still
 * shows a clean hairline.
 */
function accentRule(accent: string): string {
  const light = lightenHex(accent, 0.2);
  return `<mj-raw>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr><td style="height:1px; line-height:1px; font-size:0; background:${COLORS.divider}; background:linear-gradient(90deg, ${accent}, ${light} 18%, ${COLORS.divider} 60%);">&nbsp;</td></tr>
    </table>
  </mj-raw>`;
}

export function buildMjml(data: TemplateData): string {
  const { settings, movies, shows, music, topMovies, topTV, topUsers, stats, upcomingMovies, upcomingShows, upcomingWindowDays, superlatives, flex, funStat, aiIntro, aiPreheader, accentOverride, seasonalEmoji, generatedDate, logoSrc, includeUnsubscribe } = data;
  const accent = accentOverride || settings.brand_accent || '#e5a00d';
  const accentLight = lightenHex(accent, 0.4);
  const brandName = esc(settings.brand_name || 'Pivo');
  const headerHtml = settings.brand_header_html || '';
  const footerHtml = settings.brand_footer_html || '';
  const showSummaries = !!settings.show_summaries;
  const { bg, text, muted } = COLORS;

  const logoBlock = logoSrc
    ? `<mj-image src="${esc(logoSrc)}" alt="${brandName}" width="140px" align="center" padding="0" />`
    : `<mj-text align="center" font-size="24px" font-weight="700" color="${text}" letter-spacing="-0.02em" padding="0">${brandName}</mj-text>`;

  // Per-recipient greeting line. {{first_name}} etc. are substituted downstream
  // by applySubstitutions, so the placeholder is emitted verbatim here.
  const greetingBlock =
    settings.greeting_enabled && (settings.greeting_text || '').trim()
      ? `<mj-text align="center" color="${text}" font-size="16px" font-weight="600" letter-spacing="-0.01em" padding="22px 16px 0 16px">${esc(settings.greeting_text)}</mj-text>`
      : '';

  // Brand accent gradient bar — solid accent set first for Outlook fallback.
  const accentBar = `<mj-raw>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
      <div style="width:56px; height:3px; border-radius:3px; background:${accent}; background:linear-gradient(90deg, ${accent}, ${accentLight});">&nbsp;</div>
    </td></tr></table>
  </mj-raw>`;

  const headerSection = `
    <mj-section background-color="${bg}" padding="44px 32px 0 32px">
      <mj-column>
        <mj-text align="center" color="${accent}" font-size="10.5px" letter-spacing="2.5px" font-weight="700" text-transform="uppercase" padding="0 0 24px 0">${seasonalEmoji ? `${seasonalEmoji} ` : ''}${esc(generatedDate)}</mj-text>
        ${logoBlock}
        ${greetingBlock}
        ${
          headerHtml
            ? `<mj-text align="center" color="${muted}" font-size="14px" line-height="1.6" padding="20px 16px 0 16px">${headerHtml}</mj-text>`
            : ''
        }${
          aiIntro
            ? `<mj-text align="center" color="${muted}" font-size="14px" line-height="1.7" font-style="italic" padding="${headerHtml ? '12px' : '20px'} 16px 0 16px">${esc(aiIntro)}</mj-text>`
            : ''
        }
      </mj-column>
    </mj-section>
    <mj-section background-color="${bg}" padding="32px 32px 0 32px">
      <mj-column>
        ${accentBar}
      </mj-column>
    </mj-section>
  `;

  const movieSections = movies.length > 0 ? renderItemList('New Movies', movies, accent, { showSummaries }) : '';
  const showSections = shows.length > 0 ? renderShows(shows, accent) : '';
  const musicSections = music.length > 0 ? renderItemList('New Music', music, accent, { showSummaries }) : '';

  const topMoviesSection =
    topMovies && topMovies.length > 0 ? renderStatBlock('Most Watched Movies', topMovies, accent) : '';
  const topTVSection = topTV && topTV.length > 0 ? renderStatBlock('Most Watched TV', topTV, accent) : '';
  const topUsersSection =
    topUsers && topUsers.length > 0 ? renderStatBlock('Top Viewers', topUsers, accent) : '';
  // The fun caption travels with the stats slot (it riffs on the watch-time total).
  const statsSection =
    (stats ? renderStats(stats, accent) : '') + (funStat ? renderFunCaption(funStat, accent, !stats) : '');
  const superlativesSection =
    superlatives && superlatives.length > 0 ? renderSuperlatives(superlatives, accent) : '';
  const flexBarSection = flex && hasFlexStats(flex) ? renderFlexBar(flex, accent) : '';

  const upcomingMoviesSection =
    upcomingMovies && upcomingMovies.length > 0
      ? renderUpcomingMovies(upcomingMovies, accent, upcomingWindowDays || 7, !!settings.show_summaries)
      : '';
  const upcomingShowsSection =
    upcomingShows && upcomingShows.length > 0
      ? renderUpcomingShows(upcomingShows, accent, upcomingWindowDays || 7)
      : '';

  const nothingNew = movies.length === 0 && shows.length === 0 && music.length === 0;
  const emptyState = nothingNew
    ? `
      <mj-section background-color="${bg}" padding="48px 32px">
        <mj-column>
          <mj-text align="center" color="${muted}" font-size="14px" line-height="1.6">Nothing new was added this period — but the catalog is still here whenever you are.</mj-text>
        </mj-column>
      </mj-section>
    `
    : '';

  // "Request a movie or show" CTA (Overseerr / Jellyseerr). Rendered just above
  // the footer, so it sits at the natural call-to-action spot.
  const requestSection =
    settings.request_enabled && (settings.request_url || '').trim()
      ? `<mj-section background-color="${bg}" padding="44px 32px 0 32px">
           <mj-column>
             <mj-button href="${esc(settings.request_url)}" background-color="${accent}" color="#0a0a0c" font-size="14px" font-weight="700" inner-padding="13px 28px" border-radius="6px" align="center" css-class="request-btn">${esc(settings.request_label || 'Request a movie or show')}</mj-button>
           </mj-column>
         </mj-section>`
      : '';

  // Reorderable body sections, keyed for the drag-to-reorder UI.
  const sectionHtml: Record<string, string> = {
    flex_bar: flexBarSection,
    superlatives: superlativesSection,
    stats: statsSection,
    top_movies: topMoviesSection,
    top_tv: topTVSection,
    top_users: topUsersSection,
    recent_movies: movieSections,
    recent_tv: showSections,
    recent_music: musicSections,
    upcoming_movies: upcomingMoviesSection,
    upcoming_shows: upcomingShowsSection
  };
  const order = resolveSectionOrder(settings.section_order);
  const recentKeys = new Set(['recent_movies', 'recent_tv', 'recent_music']);
  const orderedBody: string[] = [];
  let emptyStatePlaced = false;
  for (const key of order) {
    // The "nothing new" message takes the slot of the first recent section.
    if (!emptyStatePlaced && nothingNew && recentKeys.has(key)) {
      orderedBody.push(emptyState);
      emptyStatePlaced = true;
    }
    orderedBody.push(sectionHtml[key] || '');
  }
  const bodySections = orderedBody.join('\n');

  const unsubscribeLink = includeUnsubscribe
    ? `<mj-text align="center" color="${muted}" font-size="11px" padding="6px 0 0 0">
         <a href="${UNSUBSCRIBE_PLACEHOLDER}" style="color:${muted}; text-decoration:underline;">Unsubscribe</a>
       </mj-text>`
    : '';

  const footerSection = `
    <mj-section background-color="${bg}" padding="48px 32px 32px 32px">
      <mj-column>
        <mj-divider border-color="${COLORS.divider}" border-width="1px" padding="0 0 24px 0" />
        ${
          footerHtml
            ? `<mj-text align="center" color="${muted}" font-size="12px" line-height="1.7">${footerHtml}</mj-text>`
            : ''
        }
        <mj-text align="center" color="${muted}" font-size="11px" letter-spacing="0.3px" padding="14px 0 0 0">${brandName}</mj-text>
        ${unsubscribeLink}
      </mj-column>
    </mj-section>
  `;

  return `<mjml>
  <mj-head>
    <mj-title>${brandName}</mj-title>
    <mj-preview>${aiPreheader ? esc(aiPreheader) : `${brandName} — recently added on Plex`}</mj-preview>
    <mj-font name="Inter" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
    <mj-attributes>
      <mj-all font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" />
      <mj-text color="${text}" font-size="14px" line-height="1.6" />
      <mj-section background-color="${bg}" />
    </mj-attributes>
    <mj-style>
      a, a:visited { color: ${accent} !important; text-decoration: none; }
      /* The button has a solid accent fill, so force readable dark text and
         override the global accent link color (which would otherwise make the
         label the same color as the fill). */
      .request-btn a, .request-btn a:visited { color: #0a0a0c !important; text-decoration: none !important; }
      img { max-width: 100%; height: auto; display: block; }
      body, table, td, div, p, a, span, h1, h2, h3, h4 {
        font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
        font-feature-settings: 'cv02', 'cv11', 'ss01';
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      .stat-number { font-variant-numeric: tabular-nums; }
      .stat-rank { font-variant-numeric: tabular-nums; }
      .poster img {
        border-radius: 6px !important;
        box-shadow: 0 3px 12px rgba(0,0,0,0.45);
        transition: box-shadow 0.2s ease, transform 0.2s ease;
      }
      .poster img:hover {
        box-shadow: 0 8px 22px rgba(0,0,0,0.6);
        transform: translateY(-2px);
      }
      @media only screen and (max-width:480px) {
        .item-poster img { width: 80px !important; max-width: 80px !important; }
        .item-poster { padding-right: 14px !important; }
        .show-episodes-table td { font-size: 13px !important; }
      }
    </mj-style>
  </mj-head>
  <mj-body background-color="${bg}" width="640px">
    ${headerSection}
    ${bodySections}
    ${requestSection}
    ${footerSection}
  </mj-body>
</mjml>`;
}

function sectionHeader(title: string, count: number, accent: string): string {
  const { muted } = COLORS;
  return `
    <mj-section background-color="${COLORS.bg}" padding="40px 32px 0 32px">
      <mj-column>
        <mj-text font-size="10.5px" letter-spacing="2.5px" font-weight="700" text-transform="uppercase" color="${muted}" padding="0 0 14px 0">
          ${esc(title)} <span style="color:${accent};">·</span> ${count}
        </mj-text>
        ${accentRule(accent)}
      </mj-column>
    </mj-section>
  `;
}

function itemRow(opts: {
  title: string;
  subtitle?: string;
  meta?: string;
  summary?: string;
  posterSrc?: string;
  isLast?: boolean;
  posterDisplayPx?: number;
  metaParts?: string[];
  accent?: string;
}): string {
  const { text, textSoft, muted, divider } = COLORS;
  const { title, subtitle, meta, summary, posterSrc, isLast, posterDisplayPx = 100, metaParts, accent = '#e5a00d' } = opts;

  const posterCol = posterSrc
    ? `<mj-column width="${posterDisplayPx + 24}px" padding="0" vertical-align="top" css-class="item-poster">
         <mj-image src="${esc(posterSrc)}" alt="${esc(title)}" width="${posterDisplayPx}px" padding="0" align="left" border-radius="6px" css-class="poster" />
       </mj-column>`
    : '';
  const contentWidth = posterSrc ? `${640 - 64 - posterDisplayPx - 24}px` : '100%';

  const subtitleLine = subtitle
    ? `<mj-text color="${muted}" font-size="11px" font-weight="600" letter-spacing="1.4px" text-transform="uppercase" padding="0 0 6px 0">${esc(subtitle)}</mj-text>`
    : '';
  const titleLine = `<mj-text color="${text}" font-size="17px" font-weight="700" line-height="1.3" letter-spacing="-0.01em" padding="0">${esc(title)}${meta ? ` <span style="color:${muted}; font-weight:500;">${esc(meta)}</span>` : ''}</mj-text>`;
  const metaLine =
    metaParts && metaParts.length > 0
      ? `<mj-text color="${muted}" font-size="12px" font-weight="500" letter-spacing="0.2px" padding="7px 0 0 0">${metaParts
          .map((p) => esc(p))
          .join(` <span style="color:${accent};">·</span> `)}</mj-text>`
      : '';
  const summaryLine = summary
    ? `<mj-text color="${textSoft}" font-size="13.5px" line-height="1.6" padding="8px 0 0 0">${esc(shortSummary(summary, 110))}</mj-text>`
    : '';

  const dividerSection = !isLast
    ? `<mj-section background-color="${COLORS.bg}" padding="22px 32px 0 32px">
         <mj-column>
           <mj-divider border-color="${divider}" border-width="1px" padding="0" />
         </mj-column>
       </mj-section>`
    : '';

  return `
    <mj-section background-color="${COLORS.bg}" padding="22px 32px 0 32px">
      ${posterCol}
      <mj-column width="${contentWidth}" padding="0" vertical-align="top">
        ${subtitleLine}
        ${titleLine}
        ${metaLine}
        ${summaryLine}
      </mj-column>
    </mj-section>
    ${dividerSection}
  `;
}

function renderItemList(heading: string, items: RenderedItem[], accent: string, opts: { showSummaries: boolean }): string {
  const blocks: string[] = [sectionHeader(heading, items.length, accent)];
  items.forEach((item, i) => {
    blocks.push(
      itemRow({
        title: item.title,
        meta: item.year,
        subtitle: item.subtitle,
        summary: opts.showSummaries ? item.summary : undefined,
        posterSrc: item.posterSrc,
        metaParts: item.metaParts,
        accent,
        isLast: i === items.length - 1
      })
    );
  });
  return blocks.join('\n');
}

function renderShows(shows: RenderedShow[], accent: string): string {
  const epCount = shows.reduce((n, s) => n + s.episodes.length, 0);
  const blocks: string[] = [sectionHeader('New TV', epCount, accent)];
  const { text, textSoft, muted, divider } = COLORS;

  shows.forEach((show, showIdx) => {
    const isLastShow = showIdx === shows.length - 1;

    // Compact episode list — small label in accent, title in muted body color, no summaries.
    const episodeRows = show.episodes
      .map((ep, i) => {
        const top = i === 0 ? '' : `border-top:1px solid ${divider};`;
        return `
          <tr>
            <td style="padding:8px 14px 8px 0; vertical-align:top; ${top} width:64px; white-space:nowrap;">
              <span style="color:${accent}; font-size:11px; font-weight:700; letter-spacing:1px; font-family:Inter,sans-serif;">${esc(ep.label)}</span>
            </td>
            <td style="padding:8px 0; vertical-align:top; ${top}">
              <span style="color:${textSoft}; font-size:13.5px; font-weight:500; line-height:1.5; font-family:Inter,sans-serif;">${esc(ep.title)}</span>
            </td>
          </tr>
        `;
      })
      .join('');

    const posterCol = show.posterSrc
      ? `<mj-column width="124px" padding="0" vertical-align="top" css-class="item-poster">
           <mj-image src="${esc(show.posterSrc)}" alt="${esc(show.title)}" width="100px" padding="0" align="left" border-radius="6px" css-class="poster" />
         </mj-column>`
      : '';
    const contentWidth = show.posterSrc ? '452px' : '100%';

    blocks.push(`
      <mj-section background-color="${COLORS.bg}" padding="22px 32px 0 32px">
        ${posterCol}
        <mj-column width="${contentWidth}" padding="0" vertical-align="top">
          <mj-text color="${muted}" font-size="11px" font-weight="600" letter-spacing="1.4px" text-transform="uppercase" padding="0 0 6px 0">${esc(show.episodes.length === 1 ? '1 episode' : `${show.episodes.length} episodes`)}</mj-text>
          <mj-text color="${text}" font-size="17px" font-weight="700" line-height="1.3" letter-spacing="-0.01em" padding="0 0 10px 0">${esc(show.title)}</mj-text>
          <mj-raw>
            <table role="presentation" class="show-episodes-table" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
              ${episodeRows}
            </table>
          </mj-raw>
        </mj-column>
      </mj-section>
      ${
        !isLastShow
          ? `<mj-section background-color="${COLORS.bg}" padding="22px 32px 0 32px">
               <mj-column>
                 <mj-divider border-color="${divider}" border-width="1px" padding="0" />
               </mj-column>
             </mj-section>`
          : ''
      }
    `);
  });

  return blocks.join('\n');
}

function renderStatBlock(title: string, rows: RenderedStatRow[], accent: string): string {
  const { text, muted, divider } = COLORS;
  const items = rows
    .slice(0, 5)
    .map(
      (r, i) => `
        <tr>
          <td style="padding:12px 0; vertical-align:middle; ${i === 0 ? '' : `border-top:1px solid ${divider};`}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="32" style="color:${muted}; font-size:13px; font-weight:600; vertical-align:middle; width:32px; font-variant-numeric:tabular-nums;">${i + 1}</td>
                ${
                  r.posterSrc
                    ? `<td width="44" style="vertical-align:middle; width:44px; padding-right:12px;"><img src="${esc(r.posterSrc)}" width="36" height="36" style="border-radius:6px; object-fit:cover; display:block; width:36px; height:36px; box-shadow:0 2px 6px rgba(0,0,0,0.4);" alt="" /></td>`
                    : ''
                }
                <td style="vertical-align:middle;">
                  <div style="color:${text}; font-size:14px; font-weight:600; letter-spacing:-0.005em;">${esc(r.label)}</div>
                </td>
                <td style="vertical-align:middle; text-align:right; color:${muted}; font-size:12px; font-variant-numeric:tabular-nums; white-space:nowrap; padding-left:12px;">${esc(r.detail)}</td>
              </tr>
            </table>
          </td>
        </tr>
      `
    )
    .join('');
  return `
    ${sectionHeader(title, rows.length, accent)}
    <mj-section background-color="${COLORS.bg}" padding="6px 32px 0 32px">
      <mj-column padding="0">
        <mj-raw>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
            ${items}
          </table>
        </mj-raw>
      </mj-column>
    </mj-section>
  `;
}

function renderStats(stats: { totalPlays: number; totalDuration: string; windowDays: number }, accent: string): string {
  const { muted, divider } = COLORS;
  return `
    <mj-section background-color="${COLORS.bg}" padding="40px 32px 0 32px">
      <mj-column>
        <mj-text font-size="10.5px" letter-spacing="2.5px" font-weight="700" text-transform="uppercase" color="${muted}" padding="0 0 14px 0">
          Last ${stats.windowDays} Days
        </mj-text>
        ${accentRule(accent)}
      </mj-column>
    </mj-section>
    <mj-section background-color="${COLORS.bg}" padding="22px 32px 0 32px">
      <mj-column padding="0" width="50%">
        <mj-text align="left" color="${accent}" font-size="34px" font-weight="700" letter-spacing="-0.02em" padding="0" css-class="stat-number">${stats.totalPlays.toLocaleString()}</mj-text>
        <mj-text align="left" color="${muted}" font-size="11px" letter-spacing="2px" font-weight="700" text-transform="uppercase" padding="4px 0 0 0">Total Plays</mj-text>
      </mj-column>
      <mj-column padding="0" width="50%">
        <mj-text align="left" color="${accent}" font-size="34px" font-weight="700" letter-spacing="-0.02em" padding="0" css-class="stat-number">${esc(stats.totalDuration)}</mj-text>
        <mj-text align="left" color="${muted}" font-size="11px" letter-spacing="2px" font-weight="700" text-transform="uppercase" padding="4px 0 0 0">Watched</mj-text>
      </mj-column>
    </mj-section>
  `;
}

/** A playful one-liner under the watch-time stats. `standalone` wraps it in its
 *  own padded section when the stats block itself isn't being rendered. */
function renderFunCaption(caption: string, accent: string, standalone: boolean): string {
  const { muted } = COLORS;
  const pad = standalone ? '40px 32px 0 32px' : '16px 32px 0 32px';
  return `
    <mj-section background-color="${COLORS.bg}" padding="${pad}">
      <mj-column>
        <mj-text align="${standalone ? 'center' : 'left'}" color="${muted}" font-size="13px" font-style="italic" line-height="1.6" padding="0">
          <span style="color:${accent};">✦</span> ${esc(caption)}
        </mj-text>
      </mj-column>
    </mj-section>
  `;
}

function hasFlexStats(f: FlexStats): boolean {
  return (
    f.movies != null || f.shows != null || f.storageTb != null ||
    f.addedThisPeriod != null || (f.uptimePct != null)
  );
}

/** Homelab "State of the Server" bar — a row of headline numbers. */
function renderFlexBar(flex: FlexStats, accent: string): string {
  const { text, muted } = COLORS;
  const cells: { value: string; label: string }[] = [];
  if (flex.movies != null) cells.push({ value: flex.movies.toLocaleString(), label: 'Movies' });
  if (flex.shows != null) cells.push({ value: flex.shows.toLocaleString(), label: 'Shows' });
  if (flex.storageTb != null) cells.push({ value: `${flex.storageTb} TB`, label: 'Library' });
  if (flex.addedThisPeriod != null) cells.push({ value: `+${flex.addedThisPeriod.toLocaleString()}`, label: 'Added' });
  if (flex.uptimePct != null) cells.push({ value: `${flex.uptimePct}%`, label: 'Uptime' });
  if (cells.length === 0) return '';

  const width = `${Math.floor(100 / cells.length)}%`;
  const columns = cells
    .map(
      (c) => `
      <mj-column padding="0" width="${width}">
        <mj-text align="center" color="${accent}" font-size="26px" font-weight="700" letter-spacing="-0.02em" padding="0" css-class="stat-number">${esc(c.value)}</mj-text>
        <mj-text align="center" color="${muted}" font-size="10px" letter-spacing="1.6px" font-weight="700" text-transform="uppercase" padding="6px 0 0 0">${esc(c.label)}</mj-text>
      </mj-column>`
    )
    .join('');

  return `
    <mj-section background-color="${COLORS.bg}" padding="40px 32px 0 32px">
      <mj-column>
        <mj-text font-size="10.5px" letter-spacing="2.5px" font-weight="700" text-transform="uppercase" color="${muted}" padding="0 0 14px 0">State of the Server</mj-text>
        ${accentRule(accent)}
      </mj-column>
    </mj-section>
    <mj-section background-color="${COLORS.bg}" padding="22px 32px 0 32px">
      ${columns}
    </mj-section>
  `;
}

/** "Server Wrapped" award cards, two per row. */
function renderSuperlatives(items: Superlative[], accent: string): string {
  const { text, textSoft, muted } = COLORS;
  const card = (s: Superlative) => `
    <mj-column padding="0 8px" width="50%" vertical-align="top">
      <mj-text padding="0">
        <span style="font-size:26px; line-height:1;">${s.emoji}</span>
      </mj-text>
      <mj-text color="${accent}" font-size="10.5px" font-weight="700" letter-spacing="1.6px" text-transform="uppercase" padding="8px 0 0 0">${esc(s.title)}</mj-text>
      <mj-text color="${text}" font-size="16px" font-weight="700" letter-spacing="-0.01em" line-height="1.3" padding="4px 0 0 0">${esc(s.name)}</mj-text>
      <mj-text color="${textSoft}" font-size="12.5px" line-height="1.5" padding="2px 0 0 0">${esc(s.detail)}</mj-text>
    </mj-column>`;

  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2);
    rows.push(`
      <mj-section background-color="${COLORS.bg}" padding="22px 24px 0 24px">
        ${pair.map(card).join('')}
      </mj-section>
    `);
  }

  return `
    <mj-section background-color="${COLORS.bg}" padding="40px 32px 0 32px">
      <mj-column>
        <mj-text font-size="10.5px" letter-spacing="2.5px" font-weight="700" text-transform="uppercase" color="${muted}" padding="0 0 14px 0">
          Server Wrapped <span style="color:${accent};">·</span> ${items.length} award${items.length === 1 ? '' : 's'}
        </mj-text>
        ${accentRule(accent)}
      </mj-column>
    </mj-section>
    ${rows.join('')}
  `;
}

function upcomingHeader(title: string, count: number, accent: string, windowDays: number): string {
  const { muted } = COLORS;
  return `
    <mj-section background-color="${COLORS.bg}" padding="40px 32px 0 32px">
      <mj-column>
        <mj-text font-size="10.5px" letter-spacing="2.5px" font-weight="700" text-transform="uppercase" color="${muted}" padding="0 0 14px 0">
          ${esc(title)} <span style="color:${accent};">·</span> ${count} <span style="color:${muted}; font-weight:500; letter-spacing:1.2px;">· next ${windowDays} days</span>
        </mj-text>
        ${accentRule(accent)}
      </mj-column>
    </mj-section>
  `;
}

function renderUpcomingMovies(
  items: RenderedUpcomingMovie[],
  accent: string,
  windowDays: number,
  showSummaries: boolean
): string {
  const { text, textSoft, muted, divider } = COLORS;
  const blocks: string[] = [upcomingHeader('Coming Soon · Movies', items.length, accent, windowDays)];

  items.forEach((item, i) => {
    const isLast = i === items.length - 1;
    const posterCol = item.posterSrc
      ? `<mj-column width="124px" padding="0" vertical-align="top" css-class="item-poster">
           <mj-image src="${esc(item.posterSrc)}" alt="${esc(item.title)}" width="100px" padding="0" align="left" border-radius="6px" css-class="poster" />
         </mj-column>`
      : '';
    const contentWidth = item.posterSrc ? '452px' : '100%';

    const datePill = `<span style="display:inline-block; background:${accent}1f; color:${accent}; font-size:10.5px; font-weight:700; letter-spacing:1.4px; text-transform:uppercase; padding:4px 9px; border-radius:3px; margin-right:8px;">${esc(item.dateLabel)}</span><span style="color:${muted}; font-size:11px; font-weight:600; letter-spacing:1.4px; text-transform:uppercase;">${esc(item.releaseLabel)}</span>`;

    const titleLine = `<mj-text color="${text}" font-size="17px" font-weight="700" line-height="1.3" letter-spacing="-0.01em" padding="0">${esc(item.title)}${item.year ? ` <span style="color:${muted}; font-weight:500;">${esc(item.year)}</span>` : ''}</mj-text>`;
    const summaryLine =
      showSummaries && item.overview
        ? `<mj-text color="${textSoft}" font-size="13.5px" line-height="1.6" padding="8px 0 0 0">${esc(shortSummary(item.overview, 110))}</mj-text>`
        : '';

    blocks.push(`
      <mj-section background-color="${COLORS.bg}" padding="22px 32px 0 32px">
        ${posterCol}
        <mj-column width="${contentWidth}" padding="0" vertical-align="top">
          <mj-text padding="0 0 8px 0" font-size="11px">${datePill}</mj-text>
          ${titleLine}
          ${summaryLine}
        </mj-column>
      </mj-section>
      ${
        !isLast
          ? `<mj-section background-color="${COLORS.bg}" padding="22px 32px 0 32px">
               <mj-column>
                 <mj-divider border-color="${divider}" border-width="1px" padding="0" />
               </mj-column>
             </mj-section>`
          : ''
      }
    `);
  });

  return blocks.join('\n');
}

function renderUpcomingShows(shows: RenderedUpcomingShow[], accent: string, windowDays: number): string {
  const { text, textSoft, muted, divider } = COLORS;
  const epCount = shows.reduce((n, s) => n + s.episodes.length, 0);
  const blocks: string[] = [upcomingHeader('Coming Soon · TV', epCount, accent, windowDays)];

  shows.forEach((show, showIdx) => {
    const isLastShow = showIdx === shows.length - 1;

    const episodeRows = show.episodes
      .map((ep, i) => {
        const top = i === 0 ? '' : `border-top:1px solid ${divider};`;
        return `
          <tr>
            <td style="padding:8px 14px 8px 0; vertical-align:top; ${top} width:64px; white-space:nowrap;">
              <span style="color:${accent}; font-size:11px; font-weight:700; letter-spacing:1px; font-family:Inter,sans-serif;">${esc(ep.label)}</span>
            </td>
            <td style="padding:8px 12px 8px 0; vertical-align:top; ${top}">
              <span style="color:${textSoft}; font-size:13.5px; font-weight:500; line-height:1.5; font-family:Inter,sans-serif;">${esc(ep.title)}</span>
            </td>
            <td style="padding:8px 0; vertical-align:top; ${top} text-align:right; white-space:nowrap;">
              <span style="color:${muted}; font-size:11px; font-weight:600; letter-spacing:0.5px; font-family:Inter,sans-serif;">${esc(ep.dateLabel)}</span>
            </td>
          </tr>
        `;
      })
      .join('');

    const posterCol = show.posterSrc
      ? `<mj-column width="124px" padding="0" vertical-align="top" css-class="item-poster">
           <mj-image src="${esc(show.posterSrc)}" alt="${esc(show.title)}" width="100px" padding="0" align="left" border-radius="6px" css-class="poster" />
         </mj-column>`
      : '';
    const contentWidth = show.posterSrc ? '452px' : '100%';

    blocks.push(`
      <mj-section background-color="${COLORS.bg}" padding="22px 32px 0 32px">
        ${posterCol}
        <mj-column width="${contentWidth}" padding="0" vertical-align="top">
          <mj-text color="${muted}" font-size="11px" font-weight="600" letter-spacing="1.4px" text-transform="uppercase" padding="0 0 6px 0">${esc(show.episodes.length === 1 ? '1 episode' : `${show.episodes.length} episodes`)}</mj-text>
          <mj-text color="${text}" font-size="17px" font-weight="700" line-height="1.3" letter-spacing="-0.01em" padding="0 0 10px 0">${esc(show.title)}</mj-text>
          <mj-raw>
            <table role="presentation" class="show-episodes-table" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
              ${episodeRows}
            </table>
          </mj-raw>
        </mj-column>
      </mj-section>
      ${
        !isLastShow
          ? `<mj-section background-color="${COLORS.bg}" padding="22px 32px 0 32px">
               <mj-column>
                 <mj-divider border-color="${divider}" border-width="1px" padding="0" />
               </mj-column>
             </mj-section>`
          : ''
      }
    `);
  });

  return blocks.join('\n');
}

export { formatDuration };
