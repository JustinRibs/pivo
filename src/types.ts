export interface Settings {
  // Tautulli
  tautulli_url: string;
  tautulli_api_key: string;

  // SMTP
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number; // 0/1
  smtp_user: string;
  smtp_pass: string;
  smtp_from_name: string;
  smtp_from_email: string;

  // Branding
  brand_name: string;
  brand_accent: string;       // hex color like #e5a00d (Plex orange-ish)
  brand_logo_path: string;    // relative path under DATA_DIR/uploads, or ""
  brand_header_html: string;  // optional html shown under the logo
  brand_footer_html: string;  // optional html shown at the bottom

  // Personalization — a per-recipient greeting line rendered in the header.
  // greeting_text supports {{first_name}} / {{name}} placeholders.
  greeting_enabled: number;   // 0/1
  greeting_text: string;

  // Request CTA — a "Request a movie or show" button (Overseerr / Jellyseerr).
  request_enabled: number;    // 0/1
  request_url: string;
  request_label: string;

  // Drag-to-reorder: JSON array of section keys controlling render order of the
  // newsletter's body sections. Unknown/missing keys fall back to defaults.
  section_order: string;

  // "Server Wrapped" awards (Night Owl, Biggest Binger, etc.) from watch history.
  enable_superlatives: number; // 0/1

  // Homelab "flex bar" — library counts, storage, items added, uptime badge.
  enable_flex_bar: number;     // 0/1
  uptime_enabled: number;      // 0/1
  uptime_kuma_url: string;     // base URL of an Uptime Kuma instance
  uptime_kuma_slug: string;    // status-page slug to read uptime from

  // Seasonal auto-theming — overrides the accent + adds an emoji around holidays.
  seasonal_theme_enabled: number; // 0/1

  // Absurd unit conversions — a playful caption under the watch-time stats.
  enable_fun_stats: number;    // 0/1

  // AI-written copy. The model only rephrases already-computed facts — it
  // rewrites award captions and (optionally) the intro, and never sees raw
  // watch history. Any failure falls back to the templated wording.
  enable_ai_captions: number;  // 0/1
  /** Also generate a short opener for the header. */
  ai_write_intro: number;      // 0/1
  /** 'openai' (any OpenAI-compatible endpoint), 'anthropic', or 'ollama'. */
  ai_provider: string;
  /** Endpoint base. Blank uses the provider default. */
  ai_base_url: string;
  ai_model: string;
  ai_api_key: string;
  /** Free-text tone direction appended to the prompt. */
  ai_extra_instructions: string;
  ai_timeout_ms: number;
  /** Ollama only — how long to keep the model resident after generating. */
  ai_ollama_keep_alive: string;
  /** Write the subject line and inbox preview text from the edition's contents. */
  ai_write_subject: number;   // 0/1
  /**
   * Rewrite the recently-added blurbs. The model compresses the synopsis Plex
   * already gave us — it is never asked to describe a title from its own
   * knowledge, which is where it would start inventing plot.
   */
  ai_rewrite_summaries: number; // 0/1

  // Spend guards. Caps are enforced against rolling windows before a request is
  // sent; hitting one falls back to the templated wording, same as any failure.
  /** Max billed calls in any rolling 24h. 0 disables the cap. */
  ai_daily_call_cap: number;
  /** Max prompt+completion tokens in any rolling 30 days. 0 disables the cap. */
  ai_monthly_token_cap: number;
  /** Per-request output ceiling handed to the provider. */
  ai_max_output_tokens: number;
  /** Reuse an identical response for this many minutes. 0 disables the cache. */
  ai_cache_ttl_min: number;

  // Content
  recently_added_count: number;
  include_movies: number;
  include_tv: number;
  include_music: number;
  show_summaries: number;

  enable_top_watched: number;
  enable_top_users: number;
  enable_stats: number;
  stats_window_days: number;

  // Scheduling
  schedule_cron: string;      // e.g. "0 9 * * 0" for Sundays 9am
  schedule_enabled: number;
  newsletter_subject: string; // can include {{date}}

  // Delivery
  public_url: string;         // base URL the app is reachable at — used to build unsubscribe links

  // Image hosting (Cloudinary). When enabled, posters are uploaded to Cloudinary
  // once and embedded as plain <img src="https://…"> URLs instead of CID
  // attachments — so the email no longer ships ~30 inline files.
  cloudinary_enabled: number; // 0/1
  cloudinary_cloud_name: string;
  cloudinary_api_key: string;
  cloudinary_api_secret: string;
  cloudinary_folder: string;  // namespacing inside the cloud, e.g. "pivo"

  // Radarr / Sonarr — drives the "Coming Soon" section
  radarr_enabled: number; // 0/1
  radarr_url: string;
  radarr_api_key: string;
  sonarr_enabled: number; // 0/1
  sonarr_url: string;
  sonarr_api_key: string;
  upcoming_window_days: number;
  /** Master switch for the Coming Soon section. */
  enable_upcoming: number; // 0/1
  /** When 1, the Recently Added sections are hidden whenever Coming Soon has anything to show. */
  upcoming_replaces_recent: number; // 0/1
}

