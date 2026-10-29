// SK Shell — the shared core of confirm-tier action execution (Final Plan
// §2.5, §8.2, §9.2; S2 slice A). act.ts is the decision (verify → click-only →
// revalidate → dispatch → audit); this module holds what every action handler
// shares: the outcome vocabulary and lines, the handler shape, and
// `consumeThenWrite` — the S2 rule that a write runs AS THE TEACHER.
//
// consumeThenWrite (docs/sk-actions.md "S2 action core"):
//   1. the token was already verified (HMAC over the stored row, user, expiry,
//      used_at, live context) and the capability revalidated (metaAllows);
//   2. consume through 0163's service-role `sk_consume_action_token` — the one
//      atomic single-use gate; a second click gets `already_used` here;
//   3. write with the USER-SESSION client, carrying `sk_action_id` = token id,
//      so the existing RLS policies and triggers decide what is allowed and
//      0169's unique index makes a repeat write fail (23505 → already_used).
// This is NOT one transaction (Final Plan §9.2 said "same transaction"): the
// consume is a service-role call and the write a user-session call. A write
// that fails after the consume leaves the token burned and nothing written;
// SK says "That didn't go through — nothing was changed. Ask me again." and
// the audit row carries the measured error.

import type { ResolvedEntity, SkActResponse, SkCapabilityMeta, SkCollector, SkContext, SkKind, SkSessionDb, SkTier } from "./types";
import { consumeActionToken, type ActionTokenRow, type TokenDb } from "./tokens";
import type { SkAuditSink } from "./audit";
import type { SkMemory } from "./memory";

export type ActOutcome = SkActResponse["outcome"];

/** The one line SK says per non-done outcome. No details: the UI speaks it. */
export const ACT_LINES: Record<Exclude<ActOutcome, "done">, string> = {
  already_used: "That was already done.",
  expired: "That confirmation expired — ask me again.",
  context_mismatch: "Your context changed, so I did nothing.",
  not_found: "I don't have that confirmation any more — ask me again.",
  refused: "I can't do that one.",
  error: "That didn't go through — nothing was changed.",
};
export const ACT_CLICK_ONLY_LINE = "That one needs a click to confirm.";
export const ACT_NOT_ALLOWED_LINE = "That isn't available in your current view, so I did nothing.";

/** The narrow admin surface: sk_action_tokens reads and the consume / per-action RPCs. */
export type ActAdmin = TokenDb;

export type ActInput = {
  ctx: SkContext;
  token: string;
  via: "click" | "voice";
  turnId: string;
  now: Date;
  clock?: SkCollector["clock"];
  memory: SkMemory;
  admin: ActAdmin;
  /** The USER-SESSION client (the request's cookies). S2 writes go through it. */
  session?: SkSessionDb;
  sink: SkAuditSink;
};

export type Handled = {
  response: SkActResponse;
  entities: ResolvedEntity[];
  /** The measured error for the audit row (e.g. "error:write:<db message>"). */
  auditError?: string;
};

export type ActHandler = {
  tier: SkTier;
  kind: SkKind;
  /** §9.2: a spoken yes never confirms this action (in addition to CLICK_ONLY). */
  clickOnly?: boolean;
  /** The per-action RPC writes its own `done` audit row (assign / 0164). */
  auditsDone?: boolean;
  /** §2.5 per-tier revalidation: the live Context must still allow this. */
  meta?: SkCapabilityMeta;
  run: (row: ActionTokenRow, input: ActInput) => Promise<Handled>;
};

const OUTCOMES: ReadonlySet<string> = new Set<ActOutcome>(["done", "already_used", "expired", "context_mismatch", "not_found", "refused", "error"]);
export const toOutcome = (v: unknown): ActOutcome => (typeof v === "string" && OUTCOMES.has(v) ? (v as ActOutcome) : "error");
export const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const fail = (outcome: Exclude<ActOutcome, "done">, summary = ACT_LINES[outcome], result?: Record<string, unknown>, auditError?: string): Handled => ({
  response: { ok: false, outcome, summary, ...(result ? { result } : {}) },
  entities: [],
  ...(auditError ? { auditError } : {}),
});

// ── consumeThenWrite ─────────────────────────────────────────────────────────

/** What a session write reports. `refused` / `already_used` are decisions the
 *  DB made (RLS 42501, unique 23505); `error` is anything else, measured. */
export type WriteOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; outcome: "already_used" | "refused" | "error"; reason?: string; error?: string };

export type ConsumeThenWriteResult<T> =
  | { stage: "consume"; outcome: Exclude<ActOutcome, "done"> }
  | { stage: "write"; result: WriteOutcome<T> };

/** A Postgres/PostgREST error → the write outcome: 23505 (0169's unique index:
 *  this action already wrote this target) → already_used; 42501 (RLS said no)
 *  → refused; anything else → error with the message kept for the audit. */
export function writeFailure(error: unknown): { ok: false; outcome: "already_used" | "refused" | "error"; reason?: string; error?: string } {
  const e = (error ?? {}) as { code?: string; message?: string };
  if (e.code === "23505") return { ok: false, outcome: "already_used", reason: "duplicate" };
  if (e.code === "42501") return { ok: false, outcome: "refused", reason: "not_permitted", error: e.message };
  return { ok: false, outcome: "error", error: e.message ? `${e.code ? `${e.code} ` : ""}${e.message}` : "no row returned" };
}

/**
 * Consume the (already verified) token through the admin RPC, then run the
 * write with the user-session client and the token id as `sk_action_id`.
 * Never throws: a thrown write is an `error` with its message.
 */
export async function consumeThenWrite<T>(
  admin: ActAdmin,
  session: SkSessionDb,
  row: ActionTokenRow,
  ctx: SkContext,
  write: (session: SkSessionDb, actionId: string) => Promise<WriteOutcome<T>>,
): Promise<ConsumeThenWriteResult<T>> {
  let consumed: string;
  try {
    consumed = await consumeActionToken(admin, row.id, ctx.contextHash);
  } catch (e) {
    console.error("sk-act consume threw", (e as Error)?.message);
    consumed = "error";
  }
  if (consumed !== "done") {
    const o = toOutcome(consumed);
    return { stage: "consume", outcome: o === "done" ? "error" : o };
  }
  try {
    return { stage: "write", result: await write(session, row.id) };
  } catch (e) {
    return { stage: "write", result: { ok: false, outcome: "error", error: (e as Error)?.message || String(e) } };
  }
}

/** The non-done Handled for a consumeThenWrite result, with the locale's
 *  write-failed line for a failed write. Returns null when the write was ok. */
export function failedStage<T>(r: ConsumeThenWriteResult<T>, writeFailedLine: string): Handled | null {
  if (r.stage === "consume") return fail(r.outcome);
  if (r.result.ok) return null;
  const w = r.result;
  if (w.outcome === "already_used") return fail("already_used", undefined, undefined, `already_used:${w.reason ?? "duplicate"}`);
  if (w.outcome === "refused") return fail("refused", undefined, w.reason ? { reason: w.reason } : undefined, `refused:${w.reason ?? "write"}${w.error ? `:${w.error}` : ""}`);
  return fail("error", writeFailedLine, undefined, `error:write:${w.error ?? "unknown"}`.slice(0, 500));
}
