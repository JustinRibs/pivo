import { request } from 'undici';

/**
 * Read an aggregate uptime percentage from an Uptime Kuma status page.
 *
 * Kuma exposes `/api/status-page/heartbeat/<slug>` which returns an
 * `uptimeList` keyed like `"<monitorId>_24"` (24h) / `"<monitorId>_720"` (30d),
 * with values in 0–1. We average the 24h entries across every monitor on the
 * page so the newsletter can show one friendly "Uptime 99.97%" badge without
 * the recipient ever needing to know what Uptime Kuma is.
 *
 * Returns a percentage (e.g. 99.97) or null if it can't be determined.
 */
export async function fetchUptimePercent(baseUrl: string, slug: string): Promise<number | null> {
  if (!baseUrl || !slug) return null;
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}/api/status-page/heartbeat/${encodeURIComponent(slug)}`;
  try {
    const res = await request(url, { method: 'GET', headersTimeout: 10_000, bodyTimeout: 15_000 });
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    const body = (await res.body.json()) as { uptimeList?: Record<string, number> };
    const list = body?.uptimeList || {};
    const entries = Object.entries(list);
    if (entries.length === 0) return null;
    // Prefer the 24h figures; fall back to whatever windows are present.
    const day = entries.filter(([k]) => k.endsWith('_24')).map(([, v]) => Number(v));
    const pool = (day.length ? day : entries.map(([, v]) => Number(v))).filter((n) => !Number.isNaN(n));
    if (pool.length === 0) return null;
    const avg = pool.reduce((a, b) => a + b, 0) / pool.length;
    return Math.round(avg * 10000) / 100; // 0–1 → percent with 2 decimals
  } catch {
    return null;
  }
}
