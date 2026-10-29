// SK Shell — executing a confirmed action (Final Plan §2.5, §8.2, §9.2).
//
// The client returns the opaque token from a `confirm` card, by click or by a
// spoken yes. This module is the whole decision: verify the token against the
// live Context (tokens.ts re-derives the HMAC from the STORED row), refuse a
// spoken yes for click-only actions, revalidate the capability's permission
// at execution time (the handler's `meta`), then dispatch to the action's
// handler with the token row — the client never supplies params.
//
// Two execution shapes (act-core.ts):
// - `assign` (S1): the per-action RPC consumes the token and writes in ONE
//   transaction (0164 sk_assign_with_token) and writes its own `done` audit row.
// - S2 actions (`diary.note`, `parents.remind`, `marking.grade`,
//   `lesson.prepare`): `consumeThenWrite` — consume
//   through the admin RPC, then write AS THE TEACHER with the user-session
//   client, carrying sk_action_id = token id (0169).
//
// Audit: one SkActionRow per execution with the HANDLER's tier/kind, except a
// `done` the RPC already audited. A token that was never found cannot be
// referenced (sk_actions.token_id is a FK), so its row carries token_id null.
//
// The admin client is used ONLY for sk_action_tokens and the RPCs (§8.1).

import type { ResolvedEntity, SkActResponse, SkActionRow } from "./types";
import { decodeToken, verifyActionToken, type ActionTokenRow } from "./tokens";
import { metaAllows } from "./registry";
import { recordSafely } from "./audit";
import { rememberTurn, type SkMemory } from "./memory";
import { assignAction, formatDue, offsetMinutesOf } from "@/sk/capabilities/assign";
import { ACT_CLICK_ONLY_LINE, ACT_NOT_ALLOWED_LINE, fail, str, toOutcome, type ActHandler, type ActInput, type Handled } from "./act-core";
import { runDiaryNoteChecked, runParentsRemind } from "./act-diary";
import { diaryNoteAction } from "@/sk/capabilities/diary";
import { parentsRemindAction } from "@/sk/capabilities/remind";
import { runMarkingGrade } from "./act-marking";
import { runLessonPrepare } from "./act-prepare";
import { markingGrade } from "@/sk/capabilities/marking";
import { lessonPrepareAction } from "@/sk/capabilities/prepare";

export { ACT_CLICK_ONLY_LINE, ACT_LINES, ACT_NOT_ALLOWED_LINE, consumeThenWrite, writeFailure } from "./act-core";
export type { ActAdmin, ActHandler, ActInput, ActOutcome, Handled, WriteOutcome } from "./act-core";

/** §9.2 click-only actions: a spoken yes never confirms these. Names are the
 *  registry names those S2 actions will carry; `assign` is deliberately absent. */
export const CLICK_ONLY: ReadonlySet<string> = new Set([
  "teacher.invite", // invite teacher
  "notice.school", // school-wide notice
  "notice.multi_class", // multi-class notice
  "kit.generate", // spends credits
  "chapter.prepare", // spends credits
  "lesson.prepare", // spends credits (S2 slice B; also flagged clickOnly on its handler)
  "purchase", // spends money
  "book.activate", // activate with a code
  "access.revoke", // revoking access
  "recap.publish", // publishing a recap to parents
]);

export type ActOutput = { response: SkActResponse; memory: SkMemory };

// ── assign → 0164 sk_assign_with_token ───────────────────────────────────────

async function runAssign(row: ActionTokenRow, input: ActInput): Promise<Handled> {
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

/** Every confirm-tier action /api/sk/act can execute. `tier`/`kind` go on the
 *  audit row; `meta` is revalidated against the live Context before anything
 *  is consumed; `auditsDone` = the per-action RPC writes its own done row. */
export const HANDLERS: Record<string, ActHandler> = {
  // S1: consume + write in ONE transaction inside 0164's RPC (left as it was).
  assign: { tier: "confirm", kind: "act", auditsDone: true, meta: assignAction.meta, run: runAssign },
  // S2 slice A: consume (admin RPC) → write AS THE TEACHER (session client).
  // S4 slice C: its meta now admits parents; a parent's child is re-checked before the consume.
  "diary.note": { tier: "confirm", kind: "act", meta: diaryNoteAction.meta, run: runDiaryNoteChecked },
  "parents.remind": { tier: "confirm", kind: "act", meta: parentsRemindAction.meta, run: runParentsRemind },
  // S2 slice B: the marking queue's grade (status-guarded update, act-marking.ts)
  // and lesson prep — CLICK-ONLY because it spends credits (act-prepare.ts).
  "marking.grade": { tier: "confirm", kind: "act", meta: markingGrade.meta, run: runMarkingGrade },
  "lesson.prepare": { tier: "confirm", kind: "act", clickOnly: true, meta: lessonPrepareAction.meta, run: runLessonPrepare },
};

// ── The decision ─────────────────────────────────────────────────────────────

export async function executeAction(input: ActInput): Promise<ActOutput> {
  const t0 = Date.now();
  const { ctx, now } = input;
  const verdict = await verifyActionToken(input.admin, input.token, { userId: ctx.user.id, contextHash: ctx.contextHash, now });
  let row: ActionTokenRow | null = null;
  let handler: ActHandler | undefined;
  let handled: Handled;
  if (!verdict.ok) {
    handled = fail(verdict.outcome);
  } else {
    row = verdict.row;
    handler = Object.prototype.hasOwnProperty.call(HANDLERS, row.action) ? HANDLERS[row.action] : undefined;
    if (input.via === "voice" && (CLICK_ONLY.has(row.action) || handler?.clickOnly)) {
      // The card stays valid for a click: nothing is consumed here.
      handled = fail("refused", ACT_CLICK_ONLY_LINE);
    } else if (!handler) {
      handled = fail("refused");
    } else if (handler.meta && !metaAllows(handler.meta, ctx)) {
      // §2.5 per-tier revalidation, before anything is consumed.
      handled = fail("refused", ACT_NOT_ALLOWED_LINE);
    } else {
      handled = await handler.run(row, input);
    }
  }
  const { response, entities } = handled;
  const done = response.outcome === "done";

  if (!(done && handler?.auditsDone)) {
    const reason = str(response.result?.reason);
    const audit: SkActionRow = {
      actor_id: ctx.user.id,
      school_id: ctx.user.schoolId,
      role: ctx.user.role,
      hat: ctx.user.hat,
      action: row?.action ?? "act",
      tier: handler?.tier ?? "confirm",
      kind: handler?.kind ?? "act",
      params: row?.params ?? {},
      ok: done,
      // The decoded id is kept HERE (free text), not in token_id: a token that
      // failed verification may not exist, and token_id is a foreign key.
      result: { summary: response.summary, via: input.via, token: decodeToken(input.token)?.id ?? null, ...(done && response.result ? response.result : {}) },
      ...(done ? {} : { error: handled.auditError ?? (reason ? `${response.outcome}:${reason}` : response.outcome) }),
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
