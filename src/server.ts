import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { ADMIN_PASSWORD, PORT, UPLOADS_DIR } from './config.js';
import {
  addRecipient,
  deactivateRecipient,
  deleteRecipient,
  findRecipientByToken,
  getSettings,
  importRecipient,
  listRecipients,
  listActiveRecipients,
  listSendLog,
  logSend,
  updateRecipient,
  updateSettings
} from './db.js';
import { TautulliClient } from './tautulli.js';
import { RadarrClient, SonarrClient } from './arr.js';
import { composeNewsletter } from './email/compose.js';
import { composeBroadcast } from './email/broadcast.js';
import { applySubstitutions, buildPreviewUnsubscribeUrl, PREVIEW_TOKEN, runNewsletter, sendComposed, verifySmtp, type SendableRecipient } from './email/send.js';
import { getScheduleStatus, reloadScheduler } from './scheduler.js';
import type { Settings } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const fastify = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });

await fastify.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024 } });
await fastify.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
// Serve uploaded logos so the UI can preview them
await fastify.register(fastifyStatic, {
  root: UPLOADS_DIR,
  prefix: '/uploads/',
  decorateReply: false
});

if (ADMIN_PASSWORD) {
  fastify.addHook('onRequest', async (req, reply) => {
    // The unsubscribe endpoint must be reachable by recipients without auth
    if (req.url.startsWith('/unsubscribe')) return;
    const auth = req.headers.authorization || '';
    const expected = 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64');
    if (auth !== expected) {
      reply.header('WWW-Authenticate', 'Basic realm="pivo"').code(401).send('Auth required');
    }
  });
}

// --- Settings ---------------------------------------------------------------

fastify.get('/api/settings', async () => {
  const s = getSettings();
  // Don't leak secrets in clear; show whether they're set
  return {
    ...s,
    smtp_pass: s.smtp_pass ? '__set__' : '',
    cloudinary_api_secret: s.cloudinary_api_secret ? '__set__' : ''
  };
});

fastify.put<{ Body: Partial<Settings> }>('/api/settings', async (req) => {
  const body = req.body || {};
  // If a masked sentinel comes back from the form, drop it so we don't overwrite
  if ((body as any).smtp_pass === '__set__') delete (body as any).smtp_pass;
  if ((body as any).cloudinary_api_secret === '__set__') delete (body as any).cloudinary_api_secret;

  // Coerce booleans -> 0/1 for sqlite
  const numericKeys: (keyof Settings)[] = [
    'smtp_secure',
    'smtp_port',
    'recently_added_count',
    'include_movies',
    'include_tv',
    'include_music',
    'show_summaries',
    'enable_top_watched',
    'enable_top_users',
    'enable_stats',
    'stats_window_days',
    'schedule_enabled',
    'greeting_enabled',
    'request_enabled',
    'cloudinary_enabled',
    'radarr_enabled',
    'sonarr_enabled',
    'upcoming_window_days',
    'enable_upcoming',
    'upcoming_replaces_recent'
  ];
  for (const k of numericKeys) {
    if (k in body) {
      (body as any)[k] = typeof (body as any)[k] === 'boolean' ? (((body as any)[k]) ? 1 : 0) : Number((body as any)[k]);
    }
  }

  const next = updateSettings(body);
  reloadScheduler();
  return {
    ...next,
    smtp_pass: next.smtp_pass ? '__set__' : '',
    cloudinary_api_secret: next.cloudinary_api_secret ? '__set__' : ''
  };
});

// --- Recipients -------------------------------------------------------------

fastify.get('/api/recipients', async () => listRecipients());

fastify.post<{ Body: { email: string; name?: string } }>('/api/recipients', async (req, reply) => {
  const { email, name = '' } = req.body || ({} as any);
  if (!email || !/^.+@.+\..+$/.test(email)) {
    return reply.code(400).send({ error: 'Invalid email' });
  }
  try {
    const r = addRecipient(email, name);
    return r;
  } catch (err: any) {
    return reply.code(409).send({ error: err?.message || 'Could not add recipient' });
  }
});

fastify.put<{ Params: { id: string }; Body: { email?: string; name?: string; active?: boolean | number } }>(
  '/api/recipients/:id',
  async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });
    const patch: any = { ...req.body };
    if (typeof patch.active === 'boolean') patch.active = patch.active ? 1 : 0;
    const r = updateRecipient(id, patch);
    if (!r) return reply.code(404).send({ error: 'Not found' });
    return r;
  }
);

