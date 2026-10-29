// SK restricted live, widened (founder 2026-10-30): "ensure that SK is
// accessible by only <founder>, <Sara> and her students till I pass the test".
// "Her students" = the students of Sara's classes, NOT the founder's own.
//
// skAccessAllowed() is the async gate every SK surface awaits. Pinned here:
//   * both lists unset ⇒ everyone passes (today's behaviour, the release);
//   * SK_ALLOWED_EMAILS ⇒ a VERIFIED address on it;
//   * SK_ALLOWED_STUDENTS_OF ⇒ a student CURRENTLY enrolled in a class of a
//     VERIFIED teacher on it — with no address of their own needed;
//   * any lookup error ⇒ refused (fail closed), logged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skAccessAllowed, skAllowListInForce, skAllowedStudentsOf, skShellDecision, skShellEnabledFor, skUserAllowed } from "../flags";
import { __setSkAccessAdminForTests, isStudentOfAllowedTeacher } from "@/sk/access-gate";
import {
  ACCESS_ENV,
  FOUNDER,
  FOUNDER_STUDENT,
  RANDOM_TEACHER,
  SARA,
  SARA_LEAVER,
  SARA_STUDENT,
  SARA_STUDENT_UNVERIFIED,
  accessFake,
  type AccessFake,
} from "@/sk/__tests__/access-fixture";

const ENV = ["SK_ALLOWED_EMAILS", "SK_ALLOWED_STUDENTS_OF", "FEATURE_SK", "SK_ROLES", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER"];
const saved: Record<string, string | undefined> = {};
let fake: AccessFake;

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  fake = accessFake();
  __setSkAccessAdminForTests(() => fake.admin);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setSkAccessAdminForTests(null);
  vi.restoreAllMocks();
});

const founderRequest = () => Object.assign(process.env, ACCESS_ENV);

describe("skAccessAllowed — the founder's request", () => {
  it("admits the founder (verified, on SK_ALLOWED_EMAILS)", async () => {
    founderRequest();
    expect(await skAccessAllowed(FOUNDER, { role: "teacher" })).toBe(true);
    expect(fake.calls.listUsers).toBe(0); // the email half decides; no lookup
  });

  it("admits Sara", async () => {
    founderRequest();
    expect(await skAccessAllowed(SARA, { role: "teacher" })).toBe(true);
  });

  it("admits Sara's enrolled student with NO address", async () => {
    founderRequest();
    expect(await skAccessAllowed(SARA_STUDENT, { role: "student" })).toBe(true);
    expect(await skAccessAllowed(SARA_STUDENT)).toBe(true); // role unknown: still looked up
  });

  it("admits Sara's enrolled student with an UNVERIFIED address", async () => {
    founderRequest();
    expect(await skAccessAllowed(SARA_STUDENT_UNVERIFIED, { role: "student" })).toBe(true);
    expect(skUserAllowed(SARA_STUDENT_UNVERIFIED)).toBe(false); // the email-only half would not
  });

  it("refuses the founder's own student (the founder is not on SK_ALLOWED_STUDENTS_OF)", async () => {
    founderRequest();
    expect(await skAccessAllowed(FOUNDER_STUDENT, { role: "student" })).toBe(false);
  });

  it("refuses a student who left Sara's class (no enrollment), and does so at once", async () => {
    founderRequest();
    expect(await skAccessAllowed(SARA_LEAVER, { role: "student" })).toBe(false);
    // A student removed now loses access on the next request: enrollments are never cached.
    expect(await skAccessAllowed(SARA_STUDENT, { role: "student" })).toBe(true);
    fake.enrollments.splice(fake.enrollments.findIndex((e) => e.student_id === SARA_STUDENT.id), 1);
    expect(await skAccessAllowed(SARA_STUDENT, { role: "student" })).toBe(false);
  });

  it("refuses a random teacher, a random teacher claiming the student role, and anonymous", async () => {
    founderRequest();
    expect(await skAccessAllowed(RANDOM_TEACHER, { role: "teacher" })).toBe(false);
    expect(await skAccessAllowed(RANDOM_TEACHER, { role: "student" })).toBe(false);
    expect(await skAccessAllowed(null)).toBe(false);
    expect(await skAccessAllowed(undefined)).toBe(false);
  });

  it("an adult role never takes the student path (no lookup)", async () => {
    founderRequest();
    expect(await skAccessAllowed(SARA_STUDENT, { role: "parent" })).toBe(false);
    expect(fake.calls.enrollments).toBe(0);
  });

  it("Sara's students are out if Sara's address is not VERIFIED", async () => {
    founderRequest();
    fake.users.find((u) => u.id === SARA.id)!.email_confirmed_at = null;
    expect(await skAccessAllowed(SARA_STUDENT, { role: "student" })).toBe(false);
  });

  it("works with only SK_ALLOWED_STUDENTS_OF set (no adults listed)", async () => {
    process.env.SK_ALLOWED_STUDENTS_OF = SARA.email;
    expect(skAllowListInForce()).toBe(true);
    expect(await skAccessAllowed(SARA_STUDENT, { role: "student" })).toBe(true);
    expect(await skAccessAllowed(SARA, { role: "teacher" })).toBe(false); // the teacher herself needs SK_ALLOWED_EMAILS
    expect(skUserAllowed(FOUNDER)).toBe(false); // the sync half never widens
  });
});

