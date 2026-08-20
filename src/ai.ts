import crypto from 'node:crypto';
import { request } from 'undici';
import type { Settings } from './types.js';
import type { Superlative } from './email/template.js';
import { getAiUsageSummary, lookupAiCache, recordAiUsage, saveAiCache } from './db.js';

/**
 * AI-written copy for the newsletter.
 *
 * The model is only ever a *writer*, never a source of facts. Every number,
 * name and title it sees has already been computed from Tautulli by
 * `computeSuperlatives` / the stats pipeline; the model's job is to phrase
 * them. It never touches raw watch history, and its output is length-clamped
 * and merged back by award title, so a bad response degrades to the original
 * templated wording rather than corrupting the email.
 *
 * Cost is bounded from three directions: prompt inputs are clamped so a large
 * library can't inflate a request, identical requests are served from
 * `ai_cache` (the preview recomposes on every page load), and rolling
 * call/token caps are checked before anything is sent. A capped call is
 * indistinguishable from a failed one — you get the templated wording.
 */

/**
 * Supported backends. `openai` speaks the OpenAI `/chat/completions` shape,
 * which covers OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, vLLM,
 * LM Studio, llama.cpp's server, and Ollama's own `/v1` compatibility layer —
 * so most providers need no code, just a base URL.
 */
export type AiProvider = 'openai' | 'anthropic' | 'ollama';

/** Computed, already-correct facts about the period, handed to the model as context. */
export interface AiContext {
  windowDays: number;
  totalPlays?: number;
  /** Pre-formatted, e.g. "2 days 3 hrs". */
  totalDuration?: string;
  newMovies: number;
  newShows: number;
  newMusic: number;
}

/**
 * A recently-added item whose Plex synopsis we want compressed. `summary` is
 * the studio blurb — the model rewrites *this text*, it is never asked what the
 * title is about.
 */
export interface AiSummaryItem {
  /** Short stable handle (`m1`, `a2`) used to match the rewrite back. */
  id: string;
  kind: 'movie' | 'album';
  title: string;
  year?: string;
  summary: string;
}

export interface AiPolish {
  /** Short opener for the header, when `ai_write_intro` is on. */
  intro?: string;
  /** Email subject line, when `ai_write_subject` is on. */
  subject?: string;
  /** Inbox preview text shown next to the subject, when `ai_write_subject` is on. */
  preheader?: string;
  /** Awards with rewritten `detail` strings — or the originals, on any failure. */
  awards: Superlative[];
  /** Rewritten blurbs keyed by `AiSummaryItem.id`. Missing ids keep their original. */
  summaries: Record<string, string>;
}

/** Caption/intro ceilings. Anything longer is dropped in favour of the original. */
const MAX_DETAIL = 140;
const MAX_INTRO = 420;
/** Long subjects get truncated by the client anyway; keep it inbox-safe. */
const MAX_SUBJECT = 78;
const MAX_PREHEADER = 140;
/** Matches `shortSummary`'s ceiling in the template, so a rewrite renders whole. */
const MAX_SUMMARY = 110;

/**
 * Input clamps. These bound what we *send*, which the provider bills for just
 * as it bills output. `computeSuperlatives` is free to grow the award list and
 * the tone direction is a free-form textarea, so neither can be trusted to
 * stay small on its own.
 */
const MAX_AWARDS = 12;
const MAX_EXTRA_INSTRUCTIONS = 600;
/** Blurb rewriting is the one feature that meaningfully grows the prompt. */
const MAX_SUMMARY_ITEMS = 12;
const MAX_SUMMARY_INPUT = 300;

/** Output ceiling when `ai_max_output_tokens` is unset or nonsensical. */
const DEFAULT_MAX_OUTPUT_TOKENS = 700;

/**
 * Circuit breaker. Failures deliberately don't count against the spend caps —
 * a 500 or a refused connection costs nothing, and shouldn't burn budget on
 * top of being broken. But a *timeout* is different: the provider may well have
 * generated (and billed) the response we gave up waiting for. So after this
 * many failures in an hour we stop trying until the hour rolls off, which also
 * spares a misconfigured endpoint from being hammered on every compose.
 */