fastify.post<{ Body?: { active?: boolean } }>('/api/recipients/import-from-plex', async (req, reply) => {
  const settings = getSettings();
  if (!settings.tautulli_url || !settings.tautulli_api_key) {
    return reply.code(400).send({ error: 'Tautulli is not configured yet' });
  }
  const importActive = req.body?.active ? 1 : 0;
  try {
    const t = new TautulliClient(settings.tautulli_url, settings.tautulli_api_key);
    const users = await t.getUsers();
    let imported = 0;
    let skippedExisting = 0;
    const importedList: { email: string; name: string }[] = [];
    const skippedNoEmailList: { username: string; name: string }[] = [];

    for (const u of users) {
      const username = (u.username || '').trim();
      const friendlyName = (u.friendly_name || username).trim();
      const email = (u.email || '').trim().toLowerCase();

      // Skip the local Plex Media Server account ("Local") which has no real email
      if (!email || !/^.+@.+\..+$/.test(email)) {
        if (username && username.toLowerCase() !== 'local') {
          skippedNoEmailList.push({ username, name: friendlyName });
        }
        continue;
      }

      const result = importRecipient(email, friendlyName, importActive as 0 | 1);
      if (!result) {
        skippedNoEmailList.push({ username, name: friendlyName });
        continue;
      }
      if (result.created) {
        imported += 1;
        importedList.push({ email, name: friendlyName });
      } else {
        skippedExisting += 1;
      }
    }

    return {
      ok: true,
      imported,
      skippedExisting,
      skippedNoEmail: skippedNoEmailList.length,
      importedList,
      skippedNoEmailList
    };
  } catch (err: any) {
    return reply.code(500).send({ error: err?.message || 'Import failed' });
  }
});

fastify.delete<{ Params: { id: string } }>('/api/recipients/:id', async (req, reply) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });
  const ok = deleteRecipient(id);
  if (!ok) return reply.code(404).send({ error: 'Not found' });
  return { ok: true };
});

// --- Logo upload ------------------------------------------------------------

