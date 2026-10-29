// SK — the student kit player's language session (2026-10-30).
//
// The kit turn (/api/sk/kit/turn) keeps no conversation, but "say that in
// Malay" needs SK's LAST explanation and "keeps answering in Malay" needs the
// choice to outlive the turn. Both travel with the client as a small signed
// note, exactly like the Shell's memory blob (shell/memory.ts): the `done`
// event returns it, the next turn echoes it; the server verifies the HMAC, the
// user, the kit and a 4-hour gap, and anything else simply starts afresh.
//
// It holds: the last explanation (≤ 4 000 characters, the language it was said
// in, the section it was about), the override, and the unsupported source
// language SK already mentioned. No question text, no other learner.
//
// Server-only by use (memory.ts's secret and hashes).

import { base64UrlDecode, base64UrlEncode, hmacHex, safeEqualHex } from "./shell/hash";
import { isAnswerLang, type SkAnswerLang } from "./shell/language";
import { SK_MEMORY_GAP_MS, SK_MEMORY_LAST_ANSWER_CHARS, memorySecret } from "./shell/memory";

export type KitLangState = {
  v: 1;
  uid: string;
  /** product/chapter the note was issued for. */
  scope: string;
  at: string;
  last?: { text: string; lang: SkAnswerLang; segment: string };
  override?: SkAnswerLang;
  noted?: string;
};

const SEGMENT_RE = /^p\d{1,3}:[A-Za-z0-9_.-]{1,64}$/;

export function kitLangScope(product: string, chapter: string): string {
  return `${product}/${chapter}`.slice(0, 160);
}

export function freshKitLang(uid: string, scope: string, now: Date): KitLangState {
  return { v: 1, uid, scope, at: now.toISOString() };
}

export function sealKitLang(st: KitLangState): string {
  const payload = base64UrlEncode(JSON.stringify(st));
  return `${payload}.${hmacHex(memorySecret(), `kitlang:${payload}`)}`;
}

/** The verified note for this user and kit scope, else a fresh one. */
export function openKitLang(blob: unknown, uid: string, scope: string, now: Date): KitLangState {
  const fresh = freshKitLang(uid, scope, now);
  if (typeof blob !== "string" || !blob || blob.length > 24_000) return fresh;
  const dot = blob.lastIndexOf(".");
  if (dot <= 0) return fresh;
  const payload = blob.slice(0, dot);
  if (!safeEqualHex(hmacHex(memorySecret(), `kitlang:${payload}`), blob.slice(dot + 1))) return fresh;
  try {
    const raw = JSON.parse(base64UrlDecode(payload) ?? "") as Record<string, unknown>;
    if (!raw || raw.v !== 1 || raw.uid !== uid || raw.scope !== scope || typeof raw.at !== "string") return fresh;
    const at = Date.parse(raw.at);
    if (!Number.isFinite(at) || now.getTime() - at > SK_MEMORY_GAP_MS || at - now.getTime() > 60_000) return fresh;
    const out: KitLangState = { v: 1, uid, scope, at: raw.at };
    const last = raw.last as Record<string, unknown> | undefined;
    if (last && typeof last.text === "string" && last.text.trim() && isAnswerLang(last.lang) && typeof last.segment === "string" && SEGMENT_RE.test(last.segment)) {
      out.last = { text: last.text.slice(0, SK_MEMORY_LAST_ANSWER_CHARS), lang: last.lang, segment: last.segment };
    }
    if (isAnswerLang(raw.override)) out.override = raw.override;
    if (typeof raw.noted === "string" && raw.noted.length <= 40) out.noted = raw.noted;
    return out;
  } catch {
    return fresh;
  }
}
