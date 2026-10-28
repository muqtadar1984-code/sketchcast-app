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