fastify.post('/api/upload/logo', async (req: FastifyRequest, reply: FastifyReply) => {
  const data = await req.file();
  if (!data) return reply.code(400).send({ error: 'No file' });

  const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp'];
  if (!allowed.includes(data.mimetype)) {
    return reply.code(400).send({ error: `Unsupported type: ${data.mimetype}` });
  }
  const ext = path.extname(data.filename) || mimeToExt(data.mimetype);
  const safeName = `logo-${Date.now()}${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fullPath = path.join(UPLOADS_DIR, safeName);

  const buf = await data.toBuffer();
  fs.writeFileSync(fullPath, buf);

  // remove any older logo files
  for (const f of fs.readdirSync(UPLOADS_DIR)) {
    if (f.startsWith('logo-') && f !== safeName) {
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, f));
      } catch {}
    }
  }

  updateSettings({ brand_logo_path: safeName });
  return { ok: true, path: safeName, url: `/uploads/${safeName}` };
});

fastify.delete('/api/upload/logo', async () => {
  const s = getSettings();
  if (s.brand_logo_path) {
    const fullPath = path.join(UPLOADS_DIR, path.basename(s.brand_logo_path));
    try {
      fs.unlinkSync(fullPath);
    } catch {}
  }
  updateSettings({ brand_logo_path: '' });
  return { ok: true };
});

// --- Test connections -------------------------------------------------------

fastify.post('/api/test/tautulli', async () => {
  const s = getSettings();
  try {
    const t = new TautulliClient(s.tautulli_url, s.tautulli_api_key);
    await t.ping();
    return { ok: true, message: 'Connected to Tautulli' };
  } catch (err: any) {
    return { ok: false, message: err?.message || 'Failed' };
  }
});

fastify.post('/api/test/radarr', async () => {
  const s = getSettings();
  try {
    const r = new RadarrClient(s.radarr_url, s.radarr_api_key);
    await r.ping();
    return { ok: true, message: 'Connected to Radarr' };
  } catch (err: any) {
    return { ok: false, message: err?.message || 'Failed' };
  }
});

fastify.post('/api/test/sonarr', async () => {
  const s = getSettings();
  try {
    const r = new SonarrClient(s.sonarr_url, s.sonarr_api_key);
    await r.ping();
    return { ok: true, message: 'Connected to Sonarr' };
  } catch (err: any) {
    return { ok: false, message: err?.message || 'Failed' };
  }
});

fastify.post('/api/test/smtp', async () => {
  const s = getSettings();
  return verifySmtp(s);
});

fastify.post<{ Body: { email: string } }>('/api/test/send', async (req, reply) => {
  const email = req.body?.email?.trim();
  if (!email || !/^.+@.+\..+$/.test(email)) {
    return reply.code(400).send({ error: 'Provide a valid email' });
  }
  try {
    const r = await runNewsletter({ testRecipient: email });
    return { ok: r.failed === 0, ...r };
  } catch (err: any) {
    return reply.code(500).send({ error: err?.message || 'Send failed' });
  }
});

// --- Preview ----------------------------------------------------------------

fastify.get('/api/preview', async (_req, reply) => {
  const settings = getSettings();
  try {
    const composed = await composeNewsletter(settings);
    const previewCtx = {
      unsubscribeUrl: buildPreviewUnsubscribeUrl(settings.public_url),
      name: 'Alex',
      email: 'preview@example.com'
    };
    const substituted = applySubstitutions(composed.html, previewCtx);
    const html = inlineCidImages(substituted, composed.attachments);
    reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (err: any) {
    reply.code(500).header('Content-Type', 'text/html; charset=utf-8').send(
      `<pre style="padding:24px; font-family: monospace; color: #f87171;">${escapeHtml(err?.message || String(err))}</pre>`
    );
  }
});

// --- Send-now & schedule status --------------------------------------------

fastify.post('/api/send-now', async (_req, reply) => {
  try {
    const r = await runNewsletter();
    return { ok: r.failed === 0, ...r };
  } catch (err: any) {
    return reply.code(500).send({ error: err?.message || 'Send failed' });
  }
});

fastify.get('/api/schedule', async () => getScheduleStatus());
fastify.get('/api/sendlog', async () => listSendLog(50));

// --- Broadcast (one-off email) ---------------------------------------------

interface BroadcastBody {
  subject: string;
  body_html: string;
  recipient_ids?: number[];   // when omitted/empty → all active recipients
  test_email?: string;        // when set → single test send (overrides recipient_ids)
  wrap_with_branding?: boolean;
}

function buildBroadcastRecipients(body: BroadcastBody): { recipients: SendableRecipient[]; isTest: boolean; missing?: string } {
  if (body.test_email) {
    if (!/^.+@.+\..+$/.test(body.test_email.trim())) {
      return { recipients: [], isTest: true, missing: 'Invalid test email' };
    }
    return { recipients: [{ email: body.test_email.trim() }], isTest: true };
  }

  if (body.recipient_ids && body.recipient_ids.length > 0) {
    const all = listRecipients();
    const byId = new Map(all.map((r) => [r.id, r]));
    const recipients = body.recipient_ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({ email: r.email, name: r.name, unsubscribe_token: r.unsubscribe_token }));
    return { recipients, isTest: false };
  }

  // Default: all active recipients
  const recipients = listActiveRecipients().map((r) => ({
    email: r.email,
    name: r.name,
    unsubscribe_token: r.unsubscribe_token
  }));
  return { recipients, isTest: false };
}

fastify.post<{ Body: BroadcastBody }>('/api/broadcast/preview', async (req, reply) => {
  const { subject = '', body_html = '', wrap_with_branding } = req.body || ({} as BroadcastBody);
  if (!body_html.trim()) {
    return reply.code(400).send({ error: 'Body cannot be empty' });
  }
  const settings = getSettings();
  try {
    const composed = await composeBroadcast(settings, {
      subject: subject || '(no subject)',
      bodyHtml: body_html,
      wrapWithBranding: wrap_with_branding !== false
    });
    const previewCtx = {
      unsubscribeUrl: buildPreviewUnsubscribeUrl(settings.public_url),
      name: 'Alex',
      email: 'preview@example.com'
    };
    const html = applySubstitutions(composed.html, previewCtx);
    // Rewrite any cid: references (logo) to data URIs so the iframe can render them
    const dataUriHtml = html.replace(/cid:([^"'\s)>]+)/g, (_m, cid) => {
      const a = composed.attachments.find((x) => x.cid === cid);
      return a ? `data:${a.contentType};base64,${a.content.toString('base64')}` : '';
    });
    reply.header('Content-Type', 'text/html; charset=utf-8').send(dataUriHtml);
  } catch (err: any) {
    reply.code(500).header('Content-Type', 'text/html; charset=utf-8').send(
      `<pre style="padding:24px; font-family: monospace; color: #f87171;">${escapeHtml(err?.message || String(err))}</pre>`
    );
  }
});

fastify.post<{ Body: BroadcastBody }>('/api/broadcast/send', async (req, reply) => {
  const { subject = '', body_html = '', wrap_with_branding } = req.body || ({} as BroadcastBody);
  if (!subject.trim()) return reply.code(400).send({ error: 'Subject is required' });
  if (!body_html.trim()) return reply.code(400).send({ error: 'Body cannot be empty' });

  const { recipients, isTest, missing } = buildBroadcastRecipients(req.body);
  if (missing) return reply.code(400).send({ error: missing });
  if (recipients.length === 0) return reply.code(400).send({ error: 'No recipients selected' });

  const start = Date.now();
  const settings = getSettings();
  try {
    const composed = await composeBroadcast(settings, {
      subject,
      bodyHtml: body_html,
      wrapWithBranding: wrap_with_branding !== false
    });
    const result = await sendComposed(settings, composed, recipients);
    const durationMs = Date.now() - start;
    const status: 'success' | 'partial' | 'failed' =
      result.failed === 0 ? 'success' : result.sent === 0 ? 'failed' : 'partial';
    const message =
      result.errors.length > 0
        ? `${result.sent} sent / ${result.failed} failed. ${result.errors.slice(0, 3).join('; ')}`
        : `${result.sent} sent`;

    if (!isTest) {
      logSend({
        recipient_count: recipients.length,
        status,
        message,
        duration_ms: durationMs,
        kind: 'broadcast',
        subject
      });
    }

    return { ok: result.failed === 0, ...result, recipientCount: recipients.length, durationMs, isTest };
  } catch (err: any) {
    return reply.code(500).send({ error: err?.message || 'Send failed' });
  }
});

// --- Public unsubscribe (no auth) ------------------------------------------

const unsubscribeHandler = async (req: FastifyRequest<{ Querystring: { token?: string } }>, reply: FastifyReply) => {
  const token = (req.query.token || '').trim();

  // Test sends + previews use a sentinel token so admins can click the link
  // safely without unsubscribing themselves or getting an "Invalid" page.
  if (token === PREVIEW_TOKEN) {
    reply.header('Content-Type', 'text/html; charset=utf-8').send(unsubscribePage({
      title: 'Preview link',
      body: 'This is what your recipients will see. In real emails, this link unsubscribes that specific recipient — the test/preview version is a no-op.',
      success: true
    }));
    return;
  }

  const r = findRecipientByToken(token);
  if (!r) {
    reply.code(404).header('Content-Type', 'text/html; charset=utf-8').send(unsubscribePage({
      title: 'Invalid link',
      body: "This unsubscribe link doesn't match any recipient — it may have already been used or rotated. If you keep getting unwanted emails, reply to one of them and ask the sender to remove you.",
      success: false
    }));
    return;
  }

  if (r.active) deactivateRecipient(r.id);

  reply.header('Content-Type', 'text/html; charset=utf-8').send(unsubscribePage({
    title: 'Unsubscribed',
    body: `You won't receive any more newsletters at <strong>${escapeHtml(r.email)}</strong>. If this was a mistake, ask the sender to re-enable you.`,
    success: true
  }));
};

