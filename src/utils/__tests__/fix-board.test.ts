/**
 * The Fix Agent board's pure rules (utils/fixes/fix-board.ts, Library →
 * Fixes v2): the cause of a failure (with the worker's real error strings and
 * their precedence), the re-check badge, the queue line, a retry's progress,
 * the 7-day trend strip, the URL state, the filters and the cause groups.
 *
 * Run: npx vitest run src/utils/__tests__/fix-board.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  boardQuery,
  boardRows,
  causeOf,
  DEFAULT_PARAMS,
  facetCounts,
  filterCases,
  groupBadge,
  groupByCause,
  minutesLabel,
  ordinal,
  parseBoardParams,
  progressOf,
  queueInfo,
  recheckBadge,
  shortStatus,
  weekStats,
  type BoardRow,
} from "../fixes/fix-board";
import type { FixCase } from "../fixes/fix-cases";

// the worker's own messages (fix_agent.py / the translator's pre-checks)
const REPLY = "translation reply did not return 18 items (got list)";
const QUIZ = "1 quiz question(s) have no staged translation: 47854c47 (numbers differ; numbers differ)";
const MATHS = "translation of part 1 failed pre-check A: examples[3].problem: maths in the question altered";
const NUMBERS = "translation of part 1 failed pre-check A: s006: numbers differ";
const DIAG = "diagnosis failed: translation reply did not return 98 items (got dict)";
const THROTTLE = "429 RESOURCE_EXHAUSTED";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("causeOf", () => {
  it("names each real error string", () => {
    expect(causeOf({ issue: REPLY })).toEqual({ key: "reply_shape", label: "Model reply shape" });
    expect(causeOf({ issue: QUIZ })).toEqual({ key: "quiz_item", label: "Quiz item dropped" });
    expect(causeOf({ issue: MATHS })).toEqual({ key: "maths_question", label: "Maths in the question" });
    expect(causeOf({ issue: NUMBERS })).toEqual({ key: "numbers", label: "Numbers differ" });
    expect(causeOf({ issue: DIAG })).toEqual({ key: "diagnosis_failed", label: "Diagnosis failed" });
    expect(causeOf({ issue: THROTTLE })).toEqual({ key: "throttle", label: "Throttled" });
    expect(causeOf({ issue: "model overloaded, try later" }).key).toBe("throttle");
    expect(causeOf({ issue: "hit the rate limit" }).key).toBe("throttle");
    expect(causeOf({ issue: "maths in the stem altered" }).key).toBe("maths_question");
  });

  it("puts a quiz item before numbers (the quiz message carries 'numbers differ' in brackets)", () => {
    expect(QUIZ).toMatch(/numbers differ/);
    expect(causeOf({ issue: QUIZ }).key).toBe("quiz_item");
  });

  it("puts maths before numbers, and a failed diagnosis before the reply shape it quotes", () => {
    expect(causeOf({ issue: `${MATHS}; s006: numbers differ` }).key).toBe("maths_question");
    expect(causeOf({ issue: DIAG }).key).toBe("diagnosis_failed");
  });

  it("reads the CURRENT failure first: the retry's error, then the issue", () => {
    expect(causeOf({ issue: NUMBERS, outcome: { error: REPLY } }).key).toBe("reply_shape");
    expect(causeOf({ issue: NUMBERS, outcome: { error: DIAG } }).key).toBe("diagnosis_failed");
    // an unrecognised retry error falls through to the issue
    expect(causeOf({ issue: NUMBERS, outcome: { error: "something new" } }).key).toBe("numbers");
  });

  it("is 'Rejected in review' when the retried kit was rejected or failed with no job error", () => {
    expect(causeOf({ issue: NUMBERS, outcome: { kit_status: "rejected" } }).key).toBe("review");
    expect(causeOf({ outcome: { translation_status: "failed" } }).key).toBe("review");
    expect(causeOf({ outcome: { kit_status: "failed", error: THROTTLE } }).key).toBe("throttle");
  });

  it("falls back to the diagnosis, then the findings' `what`, then Other", () => {
    expect(causeOf({ diagnosis: { explanation: "The translator hit a 429 twice." } }).key).toBe("throttle");
    expect(causeOf({ evidence: { findings: [{ where: "s1", what: "numbers differ" }] } }).key).toBe("numbers");
    expect(causeOf({ issue: "kaboom" })).toEqual({ key: "other", label: "Other" });
    expect(causeOf(null).key).toBe("other");
    expect(causeOf({ outcome: "junk" as never, diagnosis: 3 as never, evidence: [] as never }).key).toBe("other");
  });
});

describe("recheckBadge", () => {
  const ev = (recheck: unknown) => ({ evidence: { recheck } as never });
  it("says what the worker's re-check found", () => {
    expect(recheckBadge(ev({ passes: true, fixed_by: null, checked: 4, passing: 4 }))).toBe("Passes with the current check");
    expect(recheckBadge(ev({ passes: false, fixed_by: "#316" }))).toBe("Fixed in #316");
    expect(recheckBadge(ev({ passes: true, fixed_by: "#316" }))).toBe("Passes with the current check (#316)");
  });

  it("is null without a re-check, or when it neither passes nor matched a fix", () => {
    expect(recheckBadge(ev({ passes: false, fixed_by: null }))).toBeNull();
    expect(recheckBadge(ev({ passes: null }))).toBeNull();
    expect(recheckBadge({ evidence: { findings: [] } })).toBeNull();
    expect(recheckBadge({ evidence: null })).toBeNull();
    expect(recheckBadge(null)).toBeNull();
  });

  it("shows on a group only when every OPEN row carries one", () => {
    const a = { status: "proposed", badge: "Fixed in #316" };
    const b = { status: "needs_founder", badge: "Fixed in #316" };
    const none = { status: "proposed", badge: null };
    const closed = { status: "rejected", badge: null };
    expect(groupBadge([a, b, closed])).toBe("Fixed in #316");
    expect(groupBadge([a, none])).toBeNull();
    expect(groupBadge([a, { status: "approved", badge: "Passes with the current check" }])).toBe("Every open case passes or is fixed");
    expect(groupBadge([closed])).toBeNull();
    expect(groupBadge([])).toBeNull();
  });
});

describe("queueInfo", () => {
  it("ranks approved cases oldest first, behind the one already retrying", () => {
    const rows: Pick<FixCase, "id" | "status" | "created_at">[] = [
      { id: "new", status: "approved", created_at: minsAgo(5) },
      { id: "old", status: "approved", created_at: minsAgo(50) },
      { id: "run", status: "applied", created_at: minsAgo(10) },
      { id: "wait", status: "proposed", created_at: minsAgo(90) },
    ];
    const q = queueInfo(rows);
    expect(Object.keys(q).sort()).toEqual(["new", "old"]);
    expect(q.old).toEqual({ position: 2, etaMinutes: 30, label: "2nd in line · ~30 min" });
    expect(q.new).toEqual({ position: 3, etaMinutes: 45, label: "3rd in line · ~45 min" });
  });

  it("starts at 1st with nothing retrying, and says hours past an hour", () => {
    const q = queueInfo([{ id: "a", status: "approved", created_at: minsAgo(1) }]);
    expect(q.a.label).toBe("1st in line · ~15 min");
    expect(minutesLabel(60)).toBe("~1 h");
    expect(minutesLabel(75)).toBe("~1 h 15 min");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
  });
});

describe("progressOf", () => {
  it("reads the job's step and percent", () => {
    expect(progressOf({ status: "processing", progress: 40, stage: { step: "script" } })).toEqual({ text: "script 40%", pct: 40 });
    expect(progressOf({ status: "processing", progress: "62.4", stage: { step: "slides" } })).toEqual({ text: "slides 62%", pct: 62 });
    expect(progressOf({ status: "processing", progress: null, stage: null })).toEqual({ text: "working", pct: null });
    expect(progressOf({ status: "queued", progress: 0 })).toEqual({ text: "queued", pct: 0 });
    expect(progressOf({ status: "completed", progress: 100 })).toEqual({ text: "finishing", pct: 100 });
    expect(progressOf({ status: "failed", progress: 30 })).toEqual({ text: "failed", pct: 30 });
    expect(progressOf(null)).toBeNull();
    expect(progressOf({ status: null })).toBeNull();
  });
});

describe("weekStats", () => {
  const rows: Pick<FixCase, "status" | "created_at" | "cost_usd" | "issue" | "outcome" | "diagnosis" | "evidence">[] = [
    { status: "resolved", created_at: daysAgo(1), cost_usd: "0.40", issue: NUMBERS },
    { status: "resolved", created_at: daysAgo(2), cost_usd: 0.6, issue: NUMBERS },
    { status: "resolved", created_at: daysAgo(3), cost_usd: null, issue: REPLY },
    { status: "proposed", created_at: daysAgo(3), issue: QUIZ },
    { status: "needs_founder", created_at: daysAgo(6), issue: NUMBERS },
    { status: "rejected", created_at: daysAgo(4), issue: THROTTLE },
    // outside the week
    { status: "resolved", created_at: daysAgo(8), cost_usd: 9, issue: REPLY },
  ];

  it("counts the week's failures, the fixed share, the cost per fixed kit and the top causes", () => {
    const w = weekStats(rows, NOW);
    expect(w.failures).toBe(6);
    expect(w.fixed).toBe(3);
    expect(w.rate).toBe(50);
    expect(w.avgCostUsd).toBeCloseTo(0.5);
    expect(w.byCause).toEqual([
      // ties keep the causes' own order
      { key: "numbers", label: "Numbers differ", count: 3 },
      { key: "reply_shape", label: "Model reply shape", count: 1 },
      { key: "quiz_item", label: "Quiz item dropped", count: 1 },
    ]);
  });

  it("is empty-safe: no rate and no cost without cases", () => {
    expect(weekStats([], NOW)).toEqual({ failures: 0, fixed: 0, rate: null, avgCostUsd: null, byCause: [] });
    expect(weekStats([{ status: "proposed", created_at: daysAgo(1) }], NOW).avgCostUsd).toBeNull();
  });
});

// ── the board's rows, filters and groups ────────────────────────────────────

const c = (id: string, status: string, extra: Partial<FixCase> = {}): FixCase => ({ id, status, created_at: daysAgo(1), language: "ms", topic_id: "t1", title: `case ${id}`, ...extra });

const CASES: FixCase[] = [
  c("w1", "proposed", { issue: NUMBERS, evidence: { recheck: { passes: true } } }),
  c("w2", "proposed", { issue: NUMBERS, language: "ar", topic_id: "t2" }),
  c("n1", "needs_founder", { issue: REPLY }),
  c("a1", "approved", { issue: REPLY, created_at: minsAgo(30) }),
  c("p1", "applied", { issue: REPLY, applied_job_id: "job-1" }),
  c("r1", "resolved", { issue: NUMBERS }),
  c("x1", "rejected", { issue: QUIZ }),
  c("q1", "proposed", { issue: QUIZ, language: "ar" }),
  c("o1", "approved", { issue: "kaboom", created_at: minsAgo(90) }),
];
const TOPICS = { t1: "Fractions", t2: "Photosynthesis" };
const ROWS = boardRows(CASES, TOPICS, { "job-1": { status: "processing", progress: 40, stage: { step: "script" } } });
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

describe("boardRows", () => {
  it("carries the plain data the board needs", () => {
    const w1 = ROWS.find((r) => r.id === "w1")!;
    expect(w1).toMatchObject({ status: "proposed", topicTitle: "Fractions", language: "ms", cause: { key: "numbers" }, badge: "Passes with the current check", queue: null, progress: null });
    expect(ROWS.find((r) => r.id === "p1")!.progress).toEqual({ text: "script 40%", pct: 40 });
    // the older approved case goes first, behind the one retrying
    expect(ROWS.find((r) => r.id === "o1")!.queue).toBe("2nd in line · ~30 min");
    expect(ROWS.find((r) => r.id === "a1")!.queue).toBe("3rd in line · ~45 min");
    // a retrying case whose job was not read still says something
    expect(boardRows([c("p2", "applied", { applied_job_id: "gone" })], {}, {})[0].progress).toEqual({ text: "starting", pct: null });
    expect(boardRows([c("t", "proposed", { topic_id: "nope", title: null })], {}, {})[0]).toMatchObject({ topicTitle: null, title: "Untitled case" });
  });
});

describe("filterCases", () => {
  it("filters by status", () => {
    expect(ids(filterCases(ROWS, { status: "open" }))).toEqual(["w1", "w2", "n1", "a1", "p1", "q1", "o1"]);
    expect(ids(filterCases(ROWS, { status: "waiting" }))).toEqual(["w1", "w2", "q1"]);
    expect(ids(filterCases(ROWS, { status: "needs_you" }))).toEqual(["n1"]);
    expect(ids(filterCases(ROWS, { status: "approved" }))).toEqual(["a1", "o1"]);
    expect(ids(filterCases(ROWS, { status: "retrying" }))).toEqual(["p1"]);
    expect(ids(filterCases(ROWS, { status: "in_review" }))).toEqual(["r1"]);
    expect(ids(filterCases(ROWS, { status: "rejected" }))).toEqual(["x1"]);
    expect(filterCases(ROWS, { status: "all" })).toHaveLength(CASES.length);
    // no status = Open
    expect(ids(filterCases(ROWS, {}))).toEqual(ids(filterCases(ROWS, { status: "open" })));
  });

  it("filters by cause, language and a topic search, together", () => {
    expect(ids(filterCases(ROWS, { status: "all", cause: "numbers" }))).toEqual(["w1", "w2", "r1"]);
    expect(ids(filterCases(ROWS, { status: "open", lang: "ar" }))).toEqual(["w2", "q1"]);
    expect(ids(filterCases(ROWS, { status: "all", q: "  photoSYN " }))).toEqual(["w2"]);
    expect(ids(filterCases(ROWS, { status: "waiting", cause: "quiz_item", lang: "ar", q: "fractions" }))).toEqual(["q1"]);
    expect(filterCases(ROWS, { status: "waiting", cause: "throttle" })).toEqual([]);
  });

  it("counts each facet under the other filters", () => {
    const f = facetCounts(ROWS, { ...DEFAULT_PARAMS, lang: "ar" });
    expect(f.status.open).toBe(2);
    expect(f.status.all).toBe(2);
    expect(f.status.waiting).toBe(2);
    expect(f.causes).toEqual([
      { key: "quiz_item", label: "Quiz item dropped", count: 1 },
      { key: "numbers", label: "Numbers differ", count: 1 },
    ]);
    // languages are counted without the language filter
    expect(f.langs).toEqual([
      { code: "ms", count: 5 },
      { code: "ar", count: 2 },
    ]);
    expect(f.langTotal).toBe(7);
  });
});

describe("groupByCause", () => {
  it("puts groups with cases waiting for you (or needing you) first, then the bigger ones; resolved last", () => {
    const g = groupByCause(filterCases(ROWS, { status: "all" }));
    expect(g.map((x) => x.key)).toEqual(["reply_shape", "numbers", "quiz_item", "other", "resolved"]);
    expect(g[0]).toMatchObject({ label: "Model reply shape", waiting: 0, needsYou: 1 });
    expect(ids(g[0].rows)).toEqual(["n1", "a1", "p1"]);
    expect(g[1]).toMatchObject({ waiting: 2, needsYou: 0 });
    expect(ids(g[1].rows)).toEqual(["w1", "w2"]);
    expect(g[g.length - 1]).toMatchObject({ key: "resolved", label: "Resolved" });
    expect(ids(g[g.length - 1].rows)).toEqual(["r1"]);
  });

  it("has no Resolved group when the filter hides resolved cases", () => {
    const g = groupByCause(filterCases(ROWS, { status: "open" }));
    expect(g.map((x) => x.key)).toEqual(["reply_shape", "numbers", "quiz_item", "other"]);
    expect(groupByCause([])).toEqual([]);
  });

  it("orders groups without urgent cases by size", () => {
    const rows = [
      { status: "approved", cause: { key: "numbers", label: "Numbers differ" } },
      { status: "approved", cause: { key: "throttle", label: "Throttled" } },
      { status: "applied", cause: { key: "throttle", label: "Throttled" } },
    ] as Pick<BoardRow, "status" | "cause">[];
    expect(groupByCause(rows).map((x) => x.key)).toEqual(["throttle", "numbers"]);
  });
});

describe("the URL state", () => {
  it("defaults to Open, grouped, and drops unknown values", () => {
    expect(parseBoardParams({})).toEqual(DEFAULT_PARAMS);
    expect(parseBoardParams(null)).toEqual(DEFAULT_PARAMS);
    expect(parseBoardParams({ status: "bogus", cause: "nope", view: "tiles" })).toEqual(DEFAULT_PARAMS);
    expect(parseBoardParams({ status: "waiting", cause: "quiz_item", lang: "ar", q: " frac ", view: "list" })).toEqual({
      status: "waiting",
      cause: "quiz_item",
      lang: "ar",
      q: "frac",
      view: "list",
    });
    expect(parseBoardParams({ status: ["needs_you", "all"] }).status).toBe("needs_you");
  });

  it("writes only what differs from the default, and round-trips", () => {
    expect(boardQuery(DEFAULT_PARAMS)).toBe("");
    const p = { status: "all", cause: "numbers", lang: "ms", q: "a b", view: "list" } as const;
    const qs = boardQuery(p);
    expect(qs).toBe("?status=all&cause=numbers&lang=ms&q=a+b&view=list");
    expect(parseBoardParams(Object.fromEntries(new URLSearchParams(qs.slice(1))))).toEqual(p);
  });
});

describe("labels", () => {
  it("uses the filter chips' words on a row", () => {
    expect(["new", "diagnosing", "proposed", "needs_founder", "approved", "applied", "resolved", "rejected"].map(shortStatus)).toEqual([
      "Diagnosing",
      "Diagnosing",
      "Waiting for you",
      "Needs you",
      "Approved",
      "Retrying",
      "In review",
      "Rejected",
    ]);
    expect(shortStatus("toString")).toBe("toString");
    expect(shortStatus(undefined)).toBe("Unknown");
  });
});
