import { describe, it, expect } from "vitest";
import {
  presentAccess,
  PRESENT_TIERS,
  NON_TEACHING_ROLES,
  type PresentFacts,
} from "@/utils/present/access";

const facts = (over: Partial<PresentFacts> = {}): PresentFacts => ({
  role: "teacher",
  tier: "trial",
  override: false,
  ...over,
});

describe("who the board is for", () => {
  it("LETS IN A PRO TEACHER — the whole point of the change", () => {
    expect(presentAccess(facts({ tier: "pro" }))).toEqual({ ok: true, via: "plan" });
  });

  it("lets in Pro+", () => {
    expect(presentAccess(facts({ tier: "pro_plus" }))).toEqual({ ok: true, via: "plan" });
  });

  it("LETS IN A SCHOOL TEACHER WITH NO PLAN OF THEIR OWN", () => {
    // "schools get this by default" — the school bought it, not the teacher.
    expect(presentAccess(facts({ tier: "school" }))).toEqual({ ok: true, via: "school" });
  });

  it("lets school leadership in, because they teach and cover", () => {
    expect(presentAccess(facts({ role: "school_admin", tier: "school" }))).toEqual({
      ok: true,
      via: "school",
    });
  });

  it("ADMITS A TRIAL TEACHER BY ROLE — the founder's rule of 2026-10-08", () => {
    // The demo school's eleven teachers and its principal all resolve to
    // `trial` (nothing is paid behind the sales-demo tenant) and had no Board
    // tab. "Ensure all users (except students and parents) have access to the
    // board": the role is the gate, the plan only names how.
    expect(presentAccess(facts({ tier: "trial" }))).toEqual({ ok: true, via: "role" });
  });

  it("admits the launch-promo tier, by role", () => {
    expect(presentAccess(facts({ tier: "promo" }))).toEqual({ ok: true, via: "role" });
  });

  it("admits homeschool by role; a family-plan PARENT is still not teaching", () => {
    expect(presentAccess(facts({ tier: "homeschool" }))).toEqual({ ok: true, via: "role" });
    expect(presentAccess(facts({ tier: "family", role: "parent" }))).toEqual({
      ok: false,
      why: "not-teaching",
    });
  });
});

describe("a plan is not a role", () => {
  it("REFUSES A STUDENT OF A PAYING SCHOOL", () => {
    // plan_tier returns 'school' for EVERY member of a school that has paid —
    // it answers "what is bought for this account", not "may this account
    // teach". Without this the pupils of a paying school could open their
    // teacher's whiteboard.
    expect(presentAccess(facts({ role: "student", tier: "school" }))).toEqual({
      ok: false,
      why: "not-teaching",
    });
  });

  it("refuses a parent of a paying school", () => {
    expect(presentAccess(facts({ role: "parent", tier: "school" }))).toEqual({
      ok: false,
      why: "not-teaching",
    });
  });

  it("refuses an unknown role — an unread profile is not a permission", () => {
    expect(presentAccess(facts({ role: null, tier: "school" }))).toEqual({
      ok: false,
      why: "not-teaching",
    });
  });

  it("ADMITS A COORDINATOR, whose profiles.role is 'teacher'", () => {
    // Coordinator is a scope grant in this schema, not a role. An allow-list of
    // teaching role names would have silently excluded every real one, which is
    // why the check is a deny-list.
    expect(presentAccess(facts({ role: "teacher", tier: "school" })).ok).toBe(true);
  });
});

describe("the staff override", () => {
  it("WINS OUTRIGHT, because the founder's own account is on `trial`", () => {
    // Without this, shipping the plan gate would have locked the only person
    // testing the feature out of it.
    expect(presentAccess(facts({ override: true, tier: "trial" }))).toEqual({
      ok: true,
      via: "override",
    });
  });

  it("still wins when nothing else could be resolved", () => {
    // The deployment-without-a-service-key case: no role, no tier, and staff
    // still need to get in and look.
    expect(presentAccess({ role: null, tier: null, override: true })).toEqual({
      ok: true,
      via: "override",
    });
  });

  it("refuses everyone else when nothing can be resolved", () => {
    expect(presentAccess({ role: null, tier: null, override: false })).toEqual({
      ok: false,
      why: "not-teaching",
    });
  });
});

describe("the self-serve school states (0101)", () => {
  it("a trial school gets the board, via the school — the founder's call, 2026-09-03", () => {
    expect(presentAccess(facts({ tier: "school_trial" }))).toEqual({ ok: true, via: "school" });
    expect(presentAccess(facts({ role: "school_admin", tier: "school_trial" }))).toEqual({ ok: true, via: "school" });
  });
  it("a trial school's students still never drive it — a plan is not a role", () => {
    expect(presentAccess(facts({ role: "student", tier: "school_trial" }))).toEqual({ ok: false, why: "not-teaching" });
  });
  it("the two locked states admit a TEACHER by role — and never a student", () => {
    // Since 2026-10-08 the plan refuses nobody who teaches; the school's state
    // decides what `via` says, not whether the board opens.
    expect(presentAccess(facts({ tier: "school_expired" }))).toEqual({ ok: true, via: "role" });
    expect(presentAccess(facts({ tier: "school_suspended" }))).toEqual({ ok: true, via: "role" });
    expect(presentAccess(facts({ role: "student", tier: "school_expired" }))).toEqual({
      ok: false,
      why: "not-teaching",
    });
  });
});

describe("a tier this build has never heard of", () => {
  it("admits a teacher by role — the hazard of failing closed is gone with the plan gate", () => {
    // A tier plan_tier() gains tomorrow no longer locks a teacher out; it
    // only fails to be NAMED in `via`. A student on it is still refused.
    expect(presentAccess(facts({ tier: "something_new" }))).toEqual({ ok: true, via: "role" });
    expect(presentAccess(facts({ role: "student", tier: "something_new" }))).toEqual({
      ok: false,
      why: "not-teaching",
    });
  });
});

describe("the sets themselves", () => {
  it("carries exactly the three plans the founder named, plus the school trial", () => {
    expect([...PRESENT_TIERS].sort()).toEqual(["pro", "pro_plus", "school", "school_trial", "staff"]);
  });

  it("denies exactly the two roles that do not teach", () => {
    expect([...NON_TEACHING_ROLES].sort()).toEqual(["parent", "student"]);
  });

});
