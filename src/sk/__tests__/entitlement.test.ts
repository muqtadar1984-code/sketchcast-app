/**
 * SK B8 — the gate decision as the loop carries it (decideAccess over the
 * rows + usage), the period, the subscription liveness rule, the static
 * source, the view block and the panel notice, and the usage methods on both
 * stores. The loader over the real schema is exercised in access-loop.test.ts.
 */
import { describe, expect, it } from "vitest";
import { accessNotice, type AccessView } from "../access-notice";
import { decideAccess, devFlagAccess, liveAllowed, periodOf, redecide, rowActive, StaticEntitlements, type AccessRows } from "../entitlement";
import { accessView } from "../loop";
import { addUsage, InMemorySessionStore, ZERO_USAGE } from "../store";
import { SupabaseSessionStore } from "../store-supabase";
import { skFakeDb } from "./fake-supabase";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 27, 12);
const now = new Date(T0);
const iso = (ms: number) => new Date(ms).toISOString();
const P = "d7a8282a-1f23-4ae8-8008-40e3ae458c13";
const grant = (extra: Partial<AccessRows["grants"][number]> = {}): AccessRows["grants"][number] => ({ product_id: P, source: "code", activated_at: iso(T0 - DAY), expires_at: null, tutor_expires_at: iso(T0 + 29 * DAY), revoked_at: null, usage_allowance: null, ...extra });
const rows = (extra: Partial<AccessRows> = {}): AccessRows => ({ productId: P, schoolLicence: false, subscriptions: [], grants: [], ...extra });