const ERROR_BREAKER_THRESHOLD = 5;

/** Which code path asked for the copy — recorded so preview spend is visible. */
export type AiCallSource = 'send' | 'preview' | 'test';

interface TokenUsage {
  prompt: number;
  completion: number;
}

interface ChatResult {
  text: string;
  usage: TokenUsage;
}

/** Rough fallback when a provider doesn't report usage. Deliberately pessimistic. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const DEFAULT_BASE_URLS: Record<AiProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://127.0.0.1:11434'
};

const SYSTEM_PROMPT = `You write short, playful copy for a self-hosted Plex server's weekly email newsletter, sent by its owner to friends and family.

Hard rules:
- Every number, name, and title in the input is already correct. Reuse them exactly as given. Never invent or alter a number, person, show, or movie, and never add facts you were not given.
- Warm and teasing, never mean. These are the owner's friends — gentle ribbing only.
- Plain text only. No emoji, no markdown, no HTML, no quotation marks around the whole line.
- Vary the sentence shapes. Do not start every caption the same way.
- When rewriting a synopsis, work only from the synopsis text you were given. Do not use anything you happen to know about the title, and do not add plot, cast, or opinion that is not in that text. If a synopsis is too thin to compress, return it close to as-is rather than filling the gap.

Respond with JSON only, no prose before or after.`;

/**
 * Rewrite award captions (and optionally write an intro) via the configured
 * provider. Never throws — every failure path returns the untouched awards, so
 * callers can use the result unconditionally.
 */
export async function polishNewsletter(
  settings: Settings,
  awards: Superlative[],
  ctx: AiContext,
  opts: { source?: AiCallSource; items?: AiSummaryItem[] } = {}
): Promise<AiPolish> {
  const nothing: AiPolish = { awards, summaries: {} };
  if (!settings.enable_ai_captions) return nothing;
  if (!settings.ai_model) {
    console.warn('AI copy is enabled but ai_model is empty — skipping.');
    return nothing;
  }

  const wantIntro = !!settings.ai_write_intro;
  const wantSubject = !!settings.ai_write_subject;
  // Only the first MAX_AWARDS are described; the rest keep their templated
  // caption. mergeCaptions matches by title, so the tail is unaffected.
  const described = awards.slice(0, MAX_AWARDS);
  const items = settings.ai_rewrite_summaries ? (opts.items ?? []).slice(0, MAX_SUMMARY_ITEMS) : [];
  if (described.length === 0 && items.length === 0 && !wantIntro && !wantSubject) return nothing;

  const source = opts.source ?? 'send';
  const provider = providerOf(settings);
  const model = settings.ai_model;
  const maxOutputTokens = outputCeiling(settings);
  const user = buildUserPrompt(settings, described, ctx, { wantIntro, wantSubject, items });
  const hash = requestHash(settings, provider, SYSTEM_PROMPT, user, maxOutputTokens);

  let raw: string;
  const cached = lookupAiCache(hash, Number(settings.ai_cache_ttl_min) || 0);
  if (cached !== undefined) {
    recordAiUsage({ source, provider, model, prompt_tokens: 0, completion_tokens: 0, status: 'cache' });
    raw = cached;
  } else {
    const denial = checkSpendCaps(settings);
    if (denial) {
      console.warn(`AI copy skipped — ${denial}. Keeping original wording.`);
      recordAiUsage({ source, provider, model, prompt_tokens: 0, completion_tokens: 0, status: 'blocked' });
      return nothing;
    }

    let result: ChatResult;
    try {
      result = await chat(settings, SYSTEM_PROMPT, user, maxOutputTokens);
    } catch (err) {
      // Recorded but not billed against the caps — a failed request produced
      // no usable output, and shouldn't burn budget on top of that.
      recordAiUsage({ source, provider, model, prompt_tokens: 0, completion_tokens: 0, status: 'error' });
      console.warn('AI copy failed — keeping original wording:', err);
      return nothing;
    }

    recordAiUsage({
      source,
      provider,
      model,
      prompt_tokens: result.usage.prompt,
      completion_tokens: result.usage.completion,
      status: 'ok'
    });
    saveAiCache(hash, result.text);
    raw = result.text;
  }

  const parsed = parseJsonResponse(raw);
  if (!parsed) {
    console.warn('AI copy: could not parse a JSON object from the response — keeping original wording.');
    return nothing;
  }
  return {
    intro: wantIntro ? clean(parsed.intro, MAX_INTRO) : undefined,
    subject: wantSubject ? clean(parsed.subject, MAX_SUBJECT) : undefined,
    preheader: wantSubject ? clean(parsed.preheader, MAX_PREHEADER) : undefined,
    awards: mergeCaptions(awards, parsed.captions),
    summaries: items.length > 0 ? mergeSummaries(items, parsed.summaries) : {}
  };
}

