// sk_learn_plans rows (read through the viewer's session) → the cards the
// grown-ups' pages draw (SK student Board plan 2026-10-31, phase 4). Pure.
// Open plans first (oldest waiting at the top), then the latest decisions;
// superseded and still-drafting plans are not shown.

import type { DbRow } from "@/sk/store-supabase";
import { canApplyToClass, canDecide, type PlanItem, type PlanRow, type PlanViewer } from "@/sk/practice/plan";
import type { PlanCardData } from "./plan-card";

/** Decided plans kept on the page per student (the rest live in the record). */
export const DECIDED_PER_STUDENT = 2;

export function planCards(rows: readonly DbRow[], viewer: PlanViewer, names: { student: (id: string) => string; kit: (id: string) => string | null }): PlanCardData[] {
  const plans = rows as unknown as PlanRow[];
  const open = plans.filter((p) => p.status === "pending_approval").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const decidedCount = new Map<string, number>();
  const decided = plans
    .filter((p) => p.status === "approved" || p.status === "declined")
    .sort((a, b) => String(b.decided_at ?? b.created_at).localeCompare(String(a.decided_at ?? a.created_at)))
    .filter((p) => {
      const n = decidedCount.get(p.student_id) ?? 0;
      decidedCount.set(p.student_id, n + 1);
      return n < DECIDED_PER_STUDENT;
    });
  return [...open, ...decided].map((p) => ({
    id: p.id,
    studentName: names.student(p.student_id),
    kitName: p.kit_id ? names.kit(p.kit_id) : null,
    status: p.status,
    summary: p.summary,
    items: Array.isArray(p.items) ? (p.items as PlanItem[]) : [],
    approverRole: p.approver_role,
    canDecide: canDecide(p, viewer),
    canWholeClass: canDecide(p, viewer) && canApplyToClass(p),
    declineNote: p.decline_note,
    createdAt: p.created_at,
  }));
}
