import { request } from 'undici';
import type { HistoryRow, HomeStat, RecentlyAddedItem, TautulliLibrary, TautulliUser, UsersTableRow } from './types.js';

export class TautulliError extends Error {}

export class TautulliClient {
  constructor(private baseUrl: string, private apiKey: string) {
    if (!baseUrl) throw new TautulliError('Tautulli URL is not configured');
    if (!apiKey) throw new TautulliError('Tautulli API key is not configured');
  }

  private apiUrl(cmd: string, params: Record<string, string | number> = {}): string {
    const url = new URL('/api/v2', this.baseUrl);
    url.searchParams.set('apikey', this.apiKey);
    url.searchParams.set('cmd', cmd);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async call<T = unknown>(cmd: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = this.apiUrl(cmd, params);
    const res = await request(url, { method: 'GET', headersTimeout: 15_000, bodyTimeout: 30_000 });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new TautulliError(`Tautulli ${cmd} failed: HTTP ${res.statusCode}`);
    }
    const body = (await res.body.json()) as { response?: { result?: string; message?: string; data?: T } };
    if (!body.response || body.response.result !== 'success') {
      throw new TautulliError(`Tautulli ${cmd} failed: ${body.response?.message || 'unknown error'}`);
    }
    return body.response.data as T;
  }

  async ping(): Promise<boolean> {
    await this.call('arnold');
    return true;
  }

  async getRecentlyAdded(count: number, mediaType?: 'movie' | 'show'): Promise<RecentlyAddedItem[]> {
    const params: Record<string, string | number> = { count };
    if (mediaType) params.media_type = mediaType;
    const data = await this.call<{ recently_added: RecentlyAddedItem[] }>('get_recently_added', params);
    return data?.recently_added || [];
  }

  async getUsers(): Promise<TautulliUser[]> {
    const data = await this.call<TautulliUser[]>('get_users');
    return data || [];
  }

  async getHomeStats(timeRange: number, statsCount = 5): Promise<HomeStat[]> {
    const data = await this.call<HomeStat[]>('get_home_stats', {
      time_range: timeRange,
      stats_count: statsCount,
      stats_type: 'plays'
    });
    return data || [];
  }

  /** Detailed play-history rows over the last `afterDays` days (for superlatives). */
  async getHistory(opts: { afterDays?: number; length?: number } = {}): Promise<HistoryRow[]> {
    const params: Record<string, string | number> = {
      length: opts.length ?? 1000,
      order_column: 'date',
      order_dir: 'desc'
    };
    if (opts.afterDays) {
      params.after = new Date(Date.now() - opts.afterDays * 86400_000).toISOString().slice(0, 10);
    }
    const data = await this.call<{ data?: HistoryRow[] }>('get_history', params);
    return data?.data || [];
  }

  /** Per-user table including `last_seen` — used to find the "Ghost" award. */
  async getUsersTable(): Promise<UsersTableRow[]> {
    const data = await this.call<{ data?: UsersTableRow[] }>('get_users_table', {
      length: 1000,
      order_column: 'last_seen',
      order_dir: 'desc'
    });
    return data?.data || [];
  }

  /** Library sections with item counts (movies, shows, episodes). */
  async getLibraries(): Promise<TautulliLibrary[]> {
    const data = await this.call<TautulliLibrary[]>('get_libraries');
    return data || [];
  }

  /** Total file size (bytes) for a single library section. Best-effort. */
  async getLibraryMediaInfo(sectionId: string | number): Promise<number> {
    const data = await this.call<{ total_file_size?: number | string }>('get_library_media_info', {
      section_id: sectionId,
      length: 0
    });
    return Number(data?.total_file_size || 0);
  }

  async getHistoryTotals(timeRange: number): Promise<{ totalPlays: number; totalDurationSec: number }> {
    const after = new Date(Date.now() - timeRange * 86400_000).toISOString().slice(0, 10);
    const data = await this.call<{ recordsFiltered?: number; total_duration?: string; filter_duration?: string }>(
      'get_history',
      { length: 0, after }
    );
    const totalPlays = data?.recordsFiltered ?? 0;
    const dur = (data?.filter_duration || data?.total_duration || '').toString();
    // Tautulli returns "2 days 3 hrs 12 mins" — try to parse
    const totalDurationSec = parseDurationToSeconds(dur);
    return { totalPlays, totalDurationSec };
  }

  /**
   * Returns a fully-resolved URL that retrieves the binary image bytes for a poster/art via Tautulli's proxy.
   * We fetch these server-side and embed them in the email as CID attachments so recipients don't need
   * direct access to your Tautulli instance.
   */
  imageProxyUrl(img: string, opts: { width?: number; height?: number; fallback?: string } = {}): string {
    const params: Record<string, string | number> = { img };
    if (opts.width) params.width = opts.width;
    if (opts.height) params.height = opts.height;
    if (opts.fallback) params.fallback = opts.fallback;
    return this.apiUrl('pms_image_proxy', params);
  }

  async fetchImage(img: string, opts: { width?: number; height?: number } = {}): Promise<{ bytes: Buffer; contentType: string } | null> {
    const url = this.imageProxyUrl(img, opts);
    try {
      const res = await request(url, { method: 'GET', headersTimeout: 15_000, bodyTimeout: 30_000 });
      if (res.statusCode < 200 || res.statusCode >= 300) return null;
      const ct = (res.headers['content-type'] as string) || 'image/jpeg';
      const buf = Buffer.from(await res.body.arrayBuffer());
      if (buf.length === 0) return null;
      return { bytes: buf, contentType: ct };
    } catch {
      return null;
    }
  }
}

function parseDurationToSeconds(s: string): number {
  if (!s) return 0;
  // accept "X days Y hrs Z mins" or numeric seconds
  const numeric = Number(s);
  if (!Number.isNaN(numeric) && numeric > 0) return numeric;
  let total = 0;
  const re = /(\d+)\s*(day|days|hr|hrs|hour|hours|min|mins|minute|minutes|sec|secs|second|seconds)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit.startsWith('day')) total += n * 86400;
    else if (unit.startsWith('hr') || unit.startsWith('hour')) total += n * 3600;
    else if (unit.startsWith('min')) total += n * 60;
    else total += n;
  }
  return total;
}

export function formatDuration(totalSec: number): string {
  if (!totalSec) return '0 mins';
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours) parts.push(`${hours} hr${hours !== 1 ? 's' : ''}`);
  if (mins && !days) parts.push(`${mins} min${mins !== 1 ? 's' : ''}`);
  return parts.join(' ') || '<1 min';
}
