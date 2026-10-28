// SK Shell — the signed conversation memory (Final Plan §5.4, §9.5).
//
// Serverless instances share nothing between requests, so the conversation's
// short-term memory (recent entities, a pending task, the last turns) travels
// with the client as an opaque, HMAC-signed blob: the `done` event returns it,
// the next turn echoes it. The server verifies the signature, the context hash
// (hat / school / role / plan unchanged) and the 4-hour gap; anything else
// simply starts a fresh conversation — never an error.

import type { ResolvedEntity, SkContext } from "./types";
import { base64UrlDecode, base64UrlEncode, hmacHex, randomHex, safeEqualHex } from "./hash";

export const SK_MEMORY_VERSION = 1 as const;
export const SK_MEMORY_MAX_ENTITIES = 10;
export const SK_MEMORY_MAX_TURNS = 6;
export const SK_MEMORY_TURN_CHARS = 400;
export const SK_MEMORY_GAP_MS = 4 * 60 * 60 * 1000;

export type SkMemoryTurn = { role: "user" | "assistant"; text: string };

export type SkMemory = {
  v: typeof SK_MEMORY_VERSION;
  sessionId: string;
  contextHash: string;
  issuedAt: string;
  lastAt: string;
  entities: ResolvedEntity[];
  pending?: { task: string; needs: string[] };
  turns: SkMemoryTurn[];
};

let processSecret: string | null = null;
let warned = false;

/** SK_SHELL_SECRET, else BOOK_CODE_SECRET, else a per-process random (memory
 *  then survives only on the same instance; logged once). */
export function memorySecret(): string {
  const env = process.env.SK_SHELL_SECRET || process.env.BOOK_CODE_SECRET;
  if (env && env.length >= 16) return env;
  if (!processSecret) {
    processSecret = randomHex(32);
    if (!warned) {
      warned = true;
      console.warn("sk-shell: SK_SHELL_SECRET/BOOK_CODE_SECRET unset — conversation memory will not survive across instances");
    }
  }
  return processSecret;
}

export function freshMemory(ctx: SkContext, now: Date): SkMemory {
  const at = now.toISOString();
  return { v: SK_MEMORY_VERSION, sessionId: randomHex(12), contextHash: ctx.contextHash, issuedAt: at, lastAt: at, entities: [], turns: [] };
}

export function sealMemory(mem: SkMemory): string {
  const payload = base64UrlEncode(JSON.stringify(mem));
  return `${payload}.${hmacHex(memorySecret(), payload)}`;
}

/** Verify + decode; null when the blob is missing, malformed or forged. */
export function verifyMemory(blob: string | null | undefined): SkMemory | null {
  if (!blob || typeof blob !== "string" || blob.length > 64_000) return null;
  const dot = blob.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = blob.slice(0, dot);
  const sig = blob.slice(dot + 1);
  if (!safeEqualHex(hmacHex(memorySecret(), payload), sig)) return null;
  const json = base64UrlDecode(payload);
  if (!json) return null;
  try {
    const m = JSON.parse(json) as SkMemory;
    if (!m || m.v !== SK_MEMORY_VERSION || typeof m.sessionId !== "string" || typeof m.contextHash !== "string") return null;
    if (typeof m.lastAt !== "string" || typeof m.issuedAt !== "string") return null;
    return { ...m, entities: Array.isArray(m.entities) ? m.entities : [], turns: Array.isArray(m.turns) ? m.turns : [] };
  } catch {
    return null;
  }
}

export type OpenMemoryResult = { memory: SkMemory; fresh: boolean; reason: "none" | "ok" | "invalid" | "context_changed" | "gap" };

/** The verified memory when it still applies, else a fresh one (§5.4
 *  invalidation: hat, school, role or plan change via the context hash, and a
 *  gap over four hours). */
export function openMemory(blob: string | null | undefined, ctx: SkContext, now: Date): OpenMemoryResult {
  if (!blob) return { memory: freshMemory(ctx, now), fresh: true, reason: "none" };
  const m = verifyMemory(blob);
  if (!m) return { memory: freshMemory(ctx, now), fresh: true, reason: "invalid" };
  if (m.contextHash !== ctx.contextHash) return { memory: freshMemory(ctx, now), fresh: true, reason: "context_changed" };
  const last = Date.parse(m.lastAt);
  if (!Number.isFinite(last) || now.getTime() - last > SK_MEMORY_GAP_MS || last - now.getTime() > 60_000) {
    return { memory: freshMemory(ctx, now), fresh: true, reason: "gap" };
  }
  return { memory: m, fresh: false, reason: "ok" };
}

/** Append a turn pair and merge entities (newest first, de-duplicated by
 *  kind+id, capped). Returns a new memory; never mutates. */
export function rememberTurn(
  mem: SkMemory,
  turn: { user: string; assistant: string; entities?: ResolvedEntity[]; pending?: SkMemory["pending"] | null },
  now: Date,
): SkMemory {
  const seen = new Set<string>();
  const entities: ResolvedEntity[] = [];
  for (const e of [...(turn.entities ?? []), ...mem.entities]) {
    const key = `${e.kind}:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push(e);
    if (entities.length >= SK_MEMORY_MAX_ENTITIES) break;
  }
  const clip = (s: string) => s.slice(0, SK_MEMORY_TURN_CHARS);
  const added: SkMemoryTurn[] = [
    { role: "user", text: clip(turn.user) },
    { role: "assistant", text: clip(turn.assistant) },
  ];
  const turns: SkMemoryTurn[] = [...mem.turns, ...added].slice(-SK_MEMORY_MAX_TURNS);
  const next: SkMemory = { ...mem, entities, turns, lastAt: now.toISOString() };
  if (turn.pending === null) delete next.pending;
  else if (turn.pending) next.pending = turn.pending;
  return next;
}
