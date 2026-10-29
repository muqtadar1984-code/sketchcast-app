// SK S6 slice A — the daily retention sweep (Final Plan §9.5; migration 0173
// sk_memory_sweep): expired workflow facts (12 months) and learning facts
// (90 days), tutor history older than 90 days, sk_actions older than 12
// months. Called from the existing daily cron (/api/lifecycle/reminders) with
// the service-role client. Server only.
//
// GUARDED: it never throws. A missing service key, a missing function (0173
// not applied yet) or any database error is logged and the cron carries on.
// It sends nothing to anyone.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type SweepDb = { rpc: (fn: string, args?: Record<string, unknown>) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type SweepCounts = { workflow_facts: number; learning_facts: number; history_cleared: number; sk_actions: number };

/** Run sk_memory_sweep(); the counts, or null when it could not run. */
export async function runSkMemorySweep(admin: () => SweepDb): Promise<SweepCounts | null> {
  try {
    const { data, error } = ((await admin().rpc("sk_memory_sweep")) ?? {}) as { data?: unknown; error?: { message?: string } | null };
    if (error) {
      console.error("[sk memory] sweep failed:", error.message ?? "error");
      return null;
    }
    const d = (data ?? {}) as Record<string, unknown>;
    const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : 0);
    return { workflow_facts: n("workflow_facts"), learning_facts: n("learning_facts"), history_cleared: n("history_cleared"), sk_actions: n("sk_actions") };
  } catch (e) {
    console.error("[sk memory] sweep failed:", (e as Error).message);
    return null;
  }
}
