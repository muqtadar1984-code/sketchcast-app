import { describe, expect, it } from "vitest";
import {
  awaitsReview,
  blockingCount,
  flagCount,
  inboxHref,
  parseInboxParams,
  precheckVerdict,
  queueRowFor,
  queueRowsOf,
  timeInReview,
  type QueueKitRow,
} from "@/utils/catalogue/review-queue";

const topic = (id: string, title: string) => ({ id, title, subject: "Maths", status: "in_review" });

const row = (over: Partial<QueueKitRow>): QueueKitRow => ({
  id: "k1",
  topic_id: "t1",
  language: "en",
  status: "in_review",
  translation_status: null,
  precheck: null,
  updated_at: "2026-10-16T10:00:00Z",
  created_at: "2026-10-16T09:00:00Z",
  topics: topic("t1", "Circles"),
  ...over,
});

describe("the inbox URL", () => {
  it("is the topic path, with the view in the query", () => {
    expect(inboxHref("t1")).toBe("/library/topics/t1");
    expect(inboxHref("t1", { lang: "ar" })).toBe("/library/topics/t1?lang=ar");
    expect(inboxHref("t1", { lang: "en" })).toBe("/library/topics/t1");
    expect(inboxHref("t1", { queue: "all", q: "circle area" })).toBe("/library/topics/t1?queue=all&q=circle+area");
    expect(inboxHref("t1", { queue: "review", q: "ignored" })).toBe("/library/topics/t1");
  });

  it("parses the view back, dropping an English or malformed lang", () => {
    expect(parseInboxParams({ lang: "ar", queue: "all", q: "  area " })).toEqual({ lang: "ar", queue: "all", q: "area" });
    expect(parseInboxParams({ lang: "en" })).toEqual({ lang: null, queue: "review", q: "" });
    expect(parseInboxParams({ lang: "<script>" })).toEqual({ lang: null, queue: "review", q: "" });
    expect(parseInboxParams({ queue: "nonsense" }).queue).toBe("review");
    expect(parseInboxParams(undefined)).toEqual({ lang: null, queue: "review", q: "" });
    expect(parseInboxParams({ lang: ["ms", "ar"] }).lang).toBe("ms");
  });
});

describe("the pre-check summary", () => {
  it("counts flags and blocking across check A and check C", () => {
    const report = {
      ok: false,
      blocking: [{ where: "s1", what: "x" }],
      flags: [
        { where: "s2", what: "y" },
        { where: "s3", what: "z" },
      ],
      post_render: { ok: true, blocking: [], flags: [{ where: "p1", what: "late" }] },
    };
    expect(flagCount(report)).toBe(3);
    expect(blockingCount(report)).toBe(1);
    expect(precheckVerdict(report)).toBe("A: 1 blocking · C: passed");
    expect(precheckVerdict({ ok: true, blocking: [], flags: [] })).toBe("A: passed");
    expect(precheckVerdict(null)).toBe("not checked");
    expect(flagCount(null)).toBe(0);
  });
});

describe("the queue", () => {
  it("takes English kits by status and translations by translation_status", () => {
    expect(awaitsReview({ language: "en", status: "in_review", translation_status: null })).toBe(true);
    expect(awaitsReview({ language: "en", status: "approved", translation_status: null })).toBe(false);
    expect(awaitsReview({ language: "ar", status: "in_review", translation_status: "in_review" })).toBe(true);
    // a translation whose kit finished but whose translation is stale is not a review
    expect(awaitsReview({ language: "ar", status: "in_review", translation_status: "stale" })).toBe(false);
    // without 0134 the translation column is absent: the kit status decides
    expect(awaitsReview({ language: "ar", status: "in_review" })).toBe(true);
  });

  it("lists one row per kit, newest first, with the topic's title and the flag count", () => {
    const rows = queueRowsOf([
      row({ id: "k1", updated_at: "2026-10-15T10:00:00Z" }),
      row({ id: "k2", topic_id: "t2", topics: topic("t2", "Angles"), updated_at: "2026-10-16T10:00:00Z", precheck: { ok: true, blocking: [], flags: [{ where: "a", what: "b" }] } }),
      row({ id: "k3", topic_id: "t1", language: "ar", translation_status: "in_review", updated_at: "2026-10-16T12:00:00Z" }),
      row({ id: "k4", status: "approved", updated_at: "2026-10-17T10:00:00Z" }),
      row({ id: "k1", updated_at: "2026-10-15T10:00:00Z" }), // a duplicate row is one row
      row({ id: "k5", topics: null }), // no topic to open
    ]);
    expect(rows.map((r) => r.kitId)).toEqual(["k3", "k2", "k1"]);
    expect(rows[0]).toMatchObject({ topicId: "t1", title: "Circles", language: "ar", translation: true, flags: 0 });
    expect(rows[1]).toMatchObject({ title: "Angles", language: "en", translation: false, flags: 1, blocking: 0 });
    // an embedded topic may come back as a one-element array
    expect(queueRowsOf([row({ topics: [topic("t1", "Circles")] })])[0].title).toBe("Circles");
  });

  it("selects the topic's English row before its translation", () => {
    const rows = queueRowsOf([row({ id: "k3", language: "ar", translation_status: "in_review", updated_at: "2026-10-16T12:00:00Z" }), row({ id: "k1" })]);
    expect(queueRowFor(rows, "t1")?.kitId).toBe("k1");
    expect(queueRowFor(rows.filter((r) => r.translation), "t1")?.kitId).toBe("k3");
    expect(queueRowFor(rows, "nope")).toBeNull();
  });

  it("says how long a kit has waited", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    expect(timeInReview("2026-10-17T11:59:30Z", now)).toBe("just now");
    expect(timeInReview("2026-10-17T11:25:00Z", now)).toBe("35 min");
    expect(timeInReview("2026-10-17T09:00:00Z", now)).toBe("3 h");
    expect(timeInReview("2026-10-15T12:00:00Z", now)).toBe("2 d");
    expect(timeInReview(null, now)).toBe("—");
    expect(timeInReview("not a date", now)).toBe("—");
  });
});
