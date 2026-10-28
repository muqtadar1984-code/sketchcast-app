// SK Shell — executing a confirmed action (Final Plan §2.5, §8.2, §9.2).
//
// The client returns the opaque token from a `confirm` card, by click or by a
// spoken yes. This module is the whole decision: verify the token against the
// live Context (tokens.ts re-derives the HMAC from the STORED row), refuse a
// spoken yes for click-only actions, revalidate the capability's permission
// at execution time, then hand the token id — never the params — to the
// per-action RPC, which consumes the token and writes in ONE transaction
// (0164 sk_assign_with_token). The outcome becomes one line SK says.
//
// Audit: the RPC writes the `done` row itself (it knows the share id); every
// other outcome gets one SkActionRow here, ok=false, error=outcome. A token
// that was never found cannot be referenced (sk_actions.token_id is a FK), so
// its row carries token_id null.
//
// The admin client is used ONLY for sk_action_tokens and the RPC (§8.1).

import type { ResolvedEntity, SkActResponse, SkActionRow, SkCollector, SkContext } from "./types";
import { decodeToken, verifyActionToken, type ActionTokenRow, type TokenDb } from "./tokens";
import { metaAllows } from "./registry";
import { recordSafely, type SkAuditSink } from "./audit";
import { rememberTurn, type SkMemory } from "./memory";
import { assignAction, formatDue, offsetMinutesOf } from "@/sk/capabilities/assign";

export type ActOutcome = SkActResponse["outcome"];

/** §9.2 click-only actions: a spoken yes never confirms these. Names are the
 *  registry names those S2 actions will carry; `assign` is deliberately absent. */
export const CLICK_ONLY: ReadonlySet<string> = new Set([
  "teacher.invite", // invite teacher
  "notice.school", // school-wide notice
  "notice.multi_class", // multi-class notice
  "kit.generate", // spends credits
  "chapter.prepare", // spends credits
  "purchase", // spends money
  "book.activate", // activate with a code
  "access.revoke", // revoking access
  "recap.publish", // publishing a recap to parents
]);

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

/** The narrow admin surface this module touches. */
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
  sink: SkAuditSink;
};

export type ActOutput = { response: SkActResponse; memory: SkMemory };

type Handled = { response: SkActResponse; entities: ResolvedEntity[] };
type Handler = (row: ActionTokenRow, input: ActInput) => Promise<Handled>;

const OUTCOMES: ReadonlySet<string> = new Set<ActOutcome>(["done", "already_used", "expired", "context_mismatch", "not_found", "refused", "error"]);
const toOutcome = (v: unknown): ActOutcome => (typeof v === "string" && OUTCOMES.has(v) ? (v as ActOutcome) : "error");
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const fail = (outcome: Exclude<ActOutcome, "done">, summary = ACT_LINES[outcome], result?: Record<string, unknown>): Handled => ({
  response: { ok: false, outcome, summary, ...(result ? { result } : {}) },
  entities: [],
});

// ── assign → 0164 sk_assign_with_token ───────────────────────────────────────

async function runAssign(row: ActionTokenRow, input: ActInput): Promise<Handled> {
  // §2.5 per-tier revalidation: the live Context must still allow the capability.
  if (!metaAllows(assignAction.meta, input.ctx)) return fail("refused", ACT_NOT_ALLOWED_LINE);
  type RpcRes = { data?: unknown; error?: unknown } | null;
  let res: RpcRes;
  try {
    res = (await input.admin.rpc("sk_assign_with_token", { p_token: row.id, p_context_hash: input.ctx.contextHash })) as RpcRes;
  } catch (e) {
    console.error("sk-act assign rpc threw", (e as Error)?.message);
    return fail("error");
  }
  if (!res || res.error || !res.data || typeof res.data !== "object") {
    if (res?.error) console.error("sk-act assign rpc", (res.error as { message?: string }).message ?? res.error);
    return fail("error");
  }
  const data = res.data as Record<string, unknown>;
  const outcome = toOutcome(data.outcome);
  if (outcome !== "done") {
    const reason = str(data.reason);
    return fail(outcome, undefined, reason ? { reason } : undefined);
  }
  const p = row.params ?? {};
  const kitTitle = str(p.kit_title) || "the kit";
  const className = str(p.class_name) || "the class";
  const dueAt = str(data.due_at) || str(p.due_at);
  const due = dueAt ? `, due ${formatDue(new Date(dueAt).toISOString(), offsetMinutesOf(input.clock))}` : "";
  const generationId = str(data.generation_id) || str(p.generation_id);
  const classId = str(data.class_id) || str(p.class_id);
  return {
    response: {
      ok: true,
      outcome: "done",
      summary: `Assigned ${kitTitle} to ${className}${due}.`,
      result: { share_id: data.share_id ?? null, class_id: classId, generation_id: generationId, due_at: dueAt || null },
    },
    entities: [
      ...(classId ? [{ kind: "class", id: classId, label: className, via: "assign" } as ResolvedEntity] : []),
      ...(generationId ? [{ kind: "generation", id: generationId, label: kitTitle, via: "assign" } as ResolvedEntity] : []),
    ],
  };
}

const HANDLERS: Record<string, Handler> = { assign: runAssign };

// ── The decision ─────────────────────────────────────────────────────────────

export async function executeAction(input: ActInput): Promise<ActOutput> {
  const t0 = Date.now();
  const { ctx, now } = input;
  const verdict = await verifyActionToken(input.admin, input.token, { userId: ctx.user.id, contextHash: ctx.contextHash, now });
  let row: ActionTokenRow | null = null;
  let handled: Handled;
  if (!verdict.ok) {
    handled = fail(verdict.outcome);
  } else {
    row = verdict.row;
    if (input.via === "voice" && CLICK_ONLY.has(row.action)) {
      // The card stays valid for a click: nothing is consumed here.
      handled = fail("refused", ACT_CLICK_ONLY_LINE);
    } else {
      const handler = HANDLERS[row.action];
      handled = handler ? await handler(row, input) : fail("refused");
    }
  }
  const { response, entities } = handled;

  if (response.outcome !== "done") {
    const reason = str(response.result?.reason);
    const audit: SkActionRow = {
      actor_id: ctx.user.id,
      school_id: ctx.user.schoolId,
      role: ctx.user.role,
      hat: ctx.user.hat,
      action: row?.action ?? "act",
      tier: "confirm",
      kind: "act",
      params: row?.params ?? {},
      ok: false,
      // The decoded id is kept HERE (free text), not in token_id: a token that
      // failed verification may not exist, and token_id is a foreign key.
      result: { summary: response.summary, via: input.via, token: decodeToken(input.token)?.id ?? null },
      error: reason ? `${response.outcome}:${reason}` : response.outcome,
      session_id: input.memory.sessionId,
      generation_id: str(row?.params?.generation_id) || ctx.selection.generationId || null,
      token_id: row?.id ?? null,
      turn_id: input.turnId,
      at: new Date(t0).toISOString(),
      ms: Date.now() - t0,
    };
    await recordSafely(input.sink, audit);
  }

  const memory = rememberTurn(input.memory, { user: input.via === "voice" ? "Yes. (spoken confirmation)" : "(confirmed by click)", assistant: response.summary, entities }, now);
  return { response, memory };
}
