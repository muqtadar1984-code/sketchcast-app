/**
 * The catalogue funnel arithmetic (console /catalogue). Pinned: Monday-UTC
 * weeks (the allowance's week), unique viewers and unlockers per week and overall, the
 * event split, tiers from the unlock event's meta, and assigned copies
 * counted once each.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/catalogue-funnel.test.ts
 */
import { describe, expect, it } from "vitest";
import { buildCatalogueFunnel, weekOf, type EventRow, type UnlockRow } from "../catalogue-funnel";

const U = (user: string, topic: string, at: string): UnlockRow => ({ user_id: user, topic_id: topic, source: "allowance", week_start: weekOf(at), unlocked_at: at });
const E = (event: string, at: string, over: Partial<EventRow> = {}): EventRow => ({ user_id: "u1", topic_id: "t1", event, meta: null, created_at: at, ...over });

describe("weekOf", () => {
  it("is the Monday 00:00 UTC of the instant's week", () => {
    expect(weekOf("2026-10-16T14:00:00Z")).toBe("2026-10-12"); // a Friday
    expect(weekOf("2026-10-12T00:00:00Z")).toBe("2026-10-12"); // Monday itself
    expect(weekOf("2026-10-18T23:59:59Z")).toBe("2026-10-12"); // Sunday night
    expect(weekOf("2026-10-19T00:00:00Z")).toBe("2026-10-19");
  });
});

describe("buildCatalogueFunnel", () => {
  it("counts unique unlockers, splits events, groups by week and topic, reads tiers", () => {
    const unlocks = [U("u1", "t1", "2026-10-13T09:00:00Z"), U("u1", "t2", "2026-10-14T09:00:00Z"), U("u2", "t1", "2026-10-20T09:00:00Z")];
    const events = [
      E("unlock", "2026-10-13T09:00:00Z", { meta: { tier: "trial" } }),
      E("unlock", "2026-10-14T09:00:00Z", { meta: { tier: "trial" } }),
      E("unlock", "2026-10-20T09:00:00Z", { user_id: "u2", meta: { tier: "pro" } }),
      E("view", "2026-10-13T08:55:00Z"),
      E("view", "2026-10-13T08:58:00Z"),
      E("view", "2026-10-20T08:00:00Z", { user_id: "u2", topic_id: null }),
      E("view", "2026-10-20T08:30:00Z", { user_id: "u3", topic_id: null, meta: { reason: "coming_soon" } }),
      E("download", "2026-10-13T10:00:00Z"),
      E("download", "2026-10-13T10:05:00Z"),
      E("adopt", "2026-10-13T10:10:00Z"),
      E("adopt", "2026-10-20T10:10:00Z", { user_id: "u2" }),
      E("weekly_limit", "2026-10-15T08:00:00Z", { meta: { tier: "trial" } }),
      E("question_bank_backfill", "2026-10-16T12:00:00Z", { user_id: null, topic_id: null }),
    ];
    const f = buildCatalogueFunnel(unlocks, events, ["c1", "c1", "c2"]);
    expect(f.totals).toEqual({ viewers: 3, views: 4, unlockers: 2, unlocks: 3, downloads: 2, adopts: 2, adopters: 2, weeklyLimitHits: 1, assignedCopies: 2 });
    expect(f.weeks).toEqual([
      { week: "2026-10-19", viewers: 2, unlockers: 1, unlocks: 1, downloads: 0, adopts: 1, weeklyLimitHits: 0 },
      { week: "2026-10-12", viewers: 1, unlockers: 1, unlocks: 2, downloads: 2, adopts: 1, weeklyLimitHits: 1 },
    ]);
    expect(f.topics).toEqual([
      { topic_id: "t1", unlocks: 2, downloads: 2, adopts: 2 },
      { topic_id: "t2", unlocks: 1, downloads: 0, adopts: 0 },
    ]);
    expect(f.tiers).toEqual([
      { tier: "trial", unlocks: 2, weeklyLimitHits: 1 },
      { tier: "pro", unlocks: 1, weeklyLimitHits: 0 },
    ]);
  });

  it("is empty on no data", () => {
    const f = buildCatalogueFunnel([], [], []);
    expect(f.totals.unlocks).toBe(0);
    expect(f.totals.viewers).toBe(0);
    expect(f.weeks).toEqual([]);
    expect(f.topics).toEqual([]);
    expect(f.tiers).toEqual([]);
  });
});
