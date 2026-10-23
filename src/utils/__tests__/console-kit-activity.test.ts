/**
 * Per-user Ready-made kits activity (console Users roster + account page).
 * Pinned: unlocks come from catalogue_unlocks, not the 'unlock' event; views
 * keep the latest time; system rows (no user) are skipped; the per-topic list
 * puts unlocked topics first, newest first.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/console-kit-activity.test.ts
 */
import { describe, expect, it } from "vitest";
import { aggregateKitActivity, kitTopicsFor, EMPTY_KIT_ACTIVITY } from "../console-kit-activity";

describe("aggregateKitActivity", () => {
  it("folds unlocks and events per user", () => {
    const m = aggregateKitActivity(
      [{ user_id: "u1" }, { user_id: "u1" }, { user_id: "u2" }],
      [
        { user_id: "u1", event: "view", created_at: "2026-10-21T09:00:00Z" },
        { user_id: "u1", event: "view", created_at: "2026-10-23T09:00:00Z" },
        { user_id: "u1", event: "view", created_at: "2026-10-22T09:00:00Z" },
        { user_id: "u1", event: "unlock", created_at: "2026-10-21T09:01:00Z" },
        { user_id: "u1", event: "download", created_at: "2026-10-21T09:02:00Z" },
        { user_id: "u1", event: "watch", created_at: "2026-10-21T09:03:00Z" },
        { user_id: "u1", event: "adopt", created_at: "2026-10-21T09:04:00Z" },
        { user_id: "u1", event: "weekly_limit", created_at: "2026-10-21T09:05:00Z" },
        { user_id: "u3", event: "view", created_at: "2026-10-22T09:00:00Z" },
        { user_id: null, event: "view", created_at: "2026-10-22T09:00:00Z" },
        { user_id: "u4", event: "question_bank_backfill", created_at: "2026-10-16T12:00:00Z" },
      ],
    );
    expect(m.get("u1")).toEqual({ views: 3, lastViewedAt: "2026-10-23T09:00:00Z", unlocks: 2, downloads: 1, watches: 1, adopts: 1, weeklyLimitHits: 1 });
    expect(m.get("u2")).toEqual({ ...EMPTY_KIT_ACTIVITY, unlocks: 1 });
    expect(m.get("u3")).toEqual({ ...EMPTY_KIT_ACTIVITY, views: 1, lastViewedAt: "2026-10-22T09:00:00Z" });
    expect(m.has("u4")).toBe(false);
  });

  it("never mutates the shared empty value", () => {
    aggregateKitActivity([{ user_id: "u1" }], []);
    expect(EMPTY_KIT_ACTIVITY.unlocks).toBe(0);
  });
});

describe("kitTopicsFor", () => {
  it("lists unlocked topics newest first, then touched-only topics", () => {
    const rows = kitTopicsFor(
      [
        { topic_id: "t1", unlocked_at: "2026-10-16T09:00:00Z" },
        { topic_id: "t2", unlocked_at: "2026-10-20T09:00:00Z" },
      ],
      [
        { topic_id: "t1", event: "download" },
        { topic_id: "t1", event: "adopt" },
        { topic_id: "t1", event: "adopt" },
        { topic_id: "t3", event: "watch" },
        { topic_id: null, event: "view" },
      ],
    );
    expect(rows).toEqual([
      { topic_id: "t2", unlocked_at: "2026-10-20T09:00:00Z", downloads: 0, watches: 0, adopts: 0 },
      { topic_id: "t1", unlocked_at: "2026-10-16T09:00:00Z", downloads: 1, watches: 0, adopts: 2 },
      { topic_id: "t3", unlocked_at: null, downloads: 0, watches: 1, adopts: 0 },
    ]);
  });
});
