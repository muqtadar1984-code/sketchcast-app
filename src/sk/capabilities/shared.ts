// The reads several SK capabilities make of the SAME rows in ONE turn, read
// once per turn (fix/sk-speed, founder 2026-10-28: "the response needs to be
// faster"). Live, "how are my classes" ran assignments.status (4.0 s) and
// learners.risk (3.9 s), each re-reading the teacher's classes and
// enrollments through the user-session client.
//
// `memo` keeps a PROMISE per key in the turn's Map (SkCapabilityDeps.cache,
// made by the turn route, one per request): two tools asking together share
// the one query in flight; a failed read (a rejection, or a query result that
// carries an `error`) is dropped from the memo so the next tool retries
// exactly as it would have without the memo. No cache →
// every read runs, so a capability called from a test or another route
// behaves as before. Keys carry the user id: nothing is ever shared across
// users, and nothing outlives the request.
//
// Still the USER-SESSION client only (§2.3): RLS decides what rows exist and
// every caller keeps re-applying its own `teacher_id === me` filter on top.

import type { SkCapabilityDeps } from "@/sk/shell/types";
import { fetchSchoolHealthRows, type HealthRows } from "@/utils/school-health";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function memo<T>(deps: Pick<SkCapabilityDeps, "cache">, key: string, read: () => Promise<T>, keep: (v: T) => boolean = () => true): Promise<T> {
  const cache = deps.cache;
  if (!cache) return read();
  const hit = cache.get(key);
  if (hit) return hit as Promise<T>;
  const p = read();
  cache.set(key, p);
  const forget = () => {
    if (cache.get(key) === p) cache.delete(key);
  };
  try {
    const v = await p;
    if (!keep(v)) forget();
    return v;
  } catch (e) {
    forget();
    throw e;
  }
}

/** A Supabase query result is worth remembering only when it carries no error. */
const noError = (r: QueryResult) => !r?.error;

/** One class as the shared read returns it: the union of the columns the
 *  callers need (assignments: id, name, teacher_id; resolve/assign: + school_id). */
export type TeacherClassRow = { id: string; name: string | null; grade?: string | null; teacher_id?: string | null; school_id?: string | null };

type QueryResult = { data: unknown; error: { message?: string } | null };

/** The teacher's OWN classes (`teacher_id = me`), newest first, as the query
 *  result (callers unwrap and re-filter as they always did). */
export function teacherClasses(deps: SkCapabilityDeps, me: string): Promise<QueryResult> {
  return memo(deps, `classes:${me}`, async () => (await deps.session.from("classes").select("id, name, grade, teacher_id, school_id").eq("teacher_id", me).order("created_at", { ascending: false })) as QueryResult, noError);
}

/** The enrollments of a set of the teacher's classes, with the learner's
 *  name. Keyed on the sorted class ids, so the same scope is read once. */
export function classEnrollments(deps: SkCapabilityDeps, me: string, classIds: string[]): Promise<QueryResult> {
  const ids = [...new Set(classIds)].sort();
  return memo(deps, `enrollments:${me}:${ids.join(",")}`, async () => (await deps.session.from("enrollments").select("class_id, student_id, profiles(full_name, username)").in("class_id", ids)) as QueryResult, noError);
}

/** school-health's RLS-scoped rows (learners.risk cuts them to the teacher's
 *  own classes afterwards). One read per turn however many classes are asked about. */
export function schoolHealthRows(deps: SkCapabilityDeps, me: string): Promise<HealthRows> {
  return memo(deps, `schoolHealth:${me}`, () => fetchSchoolHealthRows(deps.session as unknown as SupabaseClient));
}

// ── S5 slice A: the leader reads (principal / coordinator hats) ─────────────

/** Every class row RLS shows this user (a principal: the school; a
 *  coordinator: their scope grades PLUS their own classes — the union that
 *  leader-scope.ts cuts in code). Callers re-filter by school and scope. */
export function visibleClasses(deps: SkCapabilityDeps, me: string): Promise<QueryResult> {
  return memo(deps, `visibleClasses:${me}`, async () => (await deps.session.from("classes").select("id, name, grade, teacher_id, school_id").order("created_at", { ascending: false })) as QueryResult, noError);
}

/** `.in()` lists are URL-bound. */
const SUBJECT_IDS_CAP = 300;

/** generation id → its book's subject (generations ⋈ books), for a coordinator
 *  scope row that names a subject. Read only when one does (leader-scope.ts
 *  needsSubjects). A generation with no book, or a book RLS hides, maps to
 *  null — which no subject-scoped row matches (fail closed, like RLS). */
export async function generationSubjects(deps: SkCapabilityDeps, me: string, generationIds: string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(generationIds)].sort().slice(0, SUBJECT_IDS_CAP);
  const out = new Map<string, string | null>();
  if (!ids.length) return out;
  const res = await memo(deps, `genSubjects:${me}:${ids.join(",")}`, async () => (await deps.session.from("generations").select("id, books(subject)").in("id", ids)) as QueryResult, noError);
  if (res.error) throw new Error(`generations: ${res.error.message ?? "query failed"}`);
  for (const r of (res.data ?? []) as Array<{ id: string; books?: { subject?: string | null } | Array<{ subject?: string | null }> | null }>) {
    const b = Array.isArray(r.books) ? r.books[0] : r.books;
    out.set(r.id, typeof b?.subject === "string" && b.subject.trim() ? b.subject : null);
  }
  return out;
}