/**
 * Pick rewritten blurbs out of the response, keyed by the id we handed over.
 * Unknown ids are dropped and unusable text is skipped, so anything missing
 * simply keeps the original Plex synopsis.
 */
function mergeSummaries(items: AiSummaryItem[], summaries: unknown): Record<string, string> {
  if (!Array.isArray(summaries)) return {};
  const known = new Set(items.map((i) => i.id));
  const out: Record<string, string> = {};
  for (const entry of summaries) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as any).id;
    const text = clean((entry as any).text, MAX_SUMMARY);
    if (typeof id === 'string' && known.has(id) && text) out[id] = text;
  }
  return out;
}

function providerOf(settings: Settings): AiProvider {
  const p = (settings.ai_provider || 'openai') as AiProvider;
  return p === 'anthropic' || p === 'ollama' ? p : 'openai';
}

function outputCeiling(settings: Settings): number {
  const n = Number(settings.ai_max_output_tokens);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_OUTPUT_TOKENS;
  // 4096 is plenty for a handful of one-line captions; anything more is a typo.
  return Math.min(Math.round(n), 4096);
}

/**
 * Identity of a request for caching purposes. Everything that could change the
 * response goes in — including the base URL, so pointing at a different
 * endpoint doesn't serve you the old provider's answer.
 */
function requestHash(
  settings: Settings,
  provider: AiProvider,
  system: string,
  user: string,
  maxOutputTokens: number
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([provider, baseUrlFor(settings, provider), settings.ai_model, system, user, maxOutputTokens]))
    .digest('hex');
}

/**
 * Returns a human-readable reason when a cap is already met, or null to proceed.
 * Checked immediately before the request so concurrent composes can overshoot by
 * at most one call — acceptable for a single-owner newsletter, and far simpler
 * than holding a lock across a 30-second HTTP request.
 */
function checkSpendCaps(settings: Settings): string | null {
  const callCap = Math.max(0, Math.round(Number(settings.ai_daily_call_cap) || 0));
  const tokenCap = Math.max(0, Math.round(Number(settings.ai_monthly_token_cap) || 0));

  const usage = getAiUsageSummary();
  if (usage.errorsLastHour >= ERROR_BREAKER_THRESHOLD) {
    return `${usage.errorsLastHour} failures in the last hour — backing off until they age out`;
  }
  if (callCap > 0 && usage.callsLast24h >= callCap) {
    return `daily cap reached (${usage.callsLast24h}/${callCap} billed calls in the last 24h)`;
  }
  if (tokenCap > 0 && usage.tokensLast30d >= tokenCap) {
    return `token cap reached (${usage.tokensLast30d.toLocaleString()}/${tokenCap.toLocaleString()} tokens in the last 30 days)`;
  }
  return null;
}

