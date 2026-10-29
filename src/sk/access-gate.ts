// SK restricted live, the student half (founder 2026-10-30: "ensure that SK is
// accessible by only <founder>, <Sara> and her students till I pass the test").
// SERVER ONLY: it reads auth users, classes and enrollments with the service
// role. Nothing here is ever sent to a browser; the gate in src/utils/flags.ts
// (skAccessAllowed) turns it into one boolean.
//
// A student is "of" an allowed teacher when they are CURRENTLY enrolled in a
// class whose teacher_id is the profile of a VERIFIED auth user whose address
// is on SK_ALLOWED_STUDENTS_OF. The student's own address plays no part:
// teacher-created student accounts often have none, or an unverified one.
//
// Cost: the teacher ids and their class ids are cached for 60 s per server
// instance (one listUsers page walk + one classes read per minute at most).
// The enrollment check is NOT cached, so a student removed from the class
// loses SK on their next request.
//
// Errors throw. The caller (skAccessAllowed) fails CLOSED: a lookup error is
// "not allowed", logged server-side.

import { createAdminClient } from "@/utils/supabase/admin";

const TTL_MS = 60_000;
const PER_PAGE = 1000;
const MAX_PAGES = 50; // 50k auth users; well past today's few hundred

type AuthUserRow = { id: string; email?: string | null; email_confirmed_at?: string | null };
type Result<T> = { data: T | null; error: { message?: string } | null };

type Query = PromiseLike<Result<Record<string, unknown>[]>> & {
  in(col: string, vals: string[]): Query;
  eq(col: string, val: string): Query;
  limit(n: number): Query;
};

/** The slice of the admin client this module uses (a fake in tests). */
export type AccessAdmin = {
  auth: { admin: { listUsers(opts: { page: number; perPage: number }): Promise<{ data: { users: AuthUserRow[] } | null; error: { message?: string } | null }> } };
  from(table: string): { select(cols: string): Query };
};

type Snapshot = { key: string; at: number; teacherIds: Set<string>; classIds: string[] };
let cache: Snapshot | null = null;
let adminOverride: (() => AccessAdmin) | null = null;

export function __setSkAccessAdminForTests(f: (() => AccessAdmin) | null): void {
  adminOverride = f;
  cache = null;
}
export function __resetSkAccessCacheForTests(): void {
  cache = null;
}

function admin(): AccessAdmin {
  return adminOverride ? adminOverride() : (createAdminClient() as unknown as AccessAdmin);
}

/** Verified auth user ids for these (already normalised) addresses. */
async function teacherIdsFor(db: AccessAdmin, emails: string[]): Promise<Set<string>> {
  const want = new Set(emails);
  const ids = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(`listUsers: ${error.message ?? "failed"}`);
    const users = data?.users ?? [];
    for (const u of users) {
      const e = (u.email ?? "").trim().toLowerCase();
      if (u.email_confirmed_at && e && want.has(e)) ids.add(u.id);
    }
    if (users.length < PER_PAGE) return ids;
  }
  throw new Error("listUsers: too many pages");
}

async function snapshot(db: AccessAdmin, emails: string[], now: number): Promise<Snapshot> {
  const key = [...emails].sort().join(",");
  if (cache && cache.key === key && now - cache.at < TTL_MS) return cache;
  const teacherIds = await teacherIdsFor(db, emails);
  let classIds: string[] = [];
  if (teacherIds.size) {
    const { data, error } = await db.from("classes").select("id").in("teacher_id", [...teacherIds]);
    if (error) throw new Error(`classes: ${error.message ?? "failed"}`);
    classIds = (data ?? []).map((r) => String(r.id));
  }
  cache = { key, at: now, teacherIds, classIds };
  return cache;
}

/**
 * True when `studentId` is currently enrolled in a class taught by a verified
 * user on `teacherEmails` (normalised: trimmed, lower-cased). Throws on any
 * lookup error — the caller fails closed.
 */
export async function isStudentOfAllowedTeacher(studentId: string, teacherEmails: string[], now = Date.now()): Promise<boolean> {
  if (!studentId || !teacherEmails.length) return false;
  const db = admin();
  const snap = await snapshot(db, teacherEmails, now);
  if (!snap.classIds.length) return false;
  if (snap.teacherIds.has(studentId)) return false; // the teacher is not their own student
  const { data, error } = await db.from("enrollments").select("class_id").eq("student_id", studentId).in("class_id", snap.classIds).limit(1);
  if (error) throw new Error(`enrollments: ${error.message ?? "failed"}`);
  return (data ?? []).length > 0;
}
