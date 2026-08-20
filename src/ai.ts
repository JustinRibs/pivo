import { request } from 'undici';
import type { Settings } from './types.js';
import type { Superlative } from './email/template.js';

/**
 * AI-written copy for the newsletter.
 *
 * The model is only ever a *writer*, never a source of facts. Every number,
 * name and title it sees has already been computed from Tautulli by
 * `computeSuperlatives` / the stats pipeline; the model's job is to phrase
 * them. It never touches raw watch history, and its output is length-clamped
 * and merged back by award title, so a bad response degrades to the original
 * templated wording rather than corrupting the email.
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

export interface AiPolish {
  /** Short opener for the header, when `ai_write_intro` is on. */
  intro?: string;
  /** Awards with rewritten `detail` strings — or the originals, on any failure. */
  awards: Superlative[];
}

/** Caption/intro ceilings. Anything longer is dropped in favour of the original. */
const MAX_DETAIL = 140;
const MAX_INTRO = 420;

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

Respond with JSON only, no prose before or after.`;

/**
 * Rewrite award captions (and optionally write an intro) via the configured
 * provider. Never throws — every failure path returns the untouched awards, so
 * callers can use the result unconditionally.
 */
export async function polishNewsletter(
  settings: Settings,
  awards: Superlative[],
  ctx: AiContext
): Promise<AiPolish> {
  if (!settings.enable_ai_captions) return { awards };
  if (!settings.ai_model) {
    console.warn('AI copy is enabled but ai_model is empty — skipping.');
    return { awards };
  }

  const wantIntro = !!settings.ai_write_intro;
  if (awards.length === 0 && !wantIntro) return { awards };

  try {
    const raw = await chat(settings, SYSTEM_PROMPT, buildUserPrompt(settings, awards, ctx, wantIntro));
    const parsed = parseJsonResponse(raw);
    if (!parsed) {
      console.warn('AI copy: could not parse a JSON object from the response — keeping original wording.');
      return { awards };
    }
    return {
      intro: wantIntro ? clean(parsed.intro, MAX_INTRO) : undefined,
      awards: mergeCaptions(awards, parsed.captions)
    };
  } catch (err) {
    console.warn('AI copy failed — keeping original wording:', err);
    return { awards };
  }
}

function buildUserPrompt(
  settings: Settings,
  awards: Superlative[],
  ctx: AiContext,
  wantIntro: boolean
): string {
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

  const shape: string[] = [];
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
  parts.push(`Respond with exactly this JSON shape:\n{\n${shape.join(',\n')}\n}`);

  const extra = (settings.ai_extra_instructions || '').trim();
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
function parseJsonResponse(raw: string): { intro?: unknown; captions?: unknown } | null {
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

async function chat(settings: Settings, system: string, user: string): Promise<string> {
  const provider = (settings.ai_provider || 'openai') as AiProvider;
  const timeout = Number(settings.ai_timeout_ms) > 0 ? Number(settings.ai_timeout_ms) : 30_000;

  switch (provider) {
    case 'anthropic':
      return anthropicChat(settings, system, user, timeout);
    case 'ollama':
      return ollamaChat(settings, system, user, timeout);
    default:
      return openAiChat(settings, system, user, timeout);
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
async function openAiChat(settings: Settings, system: string, user: string, timeout: number): Promise<string> {
  const key = (settings.ai_api_key || '').trim();
  const json = await post(
    `${baseUrlFor(settings, 'openai')}/chat/completions`,
    key ? { authorization: `Bearer ${key}` } : {},
    {
      model: settings.ai_model,
      max_tokens: 1024,
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
  return content;
}

/** Anthropic Messages API. */
async function anthropicChat(settings: Settings, system: string, user: string, timeout: number): Promise<string> {
  const key = (settings.ai_api_key || '').trim();
  if (!key) throw new Error('Anthropic requires an API key');

  const json = await post(
    `${baseUrlFor(settings, 'anthropic')}/v1/messages`,
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    {
      model: settings.ai_model,
      max_tokens: 1024,
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
  return text;
}

/**
 * Ollama's native `/api/chat`. Preferred over its OpenAI shim because it
 * exposes `keep_alive` — pivo sends `0s` so the model unloads from VRAM the
 * moment the newsletter is composed, rather than sitting on a GPU that may
 * also be doing Plex transcodes.
 */
async function ollamaChat(settings: Settings, system: string, user: string, timeout: number): Promise<string> {
  const json = await post(
    `${baseUrlFor(settings, 'ollama')}/api/chat`,
    {},
    {
      model: settings.ai_model,
      stream: false,
      format: 'json',
      keep_alive: (settings.ai_ollama_keep_alive || '0s').trim() || '0s',
      options: { temperature: 0.8 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    },
    timeout
  );
  const content = json?.message?.content;
  if (typeof content !== 'string') throw new Error('AI response had no message content');
  return content;
}
