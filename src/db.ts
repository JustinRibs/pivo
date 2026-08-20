import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';
import type { Recipient, SendLog, Settings } from './types.js';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipients (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL DEFAULT '',
  active             INTEGER NOT NULL DEFAULT 1,
  unsubscribe_token  TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS send_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at         TEXT NOT NULL DEFAULT (datetime('now')),
  recipient_count INTEGER NOT NULL,
  status          TEXT NOT NULL,
  message         TEXT NOT NULL DEFAULT '',
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  kind            TEXT NOT NULL DEFAULT 'newsletter',
  subject         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cloudinary_uploads (
  public_id   TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  called_at         TEXT NOT NULL DEFAULT (datetime('now')),
  source            TEXT NOT NULL DEFAULT 'send',
  provider          TEXT NOT NULL DEFAULT '',
  model             TEXT NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'ok'
);

CREATE INDEX IF NOT EXISTS ai_usage_called_at ON ai_usage (called_at);

CREATE TABLE IF NOT EXISTS ai_cache (
  hash        TEXT PRIMARY KEY,
  response    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// --- Migrations -------------------------------------------------------------
// Add unsubscribe_token if upgrading from a pre-existing DB
const recipientCols = db.prepare("PRAGMA table_info(recipients)").all() as { name: string }[];
if (!recipientCols.some((c) => c.name === 'unsubscribe_token')) {
  db.exec("ALTER TABLE recipients ADD COLUMN unsubscribe_token TEXT NOT NULL DEFAULT ''");
}
// Add send_log kind/subject for distinguishing broadcasts from newsletters
const sendLogCols = db.prepare("PRAGMA table_info(send_log)").all() as { name: string }[];
if (!sendLogCols.some((c) => c.name === 'kind')) {
  db.exec("ALTER TABLE send_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'newsletter'");
}
if (!sendLogCols.some((c) => c.name === 'subject')) {
  db.exec("ALTER TABLE send_log ADD COLUMN subject TEXT NOT NULL DEFAULT ''");
}
// Backfill tokens for any rows missing one
const missingTokens = db.prepare("SELECT id FROM recipients WHERE unsubscribe_token = ''").all() as { id: number }[];
if (missingTokens.length > 0) {
  const upd = db.prepare('UPDATE recipients SET unsubscribe_token = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of missingTokens) upd.run(generateToken(), r.id);
  });
  tx();
}

function generateToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

const DEFAULTS: Settings = {
  tautulli_url: '',
  tautulli_api_key: '',

  smtp_host: '',
  smtp_port: 587,
  smtp_secure: 0,
  smtp_user: '',
  smtp_pass: '',
  smtp_from_name: 'Plex Newsletter',
  smtp_from_email: '',

  brand_name: 'My Plex Newsletter',
  brand_accent: '#e5a00d',
  brand_logo_path: '',
  brand_header_html: 'Here’s what’s new this week.',
  brand_footer_html: 'You’re receiving this because you have access to my Plex server.',

  greeting_enabled: 0,
  greeting_text: 'Welcome back, {{first_name}}',

  request_enabled: 0,
  request_url: '',
  request_label: 'Request a movie or show',

  section_order: JSON.stringify([
    'flex_bar', 'stats', 'superlatives', 'top_movies', 'top_tv', 'top_users',
    'recent_movies', 'recent_tv', 'recent_music',
    'upcoming_movies', 'upcoming_shows'
  ]),

  enable_superlatives: 0,

  enable_ai_captions: 0,
  ai_write_intro: 0,
  ai_provider: 'openai',
  ai_base_url: '',
  ai_model: '',
  ai_api_key: '',
  ai_extra_instructions: '',
  ai_timeout_ms: 30000,
  ai_ollama_keep_alive: '0s',
  ai_write_subject: 0,
  ai_rewrite_summaries: 0,
  ai_daily_call_cap: 25,
  ai_monthly_token_cap: 250000,
  ai_max_output_tokens: 700,
  ai_cache_ttl_min: 360,

  enable_flex_bar: 0,
  uptime_enabled: 0,
  uptime_kuma_url: '',
  uptime_kuma_slug: '',

  seasonal_theme_enabled: 0,

  enable_fun_stats: 0,

  recently_added_count: 8,
  include_movies: 1,
  include_tv: 1,
  include_music: 0,
  show_summaries: 1,

  enable_top_watched: 0,
  enable_top_users: 0,
  enable_stats: 0,
  stats_window_days: 7,

  schedule_cron: '0 9 * * 0',
  schedule_enabled: 0,
  newsletter_subject: 'New on Plex — {{date}}',

  public_url: '',

  cloudinary_enabled: 0,
  cloudinary_cloud_name: '',
  cloudinary_api_key: '',
  cloudinary_api_secret: '',
  cloudinary_folder: 'pivo',

  radarr_enabled: 0,
  radarr_url: '',
  radarr_api_key: '',
  sonarr_enabled: 0,
  sonarr_url: '',
  sonarr_api_key: '',
  upcoming_window_days: 7,
  enable_upcoming: 0,
  upcoming_replaces_recent: 0
};

// Seed defaults for any missing key
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULTS)) {
  insertSetting.run(k, String(v));
}

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Record<string, string | number> = { ...DEFAULTS } as any;
  for (const { key, value } of rows) {
    if (typeof (DEFAULTS as any)[key] === 'number') {
      out[key] = Number(value);
    } else {
      out[key] = value;
    }
  }
  return out as unknown as Settings;
}

const upsertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const next = { ...current, ...patch };
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(next)) {
      // only persist keys we know about
      if (!(k in DEFAULTS)) continue;
      upsertSetting.run(k, String(v));
    }
  });
  tx();
  return getSettings();
}

export function listRecipients(): Recipient[] {
  return db.prepare('SELECT * FROM recipients ORDER BY created_at DESC').all() as Recipient[];
}

export function listActiveRecipients(): Recipient[] {
  return db.prepare('SELECT * FROM recipients WHERE active = 1 ORDER BY email').all() as Recipient[];
}

export function addRecipient(email: string, name: string): Recipient {
  const info = db
    .prepare('INSERT INTO recipients (email, name, unsubscribe_token) VALUES (?, ?, ?)')
    .run(email.trim().toLowerCase(), name.trim(), generateToken());
  return db.prepare('SELECT * FROM recipients WHERE id = ?').get(info.lastInsertRowid) as Recipient;
}

/**
 * Insert a recipient if their email isn't already in the table. Returns the
 * row plus a `created` flag. Idempotent — safe to call repeatedly during a bulk import.
 */
export function importRecipient(
  email: string,
  name: string,
  active: 0 | 1 = 0
): { recipient: Recipient; created: boolean } | null {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) return null;
  const existing = db.prepare('SELECT * FROM recipients WHERE email = ?').get(cleanEmail) as Recipient | undefined;
  if (existing) return { recipient: existing, created: false };
  const info = db
    .prepare('INSERT INTO recipients (email, name, active, unsubscribe_token) VALUES (?, ?, ?, ?)')
    .run(cleanEmail, name.trim(), active, generateToken());
  const recipient = db.prepare('SELECT * FROM recipients WHERE id = ?').get(info.lastInsertRowid) as Recipient;
  return { recipient, created: true };
}

export function findRecipientByToken(token: string): Recipient | null {
  if (!token) return null;
  const r = db.prepare('SELECT * FROM recipients WHERE unsubscribe_token = ?').get(token) as Recipient | undefined;
  return r || null;
}

export function deactivateRecipient(id: number): void {
  db.prepare('UPDATE recipients SET active = 0 WHERE id = ?').run(id);
}

