/**
 * Password-reset scope tests — the invariants a reviewer must see hold:
 *   * nobody resets themselves, a school_admin, or platform staff — ever
 *   * students reset nobody
 *   * each grant (teacher / parent / school_admin / coordinator) opens exactly
 *     its own slice and nothing outside it (wrong school, wrong grade, no link)
 *   * temp passwords are readable, long enough, and free of ambiguous glyphs
 * Run: npx vitest run
 */

import { describe, expect, it } from "vitest";
import {
  decideReset,
  type ResetActor,
  type ResetEvidence,
  type ResetTarget,
} from "../reset-scope";
import { generateTempPassword } from "../temp-password";

// ── builders (override only what a case is about) ────────────────────────────
const caller = (over: Partial<ResetActor> = {}): ResetActor => ({
  id: "caller-1",
  role: "teacher",
  schoolId: "school-1",
  ...over,
});
const target = (over: Partial<ResetTarget> = {}): ResetTarget => ({
  id: "target-1",
  role: "student",
  schoolId: "school-1",
  isPlatformAdmin: false,
  ...over,
});
const evidence = (over: Partial<ResetEvidence> = {}): ResetEvidence => ({
  targetInCallerClass: false,
  parentLinked: false,
  coordinatorGrades: [],
  targetGradesInCallerSchool: [],
  ...over,
});

const allowedVia = (c: ResetActor, t: ResetTarget, e: ResetEvidence) => {
  const d = decideReset(c, t, e);
  expect(d.allowed).toBe(true);
  return d.allowed ? d.via : null;
};
const denied = (c: ResetActor, t: ResetTarget, e: ResetEvidence) => {
  expect(decideReset(c, t, e).allowed).toBe(false);
};

describe("decideReset — never-allow guards", () => {
  it("denies resetting yourself, even with every grant in hand", () => {
    denied(
      caller({ id: "u1", role: "school_admin" }),
      target({ id: "u1", role: "student" }),
      evidence({ targetInCallerClass: true, parentLinked: true }),
    );
  });

  it("denies platform-staff targets, even for a same-school admin", () => {
    denied(caller({ role: "school_admin" }), target({ role: "teacher", isPlatformAdmin: true }), evidence());
  });

  it("denies school_admin targets — by another school_admin too", () => {
    denied(caller({ role: "school_admin" }), target({ role: "school_admin" }), evidence());
  });

  it("denies platform-staff STUDENT target even for their own teacher", () => {
    denied(caller(), target({ isPlatformAdmin: true }), evidence({ targetInCallerClass: true }));
  });

  it("denies student callers regardless of evidence", () => {
    denied(
      caller({ role: "student" }),
      target(),
      evidence({ targetInCallerClass: true, parentLinked: true }),
    );
  });

  it("denies callers with no role", () => {
    denied(caller({ role: null }), target(), evidence({ parentLinked: true }));
  });
});

describe("decideReset — teacher rule (a)", () => {
  it("allows a teacher to reset a student enrolled in their class", () => {
    expect(allowedVia(caller(), target(), evidence({ targetInCallerClass: true }))).toBe("teacher");
  });

  it("denies a teacher for a student NOT in any of their classes", () => {
    denied(caller(), target(), evidence());
  });

  it("does not apply to non-student targets (enrollment evidence is student-only)", () => {
    denied(caller(), target({ role: "teacher" }), evidence({ targetInCallerClass: true }));
  });

  it("wins as the FIRST match when the caller is also the linked parent", () => {
    expect(
      allowedVia(caller(), target(), evidence({ targetInCallerClass: true, parentLinked: true })),
    ).toBe("teacher");
  });
});

describe("decideReset — parent rule (b)", () => {
  it("allows a parent to reset a linked child", () => {
    expect(allowedVia(caller({ role: "parent", schoolId: null }), target(), evidence({ parentLinked: true }))).toBe(
      "parent",
    );
  });

  it("denies a parent with no link to the target", () => {
    denied(caller({ role: "parent", schoolId: null }), target(), evidence());
  });
});

describe("decideReset — school_admin rule (c)", () => {
  it("allows an admin to reset a teacher in their school", () => {
    expect(allowedVia(caller({ role: "school_admin" }), target({ role: "teacher" }), evidence())).toBe(
      "school_admin",
    );
  });

  it("allows an admin to reset a student in their school", () => {
    expect(allowedVia(caller({ role: "school_admin" }), target(), evidence())).toBe("school_admin");
  });

  it("denies an admin for a member of ANOTHER school", () => {
    denied(caller({ role: "school_admin" }), target({ role: "teacher", schoolId: "school-2" }), evidence());
  });

  it("denies an admin with no school at all (never matches a null school)", () => {
    denied(
      caller({ role: "school_admin", schoolId: null }),
      target({ role: "teacher", schoolId: null }),
      evidence(),
    );
  });

  it("denies a plain teacher the school-wide reach", () => {
    denied(caller(), target({ role: "teacher" }), evidence());
  });
});

describe("decideReset — coordinator rule (d)", () => {
  const withScope = evidence({ coordinatorGrades: ["5"], targetGradesInCallerSchool: ["5"] });

  it("allows a scope-holder to reset a student in a granted grade", () => {
    expect(allowedVia(caller(), target(), withScope)).toBe("coordinator");
  });

  it("works for the legacy coordinator enum too (grant model, not the enum)", () => {
    expect(allowedVia(caller({ role: "coordinator" }), target(), withScope)).toBe("coordinator");
  });

  it("denies when the student's grades don't intersect the grant", () => {
    denied(caller(), target(), evidence({ coordinatorGrades: ["5"], targetGradesInCallerSchool: ["6"] }));
  });

  it("denies for a student of another school even when grades match", () => {
    denied(caller(), target({ schoolId: "school-2" }), withScope);
  });

  it("never applies to non-student targets", () => {
    denied(caller(), target({ role: "teacher" }), withScope);
  });

  it("empty grade strings grant nothing", () => {
    denied(caller(), target(), evidence({ coordinatorGrades: [""], targetGradesInCallerSchool: [""] }));
  });
});

describe("generateTempPassword", () => {
  const samples = Array.from({ length: 200 }, () => generateTempPassword());

  it("is three lowercase words plus two digits", () => {
    for (const p of samples) expect(p).toMatch(/^[a-z]{3,5}-[a-z]{3,5}-[a-z]{3,5}[2-9]{2}$/);
  });

  it("is at least 8 characters (shortest possible shape is 13)", () => {
    for (const p of samples) expect(p.length).toBeGreaterThanOrEqual(13);
  });

  it("never contains ambiguous glyphs (0/O, 1/l/I, lowercase o)", () => {
    for (const p of samples) expect(p).not.toMatch(/[01OIlo]/);
  });

  it("varies between calls", () => {
    expect(new Set(samples).size).toBeGreaterThan(1);
  });
});
