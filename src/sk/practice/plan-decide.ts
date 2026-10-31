// The approver's decision on a recommended plan — the request shape and the
// ONE database call (SK student Board plan 2026-10-31, phase 4). Shared by
// POST /api/learn/plan (the Library / analytics / child-view cards) and SK's
// confirm card (plan.review → /api/sk/act). The call runs AS THE APPROVER
// (her session): sk_learn_plan_decide (0179) is the authority on who may
// decide, and writes the shares + focus rows on approve.

import { checkEdit, type PlanDecision, type PlanItem } from "./plan";

export type DecisionRequest = { planId: string; decision: PlanDecision; items: PlanItem[] | null; wholeClass: boolean; note: string | null };
export type DecideResult = { outcome: "done" | "refused" | "not_found" | "error"; status?: string; reason?: string; applied?: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The body → a decision, or an error to answer 400 with. Items are shape-checked here; the database checks they are SK's. */
export function parseDecision(raw: unknown): DecisionRequest | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Invalid body." };
  const b = raw as Record<string, unknown>;
  const planId = typeof b.planId === "string" ? b.planId : "";
  if (!UUID.test(planId)) return { error: "Bad plan." };
  const decision = b.decision === "approve" || b.decision === "decline" || b.decision === "edit" ? b.decision : null;
  if (!decision) return { error: "Bad decision." };
  let items: PlanItem[] | null = null;
  if (b.items !== undefined && b.items !== null) {
    // Shape only (kinds, lengths): the original list is the database's to compare against.
    const shaped = checkEdit(Array.isArray(b.items) ? (b.items as PlanItem[]) : [], b.items);
    if (!shaped) return { error: "Those plan items didn't look right." };
    items = shaped;
  }
  if (decision === "edit" && !items) return { error: "Nothing to save." };
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : null;
  return { planId, decision, items, wholeClass: b.wholeClass === true, note };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

/** sk_learn_plan_decide as the approver. Never throws. */
export async function decidePlan(session: RpcClient, d: DecisionRequest): Promise<DecideResult> {
  try {
    const res = (await session.rpc("sk_learn_plan_decide", {
      p_plan: d.planId,
      p_decision: d.decision,
      p_items: d.items,
      p_whole_class: d.wholeClass,
      p_note: d.note,
    })) as { data?: unknown; error?: { message?: string } | null };
    if (res?.error || !res?.data || typeof res.data !== "object") return { outcome: "error" };
    const r = res.data as Record<string, unknown>;
    const outcome = r.outcome === "done" || r.outcome === "refused" || r.outcome === "not_found" ? r.outcome : "error";
    return {
      outcome,
      ...(typeof r.status === "string" ? { status: r.status } : {}),
      ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
      ...(r.applied !== undefined ? { applied: r.applied } : {}),
    };
  } catch {
    return { outcome: "error" };
  }
}