export function updateRecipient(id: number, patch: { email?: string; name?: string; active?: number }): Recipient | null {
  const existing = db.prepare('SELECT * FROM recipients WHERE id = ?').get(id) as Recipient | undefined;
  if (!existing) return null;
  const email = patch.email !== undefined ? patch.email.trim().toLowerCase() : existing.email;
  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  const active = patch.active !== undefined ? (patch.active ? 1 : 0) : existing.active;
  db.prepare('UPDATE recipients SET email = ?, name = ?, active = ? WHERE id = ?').run(email, name, active, id);
  return db.prepare('SELECT * FROM recipients WHERE id = ?').get(id) as Recipient;
}

export function deleteRecipient(id: number): boolean {
  const info = db.prepare('DELETE FROM recipients WHERE id = ?').run(id);
  return info.changes > 0;
}

export function logSend(entry: Omit<SendLog, 'id' | 'sent_at'>): void {
  db.prepare(
    'INSERT INTO send_log (recipient_count, status, message, duration_ms, kind, subject) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(entry.recipient_count, entry.status, entry.message, entry.duration_ms, entry.kind || 'newsletter', entry.subject || '');
  // keep only the last 100 entries
  db.exec(
    "DELETE FROM send_log WHERE id NOT IN (SELECT id FROM send_log ORDER BY sent_at DESC LIMIT 100)"
  );
}

export function listSendLog(limit = 25): SendLog[] {
  return db.prepare('SELECT * FROM send_log ORDER BY sent_at DESC LIMIT ?').all(limit) as SendLog[];
}

// --- Cloudinary upload cache ------------------------------------------------
// Posters very rarely change once a Plex item is added, so once we've uploaded a
// given (rating_key + thumb-version) pair we can reuse the public URL forever.
// The public_id encodes the version, so a re-grabbed poster forces a fresh row.

const cloudinaryLookupStmt = db.prepare('SELECT url FROM cloudinary_uploads WHERE public_id = ?');
const cloudinarySaveStmt = db.prepare(
  "INSERT INTO cloudinary_uploads (public_id, url) VALUES (?, ?)" +
    " ON CONFLICT(public_id) DO UPDATE SET url = excluded.url, created_at = datetime('now')"
);

export function lookupCloudinaryUrl(publicId: string): string | undefined {
  const row = cloudinaryLookupStmt.get(publicId) as { url: string } | undefined;
  return row?.url;
}

export function saveCloudinaryUrl(publicId: string, url: string): void {
  cloudinarySaveStmt.run(publicId, url);
}

// --- AI spend guards --------------------------------------------------------
// Two independent brakes on API cost:
//
//   1. `ai_cache` — identical requests (same provider, model, prompt and output
//      ceiling) reuse the previous response for `ai_cache_ttl_min` minutes. The
//      newsletter preview recomposes on every page load, so without this a
//      tuning session is one billable call per refresh.
//   2. `ai_usage` — every attempt is recorded, and the caps are enforced against
//      rolling windows before the next request goes out. Rolling rather than
//      calendar windows so a cap can't be reset by waiting for midnight, and so
//      the numbers don't depend on the container's timezone.
//
// Both tables are additive: older builds of pivo never read them, so rolling
// back leaves them sitting harmlessly on disk.

const AI_USAGE_KEEP = 2000;

export interface AiUsageEntry {
  source: 'send' | 'preview' | 'test';
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  /**
   * `ok` billed a live request; `cache` reused a stored response; `blocked` was
   * stopped by a cap before any request was made. Only `ok` consumes budget.
   */
  status: 'ok' | 'cache' | 'error' | 'blocked';
}

export interface AiUsageSummary {
  callsLast24h: number;
  tokensLast24h: number;
  callsLast30d: number;
  promptTokensLast30d: number;
  completionTokensLast30d: number;
  tokensLast30d: number;
  blockedLast30d: number;
  errorsLast30d: number;
  errorsLastHour: number;
  cacheHitsLast30d: number;
  lastCallAt: string | null;
}

const insertAiUsage = db.prepare(
  'INSERT INTO ai_usage (source, provider, model, prompt_tokens, completion_tokens, status)' +
    ' VALUES (?, ?, ?, ?, ?, ?)'
);

export function recordAiUsage(entry: AiUsageEntry): void {
  insertAiUsage.run(
    entry.source,
    entry.provider,
    entry.model,
    Math.max(0, Math.round(entry.prompt_tokens || 0)),
    Math.max(0, Math.round(entry.completion_tokens || 0)),
    entry.status
  );
  db.exec(`DELETE FROM ai_usage WHERE id NOT IN (SELECT id FROM ai_usage ORDER BY id DESC LIMIT ${AI_USAGE_KEEP})`);
}

/**
 * Rolling-window totals. Only `status = 'ok'` rows count toward the caps —
 * a blocked or failed call costs nothing, so it must not consume budget.
 */
export function getAiUsageSummary(): AiUsageSummary {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'ok'      AND called_at >= datetime('now', '-1 day')   THEN 1 ELSE 0 END), 0) AS calls24,
         COALESCE(SUM(CASE WHEN status = 'ok'      AND called_at >= datetime('now', '-1 day')   THEN prompt_tokens + completion_tokens ELSE 0 END), 0) AS tokens24,
         COALESCE(SUM(CASE WHEN status = 'ok'      AND called_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END), 0) AS calls30,
         COALESCE(SUM(CASE WHEN status = 'ok'      AND called_at >= datetime('now', '-30 days') THEN prompt_tokens ELSE 0 END), 0) AS prompt30,
         COALESCE(SUM(CASE WHEN status = 'ok'      AND called_at >= datetime('now', '-30 days') THEN completion_tokens ELSE 0 END), 0) AS completion30,
         COALESCE(SUM(CASE WHEN status = 'blocked' AND called_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END), 0) AS blocked30,
         COALESCE(SUM(CASE WHEN status = 'error'   AND called_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END), 0) AS errors30,
         COALESCE(SUM(CASE WHEN status = 'error'   AND called_at >= datetime('now', '-1 hour')   THEN 1 ELSE 0 END), 0) AS errors1h,
         MAX(called_at) AS last_at
       FROM ai_usage`
    )
    .get() as any;

  const cacheHits = db
    .prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE status = 'cache' AND called_at >= datetime('now', '-30 days')")
    .get() as { n: number };

  return {
    callsLast24h: row.calls24,
    tokensLast24h: row.tokens24,
    callsLast30d: row.calls30,
    promptTokensLast30d: row.prompt30,
    completionTokensLast30d: row.completion30,
    tokensLast30d: row.prompt30 + row.completion30,
    blockedLast30d: row.blocked30,
    errorsLast30d: row.errors30,
    errorsLastHour: row.errors1h,
    cacheHitsLast30d: cacheHits.n,
    lastCallAt: row.last_at || null
  };
}

export function resetAiUsage(): void {
  db.exec('DELETE FROM ai_usage');
}

// --- AI response cache ------------------------------------------------------

const aiCacheLookup = db.prepare("SELECT response FROM ai_cache WHERE hash = ? AND created_at >= datetime('now', ?)");
const aiCacheSave = db.prepare(
  "INSERT INTO ai_cache (hash, response) VALUES (?, ?)" +
    " ON CONFLICT(hash) DO UPDATE SET response = excluded.response, created_at = datetime('now')"
);

export function lookupAiCache(hash: string, ttlMinutes: number): string | undefined {
  if (ttlMinutes <= 0) return undefined;
  const row = aiCacheLookup.get(hash, `-${Math.round(ttlMinutes)} minutes`) as { response: string } | undefined;
  return row?.response;
}

export function saveAiCache(hash: string, response: string): void {
  aiCacheSave.run(hash, response);
  // Bound the table — entries are only useful inside the TTL anyway.
  db.exec("DELETE FROM ai_cache WHERE created_at < datetime('now', '-7 days')");
}

export function clearAiCache(): void {
  db.exec('DELETE FROM ai_cache');
}
