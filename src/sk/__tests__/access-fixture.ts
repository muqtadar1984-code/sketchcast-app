// Shared fixture for the SK allow-list tests (founder 2026-10-30: SK only for
// the founder, Sara, and Sara's students). Placeholder addresses only — never
// the live ones. An in-memory stand-in for the slice of the service-role client
// src/sk/access-gate.ts reads: auth.admin.listUsers, classes, enrollments.

import type { AccessAdmin } from "@/sk/access-gate";

export const CONFIRMED = "2026-01-01T00:00:00Z";
export const FOUNDER = { id: "00000000-0000-4000-8000-0000000000f0", email: "founder@example.test", email_confirmed_at: CONFIRMED };
export const SARA = { id: "00000000-0000-4000-8000-0000000000a0", email: "sara@example.test", email_confirmed_at: CONFIRMED };
export const RANDOM_TEACHER = { id: "00000000-0000-4000-8000-0000000000c0", email: "random-teacher@example.test", email_confirmed_at: CONFIRMED };
/** Sara's enrolled student with no address at all (teacher-created account). */
export const SARA_STUDENT = { id: "00000000-0000-4000-8000-0000000000a1", email: null, email_confirmed_at: null };
/** Sara's enrolled student with an UNVERIFIED address. */
export const SARA_STUDENT_UNVERIFIED = { id: "00000000-0000-4000-8000-0000000000a2", email: "kid@example.test", email_confirmed_at: null };
/** Was in Sara's class, has left (no enrollment row). */
export const SARA_LEAVER = { id: "00000000-0000-4000-8000-0000000000a3", email: null, email_confirmed_at: null };
/** The founder's own student. */
export const FOUNDER_STUDENT = { id: "00000000-0000-4000-8000-0000000000f1", email: "f-kid@example.test", email_confirmed_at: CONFIRMED };

export const ACCESS_ENV = {
  SK_ALLOWED_EMAILS: `${FOUNDER.email},${SARA.email}`,
  SK_ALLOWED_STUDENTS_OF: SARA.email,
};

const AUTH_USERS = [FOUNDER, SARA, RANDOM_TEACHER, SARA_STUDENT, SARA_STUDENT_UNVERIFIED, SARA_LEAVER, FOUNDER_STUDENT];
const CLASSES = [
  { id: "c-sara-1", teacher_id: SARA.id },
  { id: "c-founder-1", teacher_id: FOUNDER.id },
  { id: "c-founder-2", teacher_id: FOUNDER.id },
  { id: "c-random-1", teacher_id: RANDOM_TEACHER.id },
];
const ENROLLMENTS = [
  { class_id: "c-sara-1", student_id: SARA_STUDENT.id },
  { class_id: "c-sara-1", student_id: SARA_STUDENT_UNVERIFIED.id },
  { class_id: "c-founder-1", student_id: FOUNDER_STUDENT.id },
  { class_id: "c-random-1", student_id: SARA_LEAVER.id }, // left Sara's class, now elsewhere
];

type Row = Record<string, unknown>;
export type AccessFake = {
  admin: AccessAdmin;
  calls: { listUsers: number; classes: number; enrollments: number };
  /** Make the next reads of this kind fail. */
  fail: { listUsers: boolean; classes: boolean; enrollments: boolean };
  /** Mutable copies, so a test can unverify a teacher or drop an enrollment. */
  users: typeof AUTH_USERS;
  enrollments: typeof ENROLLMENTS;
};

export function accessFake(): AccessFake {
  const users = AUTH_USERS.map((u) => ({ ...u }));
  const enrollments = ENROLLMENTS.map((e) => ({ ...e }));
  const calls = { listUsers: 0, classes: 0, enrollments: 0 };
  const fail = { listUsers: false, classes: false, enrollments: false };
  const tables: Record<string, Row[]> = { classes: CLASSES, enrollments };

  function query(table: "classes" | "enrollments") {
    const filters: Array<(r: Row) => boolean> = [];
    let cap = Infinity;
    const q = {
      in(col: string, vals: string[]) {
        filters.push((r) => vals.includes(String(r[col])));
        return q;
      },
      eq(col: string, val: string) {
        filters.push((r) => r[col] === val);
        return q;
      },
      limit(n: number) {
        cap = n;
        return q;
      },
      then<A, B>(ok?: ((v: { data: Row[] | null; error: { message: string } | null }) => A) | null, ko?: ((e: unknown) => B) | null) {
        calls[table]++;
        const res = fail[table]
          ? { data: null, error: { message: `${table} down` } }
          : { data: tables[table].filter((r) => filters.every((f) => f(r))).slice(0, cap), error: null };
        return Promise.resolve(res).then(ok, ko);
      },
    };
    return q;
  }

  const admin = {
    auth: {
      admin: {
        async listUsers({ page, perPage }: { page: number; perPage: number }) {
          calls.listUsers++;
          if (fail.listUsers) return { data: null, error: { message: "auth down" } };
          return { data: { users: users.slice((page - 1) * perPage, page * perPage) }, error: null };
        },
      },
    },
    from(table: string) {
      return { select: () => query(table as "classes" | "enrollments") };
    },
  } as unknown as AccessAdmin;

  return { admin, calls, fail, users, enrollments };
}