export interface Recipient {
  id: number;
  email: string;
  name: string;
  active: number;
  unsubscribe_token: string;
  created_at: string;
}

export interface SendLog {
  id: number;
  sent_at: string;
  recipient_count: number;
  status: 'success' | 'partial' | 'failed';
  message: string;
  duration_ms: number;
  kind: 'newsletter' | 'broadcast';
  subject: string;
}

export interface RecentlyAddedItem {
  rating_key: string;
  parent_rating_key?: string;
  grandparent_rating_key?: string;
  title: string;
  parent_title?: string;
  grandparent_title?: string;
  year?: string;
  summary?: string;
  thumb?: string;
  parent_thumb?: string;
  grandparent_thumb?: string;
  art?: string;
  media_type: string; // "movie" | "show" | "season" | "episode" | "album" | "track"
  library_name?: string;
  added_at?: string;
  originally_available_at?: string;
  content_rating?: string;
  rating?: string;
  audience_rating?: string;
  duration?: string;
  video_resolution?: string;
}

export interface HomeStatRow {
  title?: string;
  rating_key?: string;
  thumb?: string;
  art?: string;
  user?: string;
  user_id?: number;
  user_thumb?: string;
  total_plays?: number;
  total_duration?: number;
  last_play?: number;
}

export interface HomeStat {
  stat_id: string;     // e.g. "top_movies", "top_tv", "top_users"
  stat_title?: string;
  rows: HomeStatRow[];
}

export interface HistoryRow {
  date?: number;
  started?: number;
  stopped?: number;
  duration?: number; // seconds actually watched
  user_id?: number;
  user?: string;
  friendly_name?: string;
  full_title?: string;
  title?: string;
  grandparent_title?: string;
  grandparent_rating_key?: string;
  rating_key?: string;
  media_type?: string;
  year?: string | number;
  watched_status?: number;
}

export interface UsersTableRow {
  user_id: number;
  user?: string;
  friendly_name?: string;
  last_seen?: number | null; // epoch seconds, or null if never
  plays?: number;
  duration?: number;
}

export interface TautulliLibrary {
  section_id: string | number;
  section_name?: string;
  section_type?: string; // "movie" | "show" | "artist" | "photo"
  count?: number | string;
  parent_count?: number | string;
  child_count?: number | string;
}

export interface TautulliUser {
  user_id: number;
  username: string;
  friendly_name?: string;
  email?: string | null;
  thumb?: string;
  is_active?: number;
  is_admin?: number;
  is_home_user?: number;
  is_restricted?: number;
}

export interface ComposedNewsletter {
  subject: string;
  html: string;
  text: string;
  /**
   * Inline CID attachments. When Cloudinary is enabled, posters are hosted there
   * and this array typically just holds the brand logo (or is empty).
   */
  attachments: { filename: string; cid: string; content: Buffer; contentType: string }[];
}
