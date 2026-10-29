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
/** S2 tray: how many announced kit ids the blob keeps (newest first). 20 uuids
 *  ≈ 1 KB of the blob's 64 000-character ceiling. */
export const SK_MEMORY_MAX_ANNOUNCED = 20;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type SkMemoryTurn = { role: "user" | "assistant"; text: string };

/** S2: what a bare "yes" / "open it" on the NEXT turn opens — set by the
 *  greeting's "Your kit for … is ready — want me to open it?" and dropped by
 *  whatever turn comes next. A navigate target + its filter, never a raw path:
 *  the turn route still runs `navigate`, so visibility is re-checked. */
export type SkOffer =
  | { target: "library"; bookId: string; label: string }
  /** S3 slice D: the student greeting's "Carry on?" — her kit, by the ids
   *  the kit routes re-check (product slug, chapter ref, kit generation). */
  | { target: "tutor"; product: string; chapter: string; kit: string; label: string };

export type SkMemory = {
  v: typeof SK_MEMORY_VERSION;
  sessionId: string;
  contextHash: string;
  issuedAt: string;
  lastAt: string;
  entities: ResolvedEntity[];
  pending?: { task: string; needs: string[] };
  turns: SkMemoryTurn[];
  /** S2: presentation ids of SK-started kits the greeting already announced
   *  (finished or failed), newest first, at most SK_MEMORY_MAX_ANNOUNCED. */
  announced?: string[];
  offer?: SkOffer;
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
    const out: SkMemory = { ...m, entities: Array.isArray(m.entities) ? m.entities : [], turns: Array.isArray(m.turns) ? m.turns : [] };
    const announced = cleanIds(m.announced);
    if (announced.length) out.announced = announced;
    else delete out.announced;
    const o = m.offer as Record<string, unknown> | undefined;
    if (o && o.target === "library" && typeof o.bookId === "string" && ID_RE.test(o.bookId) && typeof o.label === "string") out.offer = { target: "library", bookId: o.bookId, label: o.label.slice(0, 160) };
    else if (o && o.target === "tutor" && typeof o.product === "string" && ID_RE.test(o.product) && typeof o.chapter === "string" && /^[A-Za-z0-9._-]{1,20}$/.test(o.chapter) && typeof o.kit === "string" && ID_RE.test(o.kit) && typeof o.label === "string")
      out.offer = { target: "tutor", product: o.product, chapter: o.chapter, kit: o.kit, label: o.label.slice(0, 160) };
    else delete out.offer;
    return out;
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
  // A greeting's offer answers only the turn right after it.
  delete next.offer;
  if (turn.pending === null) delete next.pending;
  else if (turn.pending) next.pending = turn.pending;
  return next;
}

// ── S2: kits the greeting already announced ─────────────────────────────────

/** Bounded, de-duplicated, well-formed ids (anything else dropped). */
export function cleanIds(v: unknown, max = SK_MEMORY_MAX_ANNOUNCED): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !ID_RE.test(x) || out.includes(x)) continue;
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

/** Record the ids the greeting just announced (newest first, bounded) and the
 *  greeting's offer — or clear a stale offer when there is none. Merges the
 *  kits' entities so "open the Specialised Cells kit" resolves too. Never
 *  mutates; `lastAt` is untouched (a greeting is not a turn). */
export function rememberAnnounced(
  mem: SkMemory,
  update: { ids: string[]; prior?: readonly string[]; entities?: ResolvedEntity[]; offer?: SkOffer | null },
): SkMemory {
  const announced = cleanIds([...update.ids, ...(update.prior ?? []), ...(mem.announced ?? [])]);
  const seen = new Set<string>();
  const entities: ResolvedEntity[] = [];
  for (const e of [...(update.entities ?? []), ...mem.entities]) {
    const key = `${e.kind}:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push(e);
    if (entities.length >= SK_MEMORY_MAX_ENTITIES) break;
  }
  const next: SkMemory = { ...mem, entities };
  if (announced.length) next.announced = announced;
  else delete next.announced;
  if (update.offer) next.offer = update.offer;
  else delete next.offer;
  return next;
}

/**
 * The announced ids ALSO travel in a small signed note of their own, which the
 * panel keeps in localStorage: the conversation blob lives in sessionStorage
 * and resets after a 4-hour gap or a hat change, and a kit must still be
 * announced at most once. The note carries ONLY generation ids and the user
 * id it was issued to (no conversation text), is HMAC'd with the memory's
 * secret, and a note for another user is ignored.
 */
type AnnouncedNote = { v: 1; uid: string; ids: string[] };

export function sealAnnounced(uid: string, ids: readonly string[]): string {
  const note: AnnouncedNote = { v: 1, uid, ids: cleanIds(ids) };
  const payload = base64UrlEncode(JSON.stringify(note));
  return `${payload}.${hmacHex(memorySecret(), `announced:${payload}`)}`;
}

/** The ids in a note issued to `uid`; [] for a missing, forged or foreign one. */
export function openAnnounced(blob: string | null | undefined, uid: string): string[] {
  if (!blob || typeof blob !== "string" || blob.length > 4_000) return [];
  const dot = blob.lastIndexOf(".");
  if (dot <= 0) return [];
  const payload = blob.slice(0, dot);
  if (!safeEqualHex(hmacHex(memorySecret(), `announced:${payload}`), blob.slice(dot + 1))) return [];
  try {
    const n = JSON.parse(base64UrlDecode(payload) ?? "") as Partial<AnnouncedNote>;
    return n && n.v === 1 && n.uid === uid ? cleanIds(n.ids) : [];
  } catch {
    return [];
  }
}