function buildUserPrompt(
  settings: Settings,
  awards: Superlative[],
  ctx: AiContext,
  want: { wantIntro: boolean; wantSubject: boolean; items: AiSummaryItem[] }
): string {
  const { wantIntro, wantSubject, items } = want;
  const facts = [
    `Period: the last ${ctx.windowDays} day(s).`,
    ctx.totalPlays !== undefined ? `Total plays: ${ctx.totalPlays}.` : '',
    ctx.totalDuration ? `Total watch time: ${ctx.totalDuration}.` : '',
    `Newly added: ${ctx.newMovies} movie(s), ${ctx.newShows} show(s), ${ctx.newMusic} album(s).`
  ]
    .filter(Boolean)
    .join('\n');

  const awardLines = awards
    .map((a, i) => `${i + 1}. title="${a.title}" winner="${a.name}" facts="${a.detail}"`)
    .join('\n');

  const parts = [`Facts for this edition (all already verified):\n${facts}`];

  if (awards.length > 0) {
    parts.push(
      `Awards to caption. For each, rewrite ONLY the supporting caption. Keep the winner's name out of the caption (it is displayed separately), and preserve every number from "facts" exactly. Max ${MAX_DETAIL} characters each.\n${awardLines}`
    );
  }

  if (items.length > 0) {
    const itemLines = items
      .map(
        (i) =>
          `${i.id} [${i.kind}] "${i.title}"${i.year ? ` (${i.year})` : ''}\n   synopsis: ${i.summary.slice(0, MAX_SUMMARY_INPUT)}`
      )
      .join('\n');
    parts.push(
      `Newly added items. Compress each synopsis below into one punchy line that makes someone want to press play. ` +
        `Use ONLY what the synopsis says — no plot, cast, rating or trivia from your own knowledge, and no spoilers beyond what is already there. ` +
        `Do not repeat the title in the line (it is displayed above). Max ${MAX_SUMMARY} characters each, and it must be a complete sentence, not a truncation.\n${itemLines}`
    );
  }

  const shape: string[] = [];
  if (wantSubject) {
    shape.push(
      `  "subject": "Email subject line for this edition. Name the single most interesting thing in it — a specific title or a standout number from the facts above. No date, no 'Newsletter', no clickbait. Max ${MAX_SUBJECT} characters."`
    );
    shape.push(
      `  "preheader": "The preview line shown next to the subject in an inbox. Complements the subject rather than repeating it. Max ${MAX_PREHEADER} characters."`
    );
  }
  if (wantIntro) {
    shape.push(
      `  "intro": "2-3 sentences opening the newsletter, summarising the period using only the facts above. Max ${MAX_INTRO} characters."`
    );
  }
  if (awards.length > 0) {
    shape.push(
      `  "captions": [{ "title": "<exact award title from the list>", "detail": "<rewritten caption>" }]`
    );
  }
  if (items.length > 0) {
    shape.push(`  "summaries": [{ "id": "<exact id from the item list>", "text": "<rewritten line>" }]`);
  }
  parts.push(`Respond with exactly this JSON shape:\n{\n${shape.join(',\n')}\n}`);

  const extra = (settings.ai_extra_instructions || '').trim().slice(0, MAX_EXTRA_INSTRUCTIONS);
  if (extra) parts.push(`Additional style direction from the server owner:\n${extra}`);

  return parts.join('\n\n');
}

