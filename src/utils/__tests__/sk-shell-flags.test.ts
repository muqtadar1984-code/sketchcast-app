// SK Shell gate (Final Plan §6: FEATURE_SK + SK_ROLES + per-school opt-in).
// Pure decision matrix; the async wrapper only adds the schools.config read.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skShellDecision, skShellEnabledFor, skShellRoles } from "../flags";

const ENV = ["FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const verified = { email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
const school = (optIn: boolean | null, role = "teacher") =>
  skShellDecision({ role, user: verified, schoolId: "s1", schoolOptIn: optIn });

describe("skShellDecision", () => {
  it("is off when FEATURE_SK is off, whatever else is set", () => {
    process.env.FEATURE_SK = "false";
    process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
    expect(school(true)).toEqual({ on: false, reason: "flag_off" });
  });

  it("defaults SK_ROLES to the teacher only (§1: the teacher is first)", () => {
    expect(skShellRoles()).toEqual(["teacher"]);
    expect(school(true, "teacher").on).toBe(true);
    for (const r of ["student", "parent", "school_admin", "coordinator"]) {
      expect(school(true, r)).toEqual({ on: false, reason: "role_off" });
    }
    process.env.SK_ROLES = "teacher, School_Admin";
    expect(school(true, "school_admin").on).toBe(true);
    expect(school(true, "parent").on).toBe(false);
  });

  it("needs the school's opt-in unless every school is switched on", () => {
    expect(school(true)).toEqual({ on: true, reason: "ok" });
    expect(school(false)).toEqual({ on: false, reason: "school_opt_out" });
    expect(school(null)).toEqual({ on: false, reason: "school_opt_out" });
    process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
    expect(school(null).on).toBe(true);
  });

  it("a user with no school needs SK_SHELL_CONSUMER", () => {
    const consumer = skShellDecision({ role: "teacher", user: verified, schoolId: null, schoolOptIn: null });
    expect(consumer).toEqual({ on: false, reason: "consumer_off" });
    process.env.SK_SHELL_CONSUMER = "true";
    expect(skShellDecision({ role: "teacher", user: verified, schoolId: null, schoolOptIn: null }).on).toBe(true);
  });

  it("the allow-list only narrows: off-list users are out, on-list users skip the tenant opt-in", () => {
    process.env.SK_ALLOWED_EMAILS = "staff@sketchcast.app";
    expect(school(true)).toEqual({ on: false, reason: "not_allowed" });
    const staff = { email: "Staff@sketchcast.app", email_confirmed_at: "2026-01-01T00:00:00Z" };
    expect(skShellDecision({ role: "teacher", user: staff, schoolId: "s1", schoolOptIn: false }).on).toBe(true);
    expect(skShellDecision({ role: "teacher", user: staff, schoolId: null, schoolOptIn: null }).on).toBe(true);
    // but never the role gate
    expect(skShellDecision({ role: "student", user: staff, schoolId: "s1", schoolOptIn: true })).toEqual({ on: false, reason: "role_off" });
    // and an unverified address on the list is still out
    expect(skShellDecision({ role: "teacher", user: { email: "staff@sketchcast.app" }, schoolId: "s1", schoolOptIn: true }).on).toBe(false);
  });
});

describe("skShellEnabledFor", () => {
  const fakeDb = (config: unknown, error: unknown = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: config === undefined ? null : { config }, error }) }) }) }),
  });

  it("reads schools.config.sk_shell through the caller's session", async () => {
    expect(await skShellEnabledFor(fakeDb({ sk_shell: true }) as never, verified, "teacher", "s1")).toBe(true);
    expect(await skShellEnabledFor(fakeDb({ sk_shell: false }) as never, verified, "teacher", "s1")).toBe(false);
    expect(await skShellEnabledFor(fakeDb({}) as never, verified, "teacher", "s1")).toBe(false);
    expect(await skShellEnabledFor(fakeDb(null, { code: "42703" }) as never, verified, "teacher", "s1")).toBe(false);
  });

  it("never queries when the flag is off or the allow-list decides", async () => {
    const throwing = { from: () => { throw new Error("must not query"); } };
    process.env.FEATURE_SK = "false";
    expect(await skShellEnabledFor(throwing as never, verified, "teacher", "s1")).toBe(false);
    process.env.FEATURE_SK = "true";
    process.env.SK_ALLOWED_EMAILS = "t@school.example";
    expect(await skShellEnabledFor(throwing as never, verified, "teacher", "s1")).toBe(true);
  });
});
