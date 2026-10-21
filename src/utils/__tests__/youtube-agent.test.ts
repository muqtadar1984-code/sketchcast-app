import { describe, expect, it } from "vitest";
import {
  dailyMinutes,
  isAgentAction,
  MAX_ADD,
  nextRoundLabel,
  pacific,
  planQueue,
  queueByLanguage,
  quotaDay,
  runOnceAccepts,
  type QueueItem,
  type Round,
} from "@/utils/catalogue/youtube-agent";
import type { VideoRow } from "@/utils/catalogue/youtube-videos";

const row = (kitId: string, language: string, ok = true): VideoRow =>
  ({
    kitId,
    topicId: `t-${kitId}`,
    title: `Topic ${kitId}`,
    subject: "Physics",
    language,
    languageName: language.toUpperCase(),
    kitStatus: "approved",
    translationStatus: "approved",
    current: true,
    state: "ready",
    category: "not_posted",
    parts: [],
    channel: { language, exists: true, lastPoll: null },
    liveJob: null,
    flags: [],
    postable: ok ? { ok: true } : { ok: false, why: "The question bank is empty — fill it before posting." },
    inboxHref: "#",
  }) as unknown as VideoRow;

const item = (id: string, language: string, status: QueueItem["status"] = "pending", added = "2026-10-20T00:00:00Z"): QueueItem => ({
  id, kit_id: `k-${id}`, topic_id: null, language, status, round_id: null, job_id: null, attempts: 0, last_error: null, added_at: added, updated_at: added,
});

const round = (status: Round["status"]): Round => ({
  id: "r", trigger: "manual", quota_day: "2026-10-21", status, created_at: "", started_at: null, finished_at: null, summary: null,
});

describe("the Pacific quota clock", () => {
  it("reads the Pacific day and minutes, across the clock change", () => {
    expect(pacific(Date.UTC(2026, 9, 21, 6, 59))).toEqual({ day: "2026-10-20", minutes: 23 * 60 + 59 }); // PDT
    expect(quotaDay(Date.UTC(2026, 9, 21, 7, 0))).toBe("2026-10-21");
    expect(pacific(Date.UTC(2026, 11, 1, 8, 30))).toEqual({ day: "2026-12-01", minutes: 30 }); // PST
  });

  it("reads daily_at and falls back to 00:30", () => {
    expect(dailyMinutes({ daily_at: "06:15" })).toBe(375);
    expect(dailyMinutes({ daily_at: "25:00" })).toBe(30);
    expect(dailyMinutes(null)).toBe(30);
  });
});

describe("planQueue", () => {
  it("adds only postable rows that are not already waiting, and counts days per language", () => {
    const rows = [row("a", "es"), row("b", "es"), row("c", "fr"), row("d", "fr", false), row("e", "hi")];
    const plan = planQueue(rows, ["a", "b", "c", "d", "e"], [{ kit_id: "e", language: "hi" }, { kit_id: "x", language: "es" }]);
    expect(plan.accepted.map((a) => a.kitId)).toEqual(["a", "b", "c"]);
    expect(plan.excluded.map((e) => [e.kitId, e.why])).toEqual([
      ["d", "The question bank is empty — fill it before posting."],
      ["e", "Already in the posting queue."],
    ]);
    const es = plan.perLanguage.find((p) => p.language === "es")!;
    expect(es).toMatchObject({ adding: 2, waiting: 1, days: 3 });
    expect(plan.days).toBe(3);
  });

  it("names a selected id that is not in the list, and caps one selection", () => {
    expect(planQueue([], ["ghost"], []).excluded[0].why).toMatch(/Not a translated kit/);
    const many = Array.from({ length: MAX_ADD + 2 }, (_, i) => row(`k${i}`, "es"));
    const plan = planQueue(many, many.map((r) => r.kitId), []);
    expect(plan.accepted).toHaveLength(MAX_ADD);
    expect(plan.excluded).toHaveLength(2);
  });
});

describe("the panel", () => {
  it("groups the open queue by language with the oldest pending next", () => {
    const q = queueByLanguage([
      item("2", "es", "pending", "2026-10-20T02:00:00Z"),
      item("1", "es", "pending", "2026-10-20T01:00:00Z"),
      item("3", "fr", "queued"),
      item("4", "fr", "done"),
    ]);
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ language: "es", waiting: 2 });
    expect(q[0].next?.id).toBe("1");
    expect(q[1]).toMatchObject({ language: "fr", waiting: 0 });
    expect(q[1].inFlight?.id).toBe("3");
  });

  it("says when the next round runs", () => {
    const base = { settings: null, openRound: null, pending: 3 };
    const before = Date.UTC(2026, 9, 21, 7, 10); // 00:10 PDT
    const after = Date.UTC(2026, 9, 21, 8, 0); // 01:00 PDT
    expect(nextRoundLabel({ ...base, nowMs: before, dailyDoneToday: false })).toMatch(/at 00:30 Pacific/);
    expect(nextRoundLabel({ ...base, nowMs: after, dailyDoneToday: false })).toMatch(/within a minute/);
    expect(nextRoundLabel({ ...base, nowMs: after, dailyDoneToday: true })).toMatch(/tomorrow/);
    expect(nextRoundLabel({ ...base, nowMs: after, dailyDoneToday: true, pending: 0 })).toMatch(/Nothing is waiting/);
    expect(nextRoundLabel({ ...base, nowMs: after, dailyDoneToday: true, settings: { paused: true } })).toMatch(/Paused/);
    expect(nextRoundLabel({ ...base, nowMs: after, dailyDoneToday: true, openRound: round("running") })).toMatch(/running now/);
  });

  it("allows Run once more only when nothing is open, something waits and the agent runs", () => {
    expect(runOnceAccepts(null, 2, false)).toEqual({ ok: true });
    expect(runOnceAccepts(round("running"), 2, false).ok).toBe(false);
    expect(runOnceAccepts(null, 0, false).ok).toBe(false);
    expect(runOnceAccepts(null, 2, true).ok).toBe(false);
  });

  it("knows its actions", () => {
    expect(isAgentAction("run_once")).toBe(true);
    expect(isAgentAction("delete_everything")).toBe(false);
  });
});