describe("decideAccess: who may open, who may ask live questions", () => {
  // The decision table the B8 PR states. book = may open (prepared teaching); live = may ask a question now.
  const cases: { who: string; rows: AccessRows; usage?: { live_turns: number; generated_segments: number; interactive_ms: number }; enforced?: boolean; book: boolean; live: boolean; source: string | null; warning?: string }[] = [
    { who: "nobody (no licence, plan or grant)", rows: rows(), book: false, live: false, source: null },
    // Books are bought (2026-10-30): a licence or SK plan tutors, but only a live grant opens the book.
    { who: "a school licence alone (tutoring, no book)", rows: rows({ schoolLicence: true }), book: false, live: true, source: "school" },
    { who: "a school licence + a purchase grant", rows: rows({ schoolLicence: true, grants: [grant({ source: "purchase", tutor_expires_at: null })] }), book: true, live: true, source: "school" },
    { who: "an SK plan (homeschool) alone (tutoring, no book)", rows: rows({ subscriptions: [{ plan_key: "homeschool_annual", active: true, current_period_end: iso(T0 + DAY) }] }), book: false, live: true, source: "subscription" },
    { who: "an SK plan (homeschool) + a purchase grant", rows: rows({ subscriptions: [{ plan_key: "homeschool_annual", active: true, current_period_end: iso(T0 + DAY) }], grants: [grant({ source: "purchase", tutor_expires_at: null })] }), book: true, live: true, source: "subscription" },
    { who: "plain Pro (not an SK plan)", rows: rows({ subscriptions: [{ plan_key: "teacher_pro_monthly", active: true, current_period_end: iso(T0 + DAY) }] }), book: false, live: false, source: null },
    { who: "a lapsed SK plan", rows: rows({ subscriptions: [{ plan_key: "family_monthly", active: true, current_period_end: iso(T0 - DAY) }] }), book: false, live: false, source: null },
    { who: "a live grant in its tutor window", rows: rows({ grants: [grant()] }), book: true, live: true, source: "grant" },
    { who: "a grant whose tutor window is over (book stays)", rows: rows({ grants: [grant({ tutor_expires_at: iso(T0 - 1) })] }), book: true, live: false, source: "grant" },
    { who: "a grant with no tutor window (book only)", rows: rows({ grants: [grant({ tutor_expires_at: null })] }), book: true, live: false, source: "grant" },
    { who: "a revoked grant", rows: rows({ grants: [grant({ revoked_at: iso(T0 - 1) })] }), book: false, live: false, source: null },
    { who: "a grant for another product", rows: rows({ grants: [grant({ product_id: "00000000-0000-4000-8000-000000000000" })] }), book: false, live: false, source: null },
    { who: "a grant not yet activated", rows: rows({ grants: [grant({ activated_at: iso(T0 + DAY) })] }), book: false, live: false, source: null },
    { who: "a metered grant, allowance left, enforced", rows: rows({ grants: [grant({ usage_allowance: { live_turns: 10 } })] }), usage: { live_turns: 4, generated_segments: 0, interactive_ms: 0 }, enforced: true, book: true, live: true, source: "grant", warning: "none" },
    { who: "a metered grant at 75 %, enforced", rows: rows({ grants: [grant({ usage_allowance: { live_turns: 10 } })] }), usage: { live_turns: 8, generated_segments: 0, interactive_ms: 0 }, enforced: true, book: true, live: true, source: "grant", warning: "75" },
    { who: "a metered grant at 90 %, enforced", rows: rows({ grants: [grant({ usage_allowance: { live_turns: 10 } })] }), usage: { live_turns: 9, generated_segments: 0, interactive_ms: 0 }, enforced: true, book: true, live: true, source: "grant", warning: "90" },
    { who: "a metered grant spent, enforced (book stays)", rows: rows({ grants: [grant({ usage_allowance: { live_turns: 10 } })] }), usage: { live_turns: 10, generated_segments: 0, interactive_ms: 0 }, enforced: true, book: true, live: false, source: "grant", warning: "exhausted" },
    { who: "a metered grant spent, NOT enforced", rows: rows({ grants: [grant({ usage_allowance: { live_turns: 10 } })] }), usage: { live_turns: 10, generated_segments: 0, interactive_ms: 0 }, enforced: false, book: true, live: true, source: "grant", warning: "none" },
    { who: "a school licence beats a spent grant", rows: rows({ schoolLicence: true, grants: [grant({ usage_allowance: { live_turns: 1 } })] }), usage: { live_turns: 5, generated_segments: 0, interactive_ms: 0 }, enforced: true, book: true, live: true, source: "school" },
    { who: "an unknown product (no row): no grant can match, so no book", rows: rows({ productId: null, grants: [grant()] }), book: false, live: false, source: null },
  ];
  it.each(cases)("$who → book $book, live $live", (c) => {
    const a = decideAccess(c.rows, c.usage ?? null, { now, allowanceEnforced: !!c.enforced });
    expect(a.decision.book_access).toBe(c.book);
    expect(liveAllowed(a)).toBe(c.live);
    expect(a.decision.source).toBe(c.source);
    if (c.warning) expect(a.warning).toBe(c.warning);
    expect(a.period).toBe("2026-10");
    expect(a.usageKey).toBe(c.rows.productId);
    expect(a.devFlag).toBe(false);
    expect(a.enforced).toBe(!!c.enforced);
  });
  it("redecide re-runs the same rows over the usage a bump returned", () => {
    const a = decideAccess(rows({ grants: [grant({ usage_allowance: { live_turns: 2 } })] }), null, { now, allowanceEnforced: true });
    expect(a.decision.allowance_remaining).toEqual({ live_turns: 2, generated_segments: null });
    const b = redecide(a, { live_turns: 2, generated_segments: 0 });
    expect(b.decision.live_exhausted).toBe(true);
    expect(b.warning).toBe("exhausted");
    expect(b.period).toBe(a.period);
    expect(redecide(devFlagAccess(now), { live_turns: 99, generated_segments: 0 })).toEqual(devFlagAccess(now)); // nothing to re-decide
  });
  it("the dev-flag grants everything and meters nothing", () => {
    const a = devFlagAccess(now);
    expect(a).toMatchObject({ devFlag: true, enforced: false, period: "2026-10", usageKey: null, input: null, warning: "none" });
    expect(liveAllowed(a)).toBe(true);
    expect(accessView(a)).toEqual({ source: "dev-flag", grantSource: null, book: true, tutor: true, tutorExpiresAt: null, allowance: null, liveExhausted: false, warning: "none", enforced: false });
  });
  it("periodOf is the UTC month; rowActive is the entitlements liveness rule", () => {
    expect(periodOf(new Date(Date.UTC(2026, 9, 31, 23, 59)))).toBe("2026-10");
    expect(periodOf(new Date(Date.UTC(2026, 10, 1, 0, 0)))).toBe("2026-11");
    expect(rowActive({ active: true, current_period_end: null }, now)).toBe(true);
    expect(rowActive({ active: true, current_period_end: iso(T0 + 1) }, now)).toBe(true);
    expect(rowActive({ active: true, current_period_end: iso(T0 - 1) }, now)).toBe(false);
    expect(rowActive({ active: false, current_period_end: iso(T0 + DAY) }, now)).toBe(false);
  });
  it("the static source keys grants on the slug unless told otherwise, and may answer per student", async () => {
    const fixed = new StaticEntitlements({ grants: [grant({ product_id: "my-book" })] });
    expect(await fixed.load("stu", "my-book", now)).toEqual({ productId: "my-book", schoolLicence: false, subscriptions: [], grants: [grant({ product_id: "my-book" })] });
    const perStudent = new StaticEntitlements((id) => (id === "a" ? { schoolLicence: true } : {}));
    expect((await perStudent.load("a", "my-book", now)).schoolLicence).toBe(true);
    expect((await perStudent.load("b", "my-book", now)).schoolLicence).toBe(false);
    expect((await new StaticEntitlements({ productId: null }).load("a", "my-book", now)).productId).toBeNull();
  });
});

