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

  it("REFUSES A TRIAL TEACHER, with a reason that is about the plan", () => {
    expect(presentAccess(facts({ tier: "trial" }))).toEqual({ ok: false, why: "plan" });
  });

  it("refuses the launch-promo tier — a promo is not a subscription", () => {
    expect(presentAccess(facts({ tier: "promo" }))).toEqual({ ok: false, why: "plan" });
  });

  it("refuses homeschool and family, which were not in the founder's rule", () => {
    // Recorded rather than assumed: "the only gate for individual teachers should
    // be pro or pro+". Both are paying customers who teach, so this is the line
    // most likely to move — and when it does, it moves in PRESENT_TIERS alone.
    expect(presentAccess(facts({ tier: "homeschool" }))).toEqual({ ok: false, why: "plan" });
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

describe("the self-serve school states (0100)", () => {
  it("a trial school gets the board, via the school — the founder's call, 2026-09-03", () => {
    expect(presentAccess(facts({ tier: "school_trial" }))).toEqual({ ok: true, via: "school" });
    expect(presentAccess(facts({ role: "school_admin", tier: "school_trial" }))).toEqual({ ok: true, via: "school" });
  });
  it("a trial school's students still never drive it — a plan is not a role", () => {
    expect(presentAccess(facts({ role: "student", tier: "school_trial" }))).toEqual({ ok: false, why: "not-teaching" });
  });
  it("the two locked states are out, like the individual trial", () => {
    expect(presentAccess(facts({ tier: "school_expired" }))).toEqual({ ok: false, why: "plan" });
    expect(presentAccess(facts({ tier: "school_suspended" }))).toEqual({ ok: false, why: "plan" });
  });
});

describe("a tier this build has never heard of", () => {
  it("FAILS CLOSED, and that is the hazard worth naming", () => {
    // Failing closed is the right default, and it is also the silent one: a
    // tier plan_tier() gains tomorrow will not get the board and nothing will
    // explain it. Pinned so the set is revisited rather than left alone.
    expect(presentAccess(facts({ tier: "something_new" }))).toEqual({ ok: false, why: "plan" });
  });
});

describe("the sets themselves", () => {
  it("carries exactly the three plans the founder named, plus the school trial", () => {
    expect([...PRESENT_TIERS].sort()).toEqual(["pro", "pro_plus", "school", "school_trial"]);
  });

  it("denies exactly the two roles that do not teach", () => {
    expect([...NON_TEACHING_ROLES].sort()).toEqual(["parent", "student"]);
  });

});
