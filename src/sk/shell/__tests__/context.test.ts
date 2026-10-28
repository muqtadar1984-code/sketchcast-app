/**
 * SK Shell Context (Final Plan §2.2): pageFor, the pure buildContext, the
 * context hash, and the server loader against fakes.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/context.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/platform-admin", () => ({
  founderEmails: () => ["founder@sketchcast.app"],
  staffUserIds: async (admin: { from: (t: string) => { select: () => { is: () => Promise<{ data: { user_id: string }[] }> } } }) => {
    const { data } = await admin.from("platform_admins").select().is();
    return new Set((data ?? []).map((r) => r.user_id));
  },
}));

import { buildContext, effectiveRoles, loadContext, pageFor, roleFor, sanitizeSelection } from "../context";
import { contextHash } from "../hash";
import { NOW, SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, makeCtx } from "./fixtures";

const ENV = ["FEATURE_ROLE_HATS", "FEATURE_DIARY", "FEATURE_SCHOOL_ANALYTICS", "FEATURE_TIMETABLE", "FEATURE_CALENDAR", "FEATURE_CATALOGUE_TAB", "FEATURE_PARENT_PORTAL", "FEATURE_SK", "PRESENT_ALLOWED_EMAILS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("pageFor", () => {
  it.each([
    ["/dashboard", "library"],
    ["/dashboard/", "library"],
    ["/dashboard?x=1", "library"],
    ["/dashboard/analytics", "analytics"],
    ["/dashboard/analytics?c=abc", "analytics"],
    ["/present", "board"],
    ["/present/abc", "board"],
    ["/dashboard/children", "children"],
    ["/dashboard/school", "school"],
    ["/dashboard/school/teachers", "school"],
    ["/dashboard/school/diary", "school"],
    ["/dashboard/school/timetable", "timetable"],
    ["/dashboard/my-timetable", "timetable"],
    ["/sk", "tutor"],
    ["/sk/session/1", "tutor"],
    ["/dashboard/kits", "kits"],
    ["/dashboard/diary", "diary"],
    ["/dashboard/calendar", "calendar"],
    ["/console/ops", "console"],
    ["/dashboard/reports/abc", "library"],
    ["/login", "other"],
    ["", "other"],
  ])("%s → %s", (path, page) => {
    expect(pageFor(path)).toBe(page);
  });
});

describe("buildContext (pure)", () => {
  it("takes nothing permission-bearing from the collector", () => {
    const ctx = buildContext({
      user: { id: TEACHER_ID, email: "t@x" },
      role: "teacher",
      schoolId: SCHOOL_ID,
      hat: "teacher",
      coordinatorScope: [],
      plan: "school",
      staff: false,
      flags: { analytics: true },
      collector: {
        path: "/dashboard/analytics",
        params: { c: "abc" },
        selection: { classId: "c1", bogus: "x" } as never,
        // A collector cannot promote itself.
        ...({ role: "school_admin", hat: "principal" } as object),
      },
      now: NOW,
    });
    expect(ctx.user.role).toBe("teacher");
    expect(ctx.user.hat).toBe("teacher");
    expect(ctx.place).toEqual({ path: "/dashboard/analytics", page: "analytics", params: { c: "abc" } });
    expect(ctx.selection).toEqual({ classId: "c1" });
    expect(ctx.flags).toEqual({ analytics: true, hasScope: false });
    expect(ctx.issuedAt).toBe(NOW.toISOString());
    expect(ctx.ttlSeconds).toBe(4 * 3600);
  });
  it("normalises unknown roles to student and strips a student's hat", () => {
    expect(roleFor(null)).toBe("student");
    expect(roleFor("ADMIN")).toBe("student");
    expect(roleFor("School_Admin")).toBe("school_admin");
    const ctx = makeCtx({ role: "student", hat: "teacher" });
    expect(ctx.user.hat).toBeNull();
  });
  it("sanitises the selection to known keys and bounded strings", () => {
    expect(sanitizeSelection({ classId: " c1 ", learnerId: "x".repeat(200), chapterRef: 3 })).toEqual({ classId: "c1" });
    expect(sanitizeSelection(null)).toEqual({});
  });
  it("effective roles add coordinator only for an adult with scope rows", () => {
    expect(effectiveRoles(makeCtx({ role: "teacher", scope: [{ grade: "7", subject: null }] }))).toEqual(["teacher", "coordinator"]);
    expect(effectiveRoles(makeCtx({ role: "teacher" }))).toEqual(["teacher"]);
    expect(effectiveRoles(makeCtx({ role: "parent", scope: [{ grade: "7", subject: null }] }))).toEqual(["parent"]);
  });
});

describe("contextHash", () => {
  it("is sha256 hex of role|schoolId|hat|plan, stable, and changes with any part", () => {
    const base = { role: "teacher", schoolId: SCHOOL_ID, hat: "teacher", plan: "school" };
    const h = contextHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contextHash(base)).toBe(h);
    expect(contextHash({ ...base, hat: "principal" })).not.toBe(h);
    expect(contextHash({ ...base, schoolId: null })).not.toBe(h);
    expect(contextHash({ ...base, role: "parent" })).not.toBe(h);
    expect(contextHash({ ...base, plan: "trial" })).not.toBe(h);
    expect(makeCtx().contextHash).toBe(h);
  });
});

describe("loadContext (server loader, fakes)", () => {
  const user = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
  it("builds a teacher context: plan from the admin rpc, flags from env, hat from the cookie", async () => {
    process.env.FEATURE_ROLE_HATS = "true";
    process.env.FEATURE_DIARY = "true";
    process.env.FEATURE_SCHOOL_ANALYTICS = "true";
    process.env.FEATURE_CATALOGUE_TAB = "true";
    const session = fakeSession({ coordinator_scope: [{ grade: "7", subject: "Science" }], parent_links: [], schools: [{ config: {} }] }, { user });
    const admin = fakeAdmin("school");
    const ctx = await loadContext({
      session,
      admin,
      cookies: { get: (n) => (n === "sc_hat" ? { value: "coordinator" } : undefined) },
      user,
      profile: { role: "teacher", school_id: SCHOOL_ID },
      collector: { path: "/dashboard/school" },
      locale: "ms",
      now: NOW,
    });
    expect(ctx.user.plan).toBe("school");
    expect(ctx.user.hat).toBe("coordinator");
    expect(ctx.user.coordinatorScope).toEqual([{ grade: "7", subject: "Science" }]);
    expect(ctx.user.locale).toBe("ms");
    expect(ctx.flags.analytics).toBe(true);
    expect(ctx.flags.diary).toBe(true);
    expect(ctx.flags.kits).toBe(true);
    expect(ctx.flags.hasScope).toBe(true);
    expect(ctx.flags.board).toBe(true); // school plan → board via the school
    expect(ctx.place.page).toBe("school");
    // The scope read is pinned to the user AND the school.
    expect(session.log.some((l) => l.startsWith("coordinator_scope.eq(\"coordinator_id\""))).toBe(true);
    expect(session.log.some((l) => l.startsWith("coordinator_scope.eq(\"school_id\""))).toBe(true);
  });
  it("falls back: a cookie for a hat the user does not hold → most senior held hat; no admin → plan unknown", async () => {
    process.env.FEATURE_ROLE_HATS = "true";
    const session = fakeSession({ coordinator_scope: [], parent_links: [], schools: [{ config: {} }] }, { user });
    const ctx = await loadContext({
      session,
      admin: null,
      cookies: { get: () => ({ value: "principal" }) },
      user,
      profile: { role: "teacher", school_id: SCHOOL_ID },
      collector: { path: "/dashboard" },
      now: NOW,
    });
    expect(ctx.user.hat).toBe("teacher");
    expect(ctx.user.plan).toBe("unknown");
    expect(ctx.user.locale).toBe("en");
  });
  it("hats off → hat null; founder e-mail → staff; student runs no adult reads", async () => {
    const session = fakeSession({}, { user });
    const ctx = await loadContext({
      session,
      admin: fakeAdmin("trial"),
      cookies: { get: () => ({ value: "teacher" }) },
      user: { ...user, email: "founder@sketchcast.app" },
      profile: { role: "student", school_id: SCHOOL_ID },
      collector: { path: "/sk" },
      now: NOW,
    });
    expect(ctx.user.hat).toBeNull();
    expect(ctx.user.staff).toBe(true);
    expect(ctx.user.role).toBe("student");
    expect(session.log.filter((l) => l.startsWith("coordinator_scope") || l.startsWith("parent_links"))).toEqual([]);
  });
});

describe("loadContext reads run side by side (fix/sk-speed)", () => {
  const user = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
  it("every independent read (scope, parent links, three tenant flags, plan_tier, staff) has STARTED before any one resolves", async () => {
    process.env.FEATURE_ROLE_HATS = "true";
    process.env.FEATURE_PARENT_PORTAL = "true";
    // The three tenant flags OFF globally, so each one reads schools.config
    // (an env "true" short-circuits the read and there is nothing to time).
    delete process.env.FEATURE_SCHOOL_ANALYTICS;
    delete process.env.FEATURE_TIMETABLE;
    delete process.env.FEATURE_CALENDAR;
    const started: string[] = [];
    let release!: () => void;
    const gateP = new Promise<void>((r) => (release = r));
    // A session whose every query resolves only when the test lets it go.
    const slowSession = {
      from: (table: string) => {
        started.push(table);
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const b: any = {};
        for (const m of ["select", "eq", "in", "is", "limit", "order"]) b[m] = () => b;
        b.maybeSingle = () => b;
        b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => gateP.then(() => ({ data: table === "schools" ? { config: {} } : [], error: null })).then(res, rej);
        /* eslint-enable @typescript-eslint/no-explicit-any */
        return b;
      },
    };
    const admin = {
      from: (table: string) => {
        started.push(`admin.${table}`);
        return { select: () => ({ is: () => gateP.then(() => ({ data: [], error: null })) }) };
      },
      rpc: (fn: string) => {
        started.push(`rpc.${fn}`);
        return gateP.then(() => ({ data: "school", error: null }));
      },
    };
    const pending = loadContext({ session: slowSession, admin, cookies: null, user, profile: { role: "teacher", school_id: SCHOOL_ID }, collector: { path: "/dashboard" }, now: NOW });
    await new Promise((r) => setTimeout(r, 0));
    // Nothing has resolved, yet every read is in flight.
    expect(started).toContain("coordinator_scope");
    expect(started).toContain("parent_links");
    expect(started).toContain("rpc.plan_tier");
    expect(started).toContain("admin.platform_admins");
    expect(started.filter((t) => t === "schools").length).toBeGreaterThanOrEqual(3); // the three tenant flags
    release();
    const ctx = await pending;
    expect(ctx.user.plan).toBe("school");
    expect(ctx.user.role).toBe("teacher");
  });
});
