// Worksheet practice — READING mastery (SK student Board plan 2026-10-31,
// phase 4). Server only. One reader for every audience:
//
//   * the student (her SK "how am I doing?", the end-of-worksheet summary) —
//     through HER session: RLS returns only her own attempts;
//   * the teacher (analytics, per student and per class) — through HER
//     session: teaches_student / worksheet owner rows only (0178);
//   * the parent (the child's view) — through HIS session: is_parent_of (0178);
//   * the plan drafter (service role) — scoped to one student by the caller.
// The ids passed in are a FILTER, never the permission: RLS decides what a
// session may read, and the rows are re-filtered to the asked students.
//
// Never a model call: concept tags are read from the cache (0179); an
// untagged question counts under the paper's concept or the kit itself.

import type { DbRow, SkDb } from "@/sk/store-supabase";
import { computeMastery, type ConceptMastery, type ConceptRef, type PracticeAttemptRow } from "./mastery";

/** Rows read at most per call (a class's term of practice fits comfortably). */
export const MASTERY_MAX_ATTEMPTS = 5000;
const CHUNK = 200;

const chunks = <T,>(xs: T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** A kit generation's display name: its title without the "— Lesson" style suffix. */
export function kitTitleOf(g: { title?: unknown } | null | undefined): string {
  const t = typeof g?.title === "string" ? g.title.trim() : "";
  return (t.split(/\s+[—–-]\s+/)[0] || t || "This lesson").slice(0, 200);
}

export type MasteryRead = {
  rows: ConceptMastery[];
  /** kit id → its name. */
  kits: Map<string, string>;
};

export async function readPracticeMastery(db: SkDb, studentIds: readonly string[], opts: { kitId?: string | null; now?: number } = {}): Promise<MasteryRead> {
  const ids = [...new Set(studentIds.filter(Boolean))];
  const empty: MasteryRead = { rows: [], kits: new Map() };
  if (!ids.length) return empty;
  const want = new Set(ids);

  const attempts: PracticeAttemptRow[] = [];
  for (const part of chunks(ids)) {
    const { data, error } = await db
      .from("sk_practice_attempts")
      .select("session_id, student_id, generation_id, question_id, question_type, concept, kind, outcome, rung, attempt_no, created_at")
      .in("student_id", part)
      .order("created_at", { ascending: false })
      .limit(MASTERY_MAX_ATTEMPTS);
    if (error) return empty;
    for (const r of (data ?? []) as DbRow[]) if (want.has(String(r.student_id))) attempts.push(r as unknown as PracticeAttemptRow);
  }
  if (!attempts.length) return empty;

  const sessionKit = new Map<string, string>();
  for (const part of chunks([...new Set(attempts.map((a) => a.session_id))])) {
    const { data } = await db.from("sk_practice_sessions").select("id, kit_id").in("id", part);
    for (const r of (data ?? []) as DbRow[]) sessionKit.set(String(r.id), String(r.kit_id));
  }
  const kitFilter = opts.kitId ?? null;
  const mine = kitFilter ? attempts.filter((a) => sessionKit.get(a.session_id) === kitFilter) : attempts;
  if (!mine.length) return empty;

  const tags = new Map<string, ConceptRef>();
  for (const part of chunks([...new Set(mine.map((a) => a.generation_id))])) {
    const { data } = await db
      .from("sk_practice_concepts")
      .select("generation_id, question_id, concept_key, concept_name, created_at")
      .in("generation_id", part)
      .order("created_at", { ascending: false });
    for (const r of (data ?? []) as DbRow[]) {
      const k = `${r.generation_id}:${r.question_id}`;
      if (!tags.has(k)) tags.set(k, { key: String(r.concept_key), name: String(r.concept_name) }); // newest first
    }
  }

  const kits = new Map<string, string>();
  const kitIds = [...new Set(mine.map((a) => sessionKit.get(a.session_id)).filter((k): k is string => !!k))];
  for (const part of chunks(kitIds)) {
    const { data } = await db.from("generations").select("id, title").in("id", part);
    for (const r of (data ?? []) as DbRow[]) kits.set(String(r.id), kitTitleOf(r));
  }

  const rows = computeMastery({ attempts: mine, sessionKit, tags, kitName: (k) => kits.get(k) ?? "This lesson", now: opts.now ?? Date.now() });
  return { rows, kits };
}
