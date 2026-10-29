// SK S6 slice A — "Delete my SK memory" (Final Plan §9.5; S6 design decision
// 7). Server only; the route is DELETE /api/sk/memory.
//
// WHAT GOES, for the caller (own):
//   * sk_workflow_facts — every row they own (their SESSION client; RLS owner-only);
//   * sk_learning_facts — every row about them (their SESSION client; RLS lets a
//     student delete their own; an adult simply has none);
//   * SK tutor history — `history` set to [] on every sk_sessions row of theirs,
//     and the stored words of their tutor turns (sk_events kind "turn": SK's
//     answers and the "Did you say …?" echo) emptied. Service-role client:
//     neither table has a client write grant (0157).
// For a parent (?child=<id>): the same learning facts and tutor history of a
// child who is the caller's VERIFIED link — checked on the caller's own
// session (parent_links, their own rows) BEFORE the service-role client is
// touched. The child's workflow facts are the child's own and are not the
// parent's to delete.
//
// WHY HISTORY IS CLEARED AND SESSIONS ARE NOT DELETED: item_attempts and
// sk_events reference sk_sessions ON DELETE CASCADE (0157). Deleting a kit
// session would also delete the attempts in it — educational records that
// §9.5 keeps on their existing rules (account lifetime, longitudinal
// reporting). Clearing `history` removes the conversation and keeps the record.
//
// NOT touched: item_attempts, mastery_state, sk_objective_mastery (educational
// records); sk_actions (the audit trail — 12 months, params cleared on account
// deletion by 0173's trigger); sk_usage (metering); assistant_messages (Ask
// Coach, decision 4).

/* eslint-disable @typescript-eslint/no-explicit-any */
export type MemoryDb = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type MemoryDeleteCounts = { workflowFacts: number; learningFacts: number; sessionsCleared: number; turnsCleared: number };
export type MemoryDeleteReply =
  | { status: 200; body: { ok: true; scope: "own" | "child"; deleted: MemoryDeleteCounts } }
  | { status: 403; body: { error: string } }
  | { status: 500; body: { error: string } };

type Row = Record<string, unknown>;

function rowsOf(r: unknown, what: string): Row[] {
  const x = r as { data?: unknown; error?: { message?: string } | null } | null;
  if (x?.error) throw new Error(`${what}: ${x.error.message ?? "error"}`);
  return Array.isArray(x?.data) ? (x!.data as Row[]) : x?.data ? [x.data as Row] : [];
}

/** Is `childId` the caller's VERIFIED child? Read on the caller's own session. */
export async function isVerifiedChildOf(session: MemoryDb, parentId: string, childId: string): Promise<boolean> {
  const rows = rowsOf(await session.from("parent_links").select("parent_id, child_id, verified_at").eq("parent_id", parentId).eq("child_id", childId), "parent_links");
  return rows.some((r) => r.parent_id === parentId && r.child_id === childId && typeof r.verified_at === "string" && !!r.verified_at);
}

/** Empty the tutor history of one student's sessions (service role). */
async function clearHistory(admin: MemoryDb, studentId: string): Promise<{ sessionsCleared: number; turnsCleared: number }> {
  const sessions = rowsOf(await admin.from("sk_sessions").select("id, student_id, history").eq("student_id", studentId), "sk_sessions read").filter((r) => r.student_id === studentId);
  if (!sessions.length) return { sessionsCleared: 0, turnsCleared: 0 };
  const withHistory = sessions.filter((r) => Array.isArray(r.history) && (r.history as unknown[]).length > 0).map((r) => r.id as string);
  let sessionsCleared = 0;
  if (withHistory.length) {
    sessionsCleared = rowsOf(await admin.from("sk_sessions").update({ history: [] }).eq("student_id", studentId).in("id", withHistory).select("id"), "sk_sessions clear").length;
  }
  const ids = sessions.map((r) => r.id as string);
  const turnsCleared = rowsOf(await admin.from("sk_events").update({ result: [] }).in("session_id", ids).eq("kind", "turn").select("event_id"), "sk_events clear").length;
  return { sessionsCleared, turnsCleared };
}

export type MemoryDeleteInput = {
  /** The caller's own session client (RLS applies). */
  session: MemoryDb;
  /** The service-role client, made only after every check passed. */
  admin: () => MemoryDb;
  userId: string;
  /** A parent deleting a child's memory; already a well-formed UUID. */
  childId?: string | null;
};

export async function deleteSkMemory(input: MemoryDeleteInput): Promise<MemoryDeleteReply> {
  const { session, userId } = input;
  try {
    if (input.childId) {
      const childId = input.childId;
      if (childId === userId || !(await isVerifiedChildOf(session, userId, childId))) {
        return { status: 403, body: { error: "You can only delete the SK memory of a child linked to your account." } };
      }
      const admin = input.admin();
      const learningFacts = rowsOf(await admin.from("sk_learning_facts").delete().eq("student_id", childId).select("id"), "learning facts delete").length;
      const h = await clearHistory(admin, childId);
      return { status: 200, body: { ok: true, scope: "child", deleted: { workflowFacts: 0, learningFacts, ...h } } };
    }
    const workflowFacts = rowsOf(await session.from("sk_workflow_facts").delete().eq("owner_id", userId).select("id"), "workflow facts delete").length;
    const learningFacts = rowsOf(await session.from("sk_learning_facts").delete().eq("student_id", userId).select("id"), "learning facts delete").length;
    const h = await clearHistory(input.admin(), userId);
    return { status: 200, body: { ok: true, scope: "own", deleted: { workflowFacts, learningFacts, ...h } } };
  } catch (e) {
    console.error("[sk memory] delete failed:", (e as Error).message);
    return { status: 500, body: { error: "Your SK memory could not be deleted. Please try again." } };
  }
}