fastify.get<{ Querystring: { token?: string } }>('/unsubscribe', unsubscribeHandler);
fastify.post<{ Querystring: { token?: string } }>('/unsubscribe', unsubscribeHandler);

// --- Boot -------------------------------------------------------------------

reloadScheduler();
fastify.listen({ host: '0.0.0.0', port: PORT }).then(() => {
  console.log(`pivo listening on http://0.0.0.0:${PORT}`);
});

// --- helpers ---

function mimeToExt(m: string): string {
  if (m === 'image/png') return '.png';
  if (m === 'image/jpeg') return '.jpg';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/svg+xml') return '.svg';
  if (m === 'image/webp') return '.webp';
  return '';
}

function inlineCidImages(html: string, attachments: { cid: string; content: Buffer; contentType: string }[]): string {
  const map = new Map<string, string>();
  for (const a of attachments) {
    map.set(a.cid, `data:${a.contentType};base64,${a.content.toString('base64')}`);
  }
  return html.replace(/cid:([^"'\s)>]+)/g, (_match, cid) => map.get(cid) || '');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unsubscribePage(opts: { title: string; body: string; success: boolean }): string {
  const accent = opts.success ? '#22c55e' : '#ef4444';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; height: 100%; background: #0e0e10; color: #f5f5f7;
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    .wrap { min-height: 100%; display: grid; place-items: center; padding: 32px; box-sizing: border-box; }
    .card { background: #16161a; border: 1px solid #2a2a30; border-radius: 12px; padding: 36px 40px; max-width: 480px; text-align: center; }
    .icon { width: 48px; height: 48px; margin: 0 auto 18px; border-radius: 50%; background: ${accent}22; color: ${accent};
      display: grid; place-items: center; font-size: 28px; font-weight: 700; }
    h1 { margin: 0 0 12px; font-size: 22px; letter-spacing: -0.02em; }
    p { margin: 0; color: #a1a1aa; font-size: 14px; line-height: 1.6; }
    strong { color: #f5f5f7; font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="icon">${opts.success ? '✓' : '!'}</div>
      <h1>${escapeHtml(opts.title)}</h1>
      <p>${opts.body}</p>
    </div>
  </div>
</body>
</html>`;
}
