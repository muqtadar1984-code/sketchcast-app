// SK Shell — executing `plan.review` (SK student Board plan 2026-10-31,
// phase 4) from a VERIFIED token row.
//
// Follows act-core's `consumeThenWrite`, like diary.note:
//   1. the stored plan id is shape-checked (a bad row is refused BEFORE the
//      consume — nothing burned);
//   2. the token is consumed through the admin RPC (single use);
//   3. sk_learn_plan_decide(plan, 'approve') runs AS THE APPROVER through the
//      user-session client (0179): the function re-checks that she is the
//      plan's approver (the class teacher / a home student's parent), that the
//      plan is still waiting, and writes the shares and SK's focus rows in one
//      transaction. "not_approver" / "not_pending" come back as refused.

import type { ActionTokenRow } from "./tokens";
import { consumeThenWrite, fail, failedStage, str, type ActInput, type Handled, type WriteOutcome } from "./act-core";
import { lineFor } from "./lines";
import { ACT_WRITE_FAILED } from "./act-lines";
import { decidePlan, type DecideResult } from "@/sk/practice/plan-decide";
import { PLAN_APPROVED, PLAN_NOT_APPROVER } from "@/sk/capabilities/plan";
import type { SkSessionDb } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runPlanReview(row: ActionTokenRow, input: ActInput): Promise<Handled> {
  const p = row.params ?? {};
  const planId = str(p.plan_id);
  const locale = input.ctx.user.locale;
  if (!UUID.test(planId)) return fail("refused", undefined, { reason: "bad_params" });
  if (!input.session) return fail("error", undefined, undefined, "error:no_session");

  const r = await consumeThenWrite(input.admin, input.session, row, input.ctx, async (db: SkSessionDb): Promise<WriteOutcome<DecideResult>> => {
    const d = await decidePlan(db, { planId, decision: "approve", items: null, wholeClass: false, note: null });
    if (d.outcome === "done") return { ok: true, value: d };
    if (d.outcome === "refused" || d.outcome === "not_found") return { ok: false, outcome: "refused", reason: d.reason ?? d.outcome };
    return { ok: false, outcome: "error", error: "sk_learn_plan_decide failed" };
  });
  if (r.stage === "write" && !r.result.ok && r.result.outcome === "refused" && r.result.reason === "not_approver") {
    return fail("refused", lineFor(PLAN_NOT_APPROVER, locale), { reason: "not_approver" }, "refused:not_approver");
  }
  const failed = failedStage(r, lineFor(ACT_WRITE_FAILED, locale));
  if (failed) return failed;
  const value = r.stage === "write" && r.result.ok ? r.result.value : null;
  return {
    response: {
      ok: true,
      outcome: "done",
      summary: lineFor(PLAN_APPROVED, locale, { name: str(p.student_name) || "the student" }),
      result: { plan_id: planId, status: value?.status ?? "approved", applied: (value?.applied as Record<string, unknown> | undefined) ?? null },
    },
    entities: [],
  };
}