/** Lenient key for matching a model-echoed award title back to ours. */
function titleKey(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Merge model captions back onto awards, matched by normalised title. */
function mergeCaptions(awards: Superlative[], captions: unknown): Superlative[] {
  if (!Array.isArray(captions)) return awards;

  const byTitle = new Map<string, string>();
  for (const c of captions) {
    if (!c || typeof c !== 'object') continue;
    const title = (c as any).title;
    const detail = clean((c as any).detail, MAX_DETAIL);
    if (typeof title === 'string' && detail) byTitle.set(titleKey(title), detail);
  }
  if (byTitle.size === 0) return awards;

  return awards.map((a) => {
    const next = byTitle.get(titleKey(a.title));
    return next ? { ...a, detail: next } : a;
  });
}

/**
 * Normalise a model-authored string: collapse whitespace, strip stray wrapping
 * quotes and any tag-like content, and enforce the length ceiling. Returns
 * undefined when the value is unusable, which callers treat as "keep original".
 */
function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  let s = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 1 && /^["'](.*)["']$/.test(s)) s = s.slice(1, -1).trim();
  if (!s || s.length > max) return undefined;
  return s;
}

/**
 * Pull a JSON object out of a model response. Handles bare JSON, ```json
 * fences, and leading/trailing chatter from models that ignore the instruction.
 */
function parseJsonResponse(
  raw: string
): { intro?: unknown; subject?: unknown; preheader?: unknown; captions?: unknown; summaries?: unknown } | null {
  const text = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const candidates = [text];

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// --- Providers ---------------------------------------------------------------

function baseUrlFor(settings: Settings, provider: AiProvider): string {
  const configured = (settings.ai_base_url || '').trim().replace(/\/+$/, '');
  return configured || DEFAULT_BASE_URLS[provider];
}

async function chat(
  settings: Settings,
  system: string,
  user: string,
  maxOutputTokens: number
): Promise<ChatResult> {
  const provider = providerOf(settings);
  const timeout = Number(settings.ai_timeout_ms) > 0 ? Number(settings.ai_timeout_ms) : 30_000;

  switch (provider) {
    case 'anthropic':
      return anthropicChat(settings, system, user, timeout, maxOutputTokens);
    case 'ollama':
      return ollamaChat(settings, system, user, timeout, maxOutputTokens);
    default:
      return openAiChat(settings, system, user, timeout, maxOutputTokens);
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeout: number) {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    headersTimeout: timeout,
    bodyTimeout: timeout
  });
  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`AI request failed: HTTP ${res.statusCode} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

/** OpenAI-compatible `/chat/completions` — the generic path for most providers. */
async function openAiChat(
  settings: Settings,
  system: string,
  user: string,
  timeout: number,
  maxOutputTokens: number
): Promise<ChatResult> {
  const key = (settings.ai_api_key || '').trim();
  const json = await post(
    `${baseUrlFor(settings, 'openai')}/chat/completions`,
    key ? { authorization: `Bearer ${key}` } : {},
    {
      model: settings.ai_model,
      max_tokens: maxOutputTokens,
      temperature: 0.8,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    },
    timeout
  );
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('AI response had no message content');
  return {
    text: content,
    usage: {
      prompt: Number(json?.usage?.prompt_tokens) || estimateTokens(system + user),
      completion: Number(json?.usage?.completion_tokens) || estimateTokens(content)
    }
  };
}

/** Anthropic Messages API. */
async function anthropicChat(
  settings: Settings,
  system: string,
  user: string,
  timeout: number,
  maxOutputTokens: number
): Promise<ChatResult> {
  const key = (settings.ai_api_key || '').trim();
  if (!key) throw new Error('Anthropic requires an API key');

  const json = await post(
    `${baseUrlFor(settings, 'anthropic')}/v1/messages`,
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    {
      model: settings.ai_model,
      max_tokens: maxOutputTokens,
      system,
      messages: [{ role: 'user', content: user }]
    },
    timeout
  );
  const text = (json?.content || [])
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('AI response had no text content');
  return {
    text,
    usage: {
      prompt: Number(json?.usage?.input_tokens) || estimateTokens(system + user),
      completion: Number(json?.usage?.output_tokens) || estimateTokens(text)
    }
  };
}

/**
 * Ollama's native `/api/chat`. Preferred over its OpenAI shim because it
 * exposes `keep_alive` — pivo sends `0s` so the model unloads from VRAM the
 * moment the newsletter is composed, rather than sitting on a GPU that may
 * also be doing Plex transcodes.
 */
async function ollamaChat(
  settings: Settings,
  system: string,
  user: string,
  timeout: number,
  maxOutputTokens: number
): Promise<ChatResult> {
  const json = await post(
    `${baseUrlFor(settings, 'ollama')}/api/chat`,
    {},
    {
      model: settings.ai_model,
      stream: false,
      format: 'json',
      keep_alive: (settings.ai_ollama_keep_alive || '0s').trim() || '0s',
      options: { temperature: 0.8, num_predict: maxOutputTokens },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    },
    timeout
  );
  const content = json?.message?.content;
  if (typeof content !== 'string') throw new Error('AI response had no message content');
  // Local models cost nothing to run, but the counts still make the usage panel
  // useful for spotting a runaway prompt.
  return {
    text: content,
    usage: {
      prompt: Number(json?.prompt_eval_count) || estimateTokens(system + user),
      completion: Number(json?.eval_count) || estimateTokens(content)
    }
  };
}
