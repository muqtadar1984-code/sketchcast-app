import { describe, it, expect } from "vitest";
import { schoolLifecycle, daysUntil, duplicateFlags, sortSchools } from "../school-lifecycle";

const now = new Date("2026-09-03T12:00:00Z");
const iso = (daysFromNow: number) => new Date(now.getTime() + daysFromNow * 86400000).toISOString();
const paid = { active: true, plan_key: "school_onetime", current_period_end: iso(300) };

describe("schoolLifecycle — mirrors plan_tier()'s school branches", () => {
  it("suspended beats a paid entitlement", () => {
    expect(schoolLifecycle({ status: "suspended", trial_ends_at: iso(10) }, [paid], now)).toBe("suspended");
    expect(schoolLifecycle({ status: "archived", trial_ends_at: null }, [paid], now)).toBe("suspended");
  });
  it("a paid entitlement beats an expired clock", () => {
    expect(schoolLifecycle({ status: "active", trial_ends_at: iso(-1) }, [paid], now)).toBe("paid");
  });
  it("a lapsed, inactive, or non-school entitlement does not count as paid", () => {
    expect(schoolLifecycle({ status: "active", trial_ends_at: iso(5) }, [{ ...paid, current_period_end: iso(-1) }], now)).toBe("trial");
    expect(schoolLifecycle({ status: "active", trial_ends_at: iso(5) }, [{ ...paid, active: false }], now)).toBe("trial");
    expect(schoolLifecycle({ status: "active", trial_ends_at: iso(5) }, [{ ...paid, plan_key: "teacher_pro_monthly" }], now)).toBe("trial");
  });
  it("a clock in the future is a trial; in the past, expired; absent, legacy", () => {
    expect(schoolLifecycle({ status: "active", trial_ends_at: iso(1) }, [], now)).toBe("trial");
    expect(schoolLifecycle({ status: "active", trial_ends_at: iso(-1) }, [], now)).toBe("expired");
    expect(schoolLifecycle({ status: "active", trial_ends_at: null }, [], now)).toBe("legacy");
  });
});

describe("daysUntil", () => {
  it("rounds up, goes negative when past, and is null with no clock", () => {
    expect(daysUntil(iso(0.2), now)).toBe(1);
    expect(daysUntil(iso(30), now)).toBe(30);
    expect(daysUntil(iso(-2), now)).toBe(-2);
    expect(daysUntil(null, now)).toBeNull();
  });
});

describe("duplicateFlags", () => {
  const row = (id: string, o: Partial<{ email_domain: string | null; name_key: string | null; reg_ip: string | null; created_at: string }>) => ({
    id,
    email_domain: null,
    name_key: null,
    reg_ip: null,
    created_at: now.toISOString(),
    ...o,
  });

  it("flags a shared organisation domain both ways, but never a free-mail one", () => {
    const flags = duplicateFlags([
      row("a", { email_domain: "abcschool.edu.my" }),
      row("b", { email_domain: "abcschool.edu.my" }),
      row("c", { email_domain: "gmail.com" }),
      row("d", { email_domain: "gmail.com" }),
    ]);
    expect(flags.get("a")).toEqual([{ kind: "domain", with: "b" }]);
    expect(flags.get("b")).toEqual([{ kind: "domain", with: "a" }]);
    expect(flags.has("c")).toBe(false);
    expect(flags.has("d")).toBe(false);
  });

  it("flags the same normalized name", () => {
    const flags = duplicateFlags([row("a", { name_key: "abc-school" }), row("b", { name_key: "abc-school" })]);
    expect(flags.get("a")).toEqual([{ kind: "name", with: "b" }]);
  });

  it("flags the same IP only inside the window", () => {
    const near = duplicateFlags([
      row("a", { reg_ip: "1.2.3.4", created_at: iso(0) }),
      row("b", { reg_ip: "1.2.3.4", created_at: iso(-3) }),
    ]);
    expect(near.get("a")).toEqual([{ kind: "ip", with: "b" }]);
    const far = duplicateFlags([
      row("a", { reg_ip: "1.2.3.4", created_at: iso(0) }),
      row("b", { reg_ip: "1.2.3.4", created_at: iso(-45) }),
    ]);
    expect(far.size).toBe(0);
  });

  it("a school can carry several flags against several others", () => {
    const flags = duplicateFlags([
      row("a", { email_domain: "x.edu", name_key: "x" }),
      row("b", { email_domain: "x.edu" }),
      row("c", { name_key: "x" }),
    ]);
    expect(flags.get("a")).toEqual([
      { kind: "domain", with: "b" },
      { kind: "name", with: "c" },
    ]);
  });
});

describe("sortSchools", () => {
  it("live trials first (soonest ending on top), then expired, paid, legacy, suspended", () => {
    const rows = [
      { id: "legacy", lifecycle: "legacy" as const, trial_ends_at: null, created_at: iso(-100) },
      { id: "trial-late", lifecycle: "trial" as const, trial_ends_at: iso(25), created_at: iso(-5) },
      { id: "suspended", lifecycle: "suspended" as const, trial_ends_at: iso(3), created_at: iso(-1) },
      { id: "paid", lifecycle: "paid" as const, trial_ends_at: iso(-10), created_at: iso(-40) },
      { id: "trial-soon", lifecycle: "trial" as const, trial_ends_at: iso(2), created_at: iso(-28) },
      { id: "expired", lifecycle: "expired" as const, trial_ends_at: iso(-4), created_at: iso(-34) },
    ];
    expect(sortSchools(rows).map((r) => r.id)).toEqual(["trial-soon", "trial-late", "expired", "paid", "legacy", "suspended"]);
  });
  it("does not mutate its input", () => {
    const rows = [{ lifecycle: "paid" as const, trial_ends_at: null, created_at: iso(0) }, { lifecycle: "trial" as const, trial_ends_at: iso(1), created_at: iso(0) }];
    const copy = [...rows];
    sortSchools(rows);
    expect(rows).toEqual(copy);
  });
});