describe("skAccessAllowed — fail closed", () => {
  it.each(["listUsers", "classes", "enrollments"] as const)("a %s error refuses and logs", async (what) => {
    founderRequest();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.fail[what] = true;
    expect(await skAccessAllowed(SARA_STUDENT, { role: "student" })).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[sk-access]"), expect.any(String));
    // The log carries no address from the list.
    expect(JSON.stringify(log.mock.calls)).not.toContain(SARA.email);
  });

  it("the admin client failing to construct refuses", async () => {
    founderRequest();
    vi.spyOn(console, "error").mockImplementation(() => {});
    __setSkAccessAdminForTests(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    });
    expect(await skAccessAllowed(SARA_STUDENT, { role: "student" })).toBe(false);
  });

  it("the email half still admits the founder while the lookup is down", async () => {
    founderRequest();
    fake.fail.listUsers = true;
    expect(await skAccessAllowed(FOUNDER, { role: "teacher" })).toBe(true);
  });
});

describe("skAccessAllowed — lists unset is today's behaviour", () => {
  it("both unset (or blank) ⇒ everyone passes, nothing is looked up", async () => {
    expect(skAllowListInForce()).toBe(false);
    for (const u of [FOUNDER, SARA, RANDOM_TEACHER, SARA_STUDENT, FOUNDER_STUDENT, null]) expect(await skAccessAllowed(u)).toBe(true);
    process.env.SK_ALLOWED_EMAILS = " , ";
    process.env.SK_ALLOWED_STUDENTS_OF = "";
    expect(await skAccessAllowed(RANDOM_TEACHER)).toBe(true);
    expect(fake.calls.listUsers + fake.calls.classes + fake.calls.enrollments).toBe(0);
  });

  it("parses SK_ALLOWED_STUDENTS_OF like SK_ALLOWED_EMAILS (trim, quotes, lower-case)", () => {
    process.env.SK_ALLOWED_STUDENTS_OF = ` "${SARA.email.toUpperCase()}" ,, `;
    expect(skAllowedStudentsOf()).toEqual([SARA.email]);
  });
});

describe("the teacher/class cache (60 s per instance)", () => {
  it("one listUsers + one classes read per minute; enrollments every time", async () => {
    const t0 = 1_000_000;
    expect(await isStudentOfAllowedTeacher(SARA_STUDENT.id, [SARA.email], t0)).toBe(true);
    expect(await isStudentOfAllowedTeacher(SARA_STUDENT_UNVERIFIED.id, [SARA.email], t0 + 59_000)).toBe(true);
    expect(fake.calls).toEqual({ listUsers: 1, classes: 1, enrollments: 2 });
    expect(await isStudentOfAllowedTeacher(SARA_STUDENT.id, [SARA.email], t0 + 61_000)).toBe(true);
    expect(fake.calls.listUsers).toBe(2);
  });

  it("a changed teacher list is a different cache key", async () => {
    expect(await isStudentOfAllowedTeacher(FOUNDER_STUDENT.id, [SARA.email], 5)).toBe(false);
    expect(await isStudentOfAllowedTeacher(FOUNDER_STUDENT.id, [SARA.email, FOUNDER.email], 6)).toBe(true);
  });

  it("walks every listUsers page", async () => {
    // 1000 filler users push Sara onto page 2.
    fake.users.unshift(...Array.from({ length: 1000 }, (_, i) => ({ id: `filler-${i}`, email: `f${i}@example.test`, email_confirmed_at: "x" })));
    expect(await isStudentOfAllowedTeacher(SARA_STUDENT.id, [SARA.email])).toBe(true);
    expect(fake.calls.listUsers).toBe(2);
  });
});

describe("the Shell gate uses the async gate", () => {
  it("Sara's student gets the Shell (students in SK_ROLES), skipping the tenant opt-in like an allow-listed adult", async () => {
    founderRequest();
    process.env.FEATURE_SK = "true";
    process.env.SK_ROLES = "teacher,student";
    const supabase = { from: () => { throw new Error("no school read while the allow-list is in force"); } } as never;
    expect(await skShellEnabledFor(supabase, SARA_STUDENT, "student", null)).toBe(true);
    expect(await skShellEnabledFor(supabase, SARA_STUDENT, "student", "school-1")).toBe(true);
    expect(await skShellEnabledFor(supabase, FOUNDER_STUDENT, "student", null)).toBe(false);
    expect(await skShellEnabledFor(supabase, RANDOM_TEACHER, "teacher", null)).toBe(false);
    expect(await skShellEnabledFor(supabase, SARA, "teacher", null)).toBe(true);
    expect(await skShellEnabledFor(supabase, FOUNDER, "teacher", null)).toBe(true);
  });

  it("keeps the role gate: a student is out while SK_ROLES lacks 'student' (no lookup spent)", async () => {
    founderRequest();
    process.env.FEATURE_SK = "true";
    process.env.SK_ROLES = "teacher";
    expect(await skShellEnabledFor({} as never, SARA_STUDENT, "student", null)).toBe(false);
    expect(fake.calls.listUsers).toBe(0);
  });

  it("the pure decision honours a resolved `allowed` and never widens without one", () => {
    founderRequest();
    process.env.FEATURE_SK = "true";
    process.env.SK_ROLES = "student";
    const base = { role: "student", user: SARA_STUDENT, schoolId: null, schoolOptIn: null };
    expect(skShellDecision({ ...base, allowed: true })).toEqual({ on: true, reason: "ok" });
    expect(skShellDecision({ ...base, allowed: false })).toEqual({ on: false, reason: "not_allowed" });
    expect(skShellDecision(base)).toEqual({ on: false, reason: "not_allowed" }); // email-only: no address
  });
});
