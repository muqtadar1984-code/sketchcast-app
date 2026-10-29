// SK S6 slice A — the two fact stores (migration 0173; Final Plan §9.5).
// Server only.
//
// WORKFLOW facts (an adult's: recent class / kit, pending task, preference)
//   go through the user's SESSION client. RLS is owner-only, so a write or a
//   read can only ever touch the caller's own rows. 12 months rolling: every
//   write moves expires_at to now + 12 months (the table refuses a client
//   expiry further out than 366 days).
// LEARNING facts (about a student: misconception, explained, struggled,
//   strength) are written ONLY by the server with the service-role client,
//   and ONLY after memoryAllowed(…, "transcripts") says yes. Without consent
//   noteLearning is a no-op. The student reads (and deletes) their own rows
//   through their session. 90 days (the table's default).

import { memoryAllowed, type ConsentDb } from "./consent";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FactsDb = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type WorkflowKind = "recent_class" | "recent_kit" | "pending_task" | "preference";
export type LearningKind = "misconception" | "explained" | "struggled" | "strength";

export type WorkflowFact = { kind: string; key: string; value: unknown; updatedAt: string | null; expiresAt: string | null };
export type LearningFact = { id: string; kind: LearningKind; objectiveKey: string | null; detail: unknown; source: string; createdAt: string | null; expiresAt: string | null };

const KIND_RE = /^[a-z][a-z_]{1,39}$/;
const SOURCE_RE = /^[a-z][a-z0-9_.:-]{1,63}$/;
const LEARNING_KINDS: readonly LearningKind[] = ["misconception", "explained", "struggled", "strength"];
/** Under the table's pg_column_size ≤ 8192 check, with room to spare. */
const MAX_JSON = 6000;
const RECALL_LIMIT = 50;

type Row = Record<string, unknown>;
const fits = (v: unknown) => {
  try {
    const s = JSON.stringify(v ?? {});
    return typeof s === "string" && s.length <= MAX_JSON;
  } catch {
    return false;
  }
};

/** now + 12 calendar months, as the table's default computes it. */
export function workflowExpiry(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() + 12);
  return d.toISOString();
}

function rowsOf(r: unknown, what: string): Row[] {
  const x = r as { data?: unknown; error?: { message?: string } | null } | null;
  if (x?.error) throw new Error(`[sk facts] ${what} failed: ${x.error.message ?? "error"}`);
  return Array.isArray(x?.data) ? (x!.data as Row[]) : [];
}

/** Remember (or refresh) one workflow fact for the signed-in owner. */
export async function rememberWorkflow(session: FactsDb, ownerId: string, kind: WorkflowKind | string, key: string, value: unknown, now: Date = new Date()): Promise<boolean> {
  const k = String(key ?? "").trim().slice(0, 200);
  if (!ownerId || !KIND_RE.test(kind) || !k || !fits(value)) return false;
  const r = await session
    .from("sk_workflow_facts")
    .upsert({ owner_id: ownerId, kind, key: k, value: value ?? {}, expires_at: workflowExpiry(now) }, { onConflict: "owner_id,kind,key" });
  if (r?.error) {
    console.error("[sk facts] remember failed:", r.error.message);
    return false;
  }
  return true;
}

/** The owner's live workflow facts of these kinds, newest first. */
export async function recallWorkflow(session: FactsDb, ownerId: string, kinds: readonly string[], now: Date = new Date()): Promise<WorkflowFact[]> {
  const ks = kinds.filter((k) => KIND_RE.test(k));
  if (!ownerId || !ks.length) return [];
  const rows = rowsOf(
    await session
      .from("sk_workflow_facts")
      .select("owner_id, kind, key, value, updated_at, expires_at")
      .eq("owner_id", ownerId)
      .in("kind", ks)
      .gt("expires_at", now.toISOString())
      .order("updated_at", { ascending: false })
      .limit(RECALL_LIMIT),
    "recall workflow",
  );
  return rows
    .filter((r) => r.owner_id === ownerId && ks.includes(r.kind as string))
    .map((r) => ({ kind: r.kind as string, key: r.key as string, value: r.value ?? null, updatedAt: (r.updated_at as string) ?? null, expiresAt: (r.expires_at as string) ?? null }));
}

export type LearningNote = { kind: LearningKind; objectiveKey?: string | null; detail?: Record<string, unknown>; source: string };
export type NoteResult = { stored: true } | { stored: false; reason: "no_consent" | "bad_input" | "error" };

/**
 * Record one learning fact about a student — ONLY with consent. The consent
 * check runs first; without it nothing is written (and nothing is read beyond
 * the consent rows themselves). Never throws: memory is never worth failing
 * the lesson for.
 */
export async function noteLearning(admin: FactsDb & ConsentDb, studentId: string, note: LearningNote): Promise<NoteResult> {
  if (!LEARNING_KINDS.includes(note.kind) || !SOURCE_RE.test(note.source) || !fits(note.detail ?? {})) return { stored: false, reason: "bad_input" };
  try {
    if (!(await memoryAllowed(admin, studentId, "transcripts"))) return { stored: false, reason: "no_consent" };
    const objectiveKey = typeof note.objectiveKey === "string" && note.objectiveKey ? note.objectiveKey.slice(0, 200) : null;
    const r = await admin.from("sk_learning_facts").insert({ student_id: studentId, kind: note.kind, objective_key: objectiveKey, detail: note.detail ?? {}, source: note.source });
    if (r?.error) throw new Error(r.error.message);
    return { stored: true };
  } catch (e) {
    console.error("[sk facts] noteLearning failed:", (e as Error).message);
    return { stored: false, reason: "error" };
  }
}

/** The student's own live learning facts (their session client), newest first. */
export async function recallLearning(session: FactsDb, studentId: string, now: Date = new Date()): Promise<LearningFact[]> {
  if (!studentId) return [];
  const rows = rowsOf(
    await session
      .from("sk_learning_facts")
      .select("id, student_id, kind, objective_key, detail, source, created_at, expires_at")
      .eq("student_id", studentId)
      .gt("expires_at", now.toISOString())
      .order("created_at", { ascending: false })
      .limit(RECALL_LIMIT),
    "recall learning",
  );
  return rows
    .filter((r) => r.student_id === studentId)
    .map((r) => ({
      id: r.id as string,
      kind: r.kind as LearningKind,
      objectiveKey: (r.objective_key as string) ?? null,
      detail: r.detail ?? null,
      source: r.source as string,
      createdAt: (r.created_at as string) ?? null,
      expiresAt: (r.expires_at as string) ?? null,
    }));
}
