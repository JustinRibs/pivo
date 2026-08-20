import nodemailer, { type Transporter } from 'nodemailer';
import { getSettings, listActiveRecipients, logSend } from '../db.js';
import { composeNewsletter } from './compose.js';
import type { ComposedNewsletter, Recipient, Settings } from '../types.js';

export const PREVIEW_TOKEN = '__preview__';

export function buildUnsubscribeUrl(publicUrl: string, token: string): string {
  if (!publicUrl || !token) return '';
  const base = publicUrl.replace(/\/+$/, '');
  return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function buildPreviewUnsubscribeUrl(publicUrl: string): string {
  if (!publicUrl) return '#preview';
  const base = publicUrl.replace(/\/+$/, '');
  return `${base}/unsubscribe?token=${PREVIEW_TOKEN}`;
}

export interface SubstitutionContext {
  unsubscribeUrl: string;
  name?: string;
  email?: string;
  /** Falls back to "there" when the recipient has no name set. */
  nameFallback?: string;
}

/**
 * Apply per-recipient placeholder substitutions to a subject / HTML / text body.
 * Supported tokens: {{name}}, {{first_name}}, {{email}}, {{unsubscribe_url}}, {{UNSUBSCRIBE_URL}}.
 * Whitespace inside the braces is tolerated.
 */
export function applySubstitutions(text: string, ctx: SubstitutionContext): string {
  const fallback = ctx.nameFallback ?? 'there';
  const fullName = (ctx.name || '').trim();
  const firstName = fullName.split(/\s+/)[0] || '';
  const replacements: Array<[RegExp, string]> = [
    [/\{\{\s*UNSUBSCRIBE_URL\s*\}\}/g, ctx.unsubscribeUrl],
    [/\{\{\s*unsubscribe_url\s*\}\}/g, ctx.unsubscribeUrl],
    [/\{\{\s*first_name\s*\}\}/g, firstName || fallback],
    [/\{\{\s*name\s*\}\}/g, fullName || fallback],
    [/\{\{\s*email\s*\}\}/g, ctx.email || '']
  ];
  return replacements.reduce((acc, [re, val]) => acc.replace(re, val), text);
}

export function buildTransporter(s: Settings): Transporter {
  return nodemailer.createTransport({
    host: s.smtp_host,
    port: s.smtp_port,
    secure: !!s.smtp_secure,
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
    pool: true,
    maxConnections: 3
  });
}

export async function verifySmtp(s: Settings): Promise<{ ok: boolean; message: string }> {
  try {
    const t = buildTransporter(s);
    await t.verify();
    t.close();
    return { ok: true, message: 'SMTP connection OK' };
  } catch (err: any) {
    return { ok: false, message: err?.message || String(err) };
  }
}

export interface SendableRecipient {
  email: string;
  name?: string;
  unsubscribe_token?: string;
}

export async function sendComposed(
  s: Settings,
  composed: ComposedNewsletter,
  recipients: SendableRecipient[]
): Promise<{ sent: number; failed: number; errors: string[] }> {
  const transporter = buildTransporter(s);
  const fromAddr = s.smtp_from_email || s.smtp_user;
  const from = s.smtp_from_name ? `"${s.smtp_from_name}" <${fromAddr}>` : fromAddr;

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  // Send individually so one bad address doesn't poison the batch and so each
  // message gets its own per-recipient unsubscribe URL + name substitutions.
  for (const r of recipients) {
    const to = r.name ? `"${r.name}" <${r.email}>` : r.email;
    const realUnsubUrl = buildUnsubscribeUrl(s.public_url, r.unsubscribe_token || '');
    const substituteUrl = realUnsubUrl || buildPreviewUnsubscribeUrl(s.public_url);

    const subCtx: SubstitutionContext = {
      unsubscribeUrl: substituteUrl,
      name: r.name,
      email: r.email
    };
    const subject = applySubstitutions(composed.subject, subCtx);
    const html = applySubstitutions(composed.html, subCtx);
    const text = applySubstitutions(composed.text, subCtx);

    const headers: Record<string, string> = {};
    if (realUnsubUrl) {
      // RFC 2369 + RFC 8058 (one-click unsubscribe). Only set headers for real
      // recipients — test sends shouldn't auto-unsubscribe via Gmail's button.
      headers['List-Unsubscribe'] = `<${realUnsubUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    try {
      await transporter.sendMail({
        from,
        to,
        subject,
        html,
        text,
        headers,
        attachments: composed.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          cid: a.cid
        }))
      });
      sent += 1;
    } catch (err: any) {
      failed += 1;
      errors.push(`${r.email}: ${err?.message || err}`);
    }
  }

  transporter.close();
  return { sent, failed, errors };
}

export async function runNewsletter(opts: { dryRun?: boolean; testRecipient?: string } = {}): Promise<{ sent: number; failed: number; errors: string[]; recipientCount: number; durationMs: number }> {
  const start = Date.now();
  const settings = getSettings();
  const composed = await composeNewsletter(settings, { aiSource: opts.testRecipient ? 'test' : 'send' });

  let recipients: SendableRecipient[];
  if (opts.testRecipient) {
    recipients = [{ email: opts.testRecipient }];
  } else {
    recipients = listActiveRecipients().map((r: Recipient) => ({
      email: r.email,
      name: r.name,
      unsubscribe_token: r.unsubscribe_token
    }));
  }

  if (recipients.length === 0) {
    const dur = Date.now() - start;
    if (!opts.dryRun) logSend({ recipient_count: 0, status: 'failed', message: 'No active recipients', duration_ms: dur, kind: 'newsletter', subject: composed.subject });
    return { sent: 0, failed: 0, errors: ['No active recipients'], recipientCount: 0, durationMs: dur };
  }

  if (opts.dryRun) {
    const dur = Date.now() - start;
    return { sent: 0, failed: 0, errors: [], recipientCount: recipients.length, durationMs: dur };
  }

  const result = await sendComposed(settings, composed, recipients);
  const durationMs = Date.now() - start;
  const status: 'success' | 'partial' | 'failed' =
    result.failed === 0 ? 'success' : result.sent === 0 ? 'failed' : 'partial';
  const message =
    result.errors.length > 0
      ? `${result.sent} sent / ${result.failed} failed. ${result.errors.slice(0, 3).join('; ')}`
      : `${result.sent} sent`;

  // Don't log "test" sends as part of the regular history if it was a single test recipient.
  if (!opts.testRecipient) {
    logSend({ recipient_count: recipients.length, status, message, duration_ms: durationMs, kind: 'newsletter', subject: composed.subject });
  }

  return { ...result, recipientCount: recipients.length, durationMs };
}