describe("the view block and the panel notice", () => {
  const base: AccessView = { source: "grant", grantSource: "code", book: true, tutor: true, tutorExpiresAt: iso(T0 + DAY), allowance: null, liveExhausted: false, warning: "none", enforced: false };
  it("accessView maps the decision", () => {
    const a = decideAccess(rows({ grants: [grant({ source: "edition_code", usage_allowance: { live_turns: 4, generated_segments: 2 } })] }), { live_turns: 3, generated_segments: 1, interactive_ms: 0 }, { now, allowanceEnforced: true });
    expect(accessView(a)).toEqual({ source: "grant", grantSource: "edition_code", book: true, tutor: true, tutorExpiresAt: iso(T0 + 29 * DAY), allowance: { liveTurns: 1, generatedSegments: 1 }, liveExhausted: false, warning: "75", enforced: true });
    expect(accessView(decideAccess(rows(), null, { now, allowanceEnforced: false }))).toMatchObject({ source: "none", book: false, tutor: false });
  });
  it("accessNotice says the one thing that matters, or nothing", () => {
    expect(accessNotice(null)).toBeNull();
    expect(accessNotice({ ...base, source: "dev-flag" })).toBeNull();
    expect(accessNotice(base)).toBeNull();
    expect(accessNotice({ ...base, warning: "75" })).toMatch(/75%/);
    expect(accessNotice({ ...base, warning: "90" })).toMatch(/90%/);
    expect(accessNotice({ ...base, liveExhausted: true, warning: "exhausted" })).toMatch(/allowance is used up/);
    expect(accessNotice({ ...base, tutor: false })).toMatch(/Live tutoring for this book has ended/);
    expect(accessNotice({ ...base, tutor: false, tutorExpiresAt: null })).toMatch(/without live tutoring/);
    expect(accessNotice({ ...base, book: false, tutor: false, source: "none" })).toMatch(/access to this book has ended/);
  });
});

describe("usage on both stores", () => {
  it("in-memory: null until bumped, then totals per (student, product, period)", async () => {
    const s = new InMemorySessionStore();
    expect(await s.getUsage("stu", "p", "2026-10")).toBeNull();
    expect(await s.bumpUsage("stu", "p", "2026-10", { live_turns: 1 })).toEqual({ live_turns: 1, generated_segments: 0, interactive_ms: 0 });
    expect(await s.bumpUsage("stu", "p", "2026-10", { live_turns: 1, generated_segments: 1 })).toEqual({ live_turns: 2, generated_segments: 1, interactive_ms: 0 });
    expect(await s.getUsage("stu", "p", "2026-11")).toBeNull();
    expect(await s.getUsage("stu", "q", "2026-10")).toBeNull();
    expect(addUsage(null, {})).toEqual(ZERO_USAGE);
  });
  it("Supabase: read-then-upsert on the primary key, refusing what the table refuses (a slug product id, an unknown student)", async () => {
    const db = skFakeDb(() => T0);
    const STU = "0f6a2c1e-7b3d-4e5f-8a9b-0c1d2e3f4a5b";
    db.seed("profiles", [{ id: STU }]);
    const s = new SupabaseSessionStore(db, { now: () => T0 });
    expect(await s.getUsage(STU, P, "2026-10")).toBeNull();
    expect(await s.bumpUsage(STU, P, "2026-10", { live_turns: 1, generated_segments: 1 })).toEqual({ live_turns: 1, generated_segments: 1, interactive_ms: 0 });
    expect(await s.bumpUsage(STU, P, "2026-10", { live_turns: 1 })).toEqual({ live_turns: 2, generated_segments: 1, interactive_ms: 0 });
    expect(db.rows("sk_usage")).toEqual([{ user_id: STU, product_id: P, period: "2026-10", live_turns: 2, generated_segments: 1, interactive_ms: 0, updated_at: iso(T0) }]);
    await expect(s.getUsage(STU, "a-slug", "2026-10")).rejects.toThrow(/22P02/);
    await expect(s.bumpUsage("0f6a2c1e-7b3d-4e5f-8a9b-000000000000", P, "2026-10", { live_turns: 1 })).rejects.toThrow(/23503/);
  });
});
