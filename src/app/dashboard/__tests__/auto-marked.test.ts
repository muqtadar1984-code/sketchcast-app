/**
 * Fully auto-marked quizzes must be reviewable and overridable.
 *
 * The quiz API writes grade_status = 'auto' when every question is objective
 * (api/quiz/logic.ts), and the analytics To-grade queue lists only 'pending'.
 * So a teacher could never read those answers, leave feedback or correct the
 * mark. They now get their own "Auto-marked" list; saving there writes a
 * teacher_score (which every reader prefers over auto_score) and 'graded'.
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/auto-marked.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { autoMarkedForReview, buildGradeUpdate, needsOutOf } from "../grade-update";

const sub = (id: string, grade_status: string, submitted_at: string) => ({ id, grade_status, submitted_at });

describe("autoMarkedForReview", () => {
  const subs = [
    sub("old-auto", "auto", "2026-10-01T08:00:00Z"),
    sub("pending", "pending", "2026-10-06T08:00:00Z"),
    sub("graded", "graded", "2026-10-06T09:00:00Z"),
    sub("new-auto", "auto", "2026-10-05T08:00:00Z"),
    sub("mid-auto", "auto", "2026-10-03T08:00:00Z"),
  ];

  it("lists only 'auto' rows, newest first", () => {
    expect(autoMarkedForReview(subs, 30).map((s) => s.id)).toEqual(["new-auto", "mid-auto", "old-auto"]);
  });

  it("caps the list", () => {
    expect(autoMarkedForReview(subs, 2).map((s) => s.id)).toEqual(["new-auto", "mid-auto"]);
  });

  it("does not reorder the caller's array", () => {
    const copy = subs.map((s) => s.id);
    autoMarkedForReview(subs, 30);
    expect(subs.map((s) => s.id)).toEqual(copy);
  });
});

describe("overriding an auto-marked quiz", () => {
  const row = { mode: "interactive", max: 10 };
  const NOW = new Date("2026-10-07T09:00:00Z");

  it("needs no 'out of' — the quiz already has a max", () => {
    expect(needsOutOf(row)).toBe(false);
  });

  it("writes the teacher's mark and feedback, flips to graded, leaves max_score alone", () => {
    const r = buildGradeUpdate(row, { score: "6", outOf: undefined, feedback: "Check Q3" }, "t1", NOW);
    expect(r).toEqual({
      ok: true,
      update: {
        teacher_score: 6,
        feedback: "Check Q3",
        grade_status: "graded",
        graded_by: "t1",
        graded_at: NOW.toISOString(),
      },
    });
  });

  it("the override wins in every reader (teacher_score ?? auto_score)", () => {
    const r = buildGradeUpdate(row, { score: "6", outOf: undefined, feedback: "" }, "t1", NOW);
    if (!r.ok) throw new Error(r.error);
    const saved = { auto_score: 9, max_score: 10, ...r.update };
    expect(`${saved.teacher_score ?? saved.auto_score}/${saved.max_score}`).toBe("6/10");
  });

  it("a retake still un-grades the override (quiz API nulls teacher_score)", () => {
    const src = readFileSync(path.resolve(__dirname, "../../api/quiz/logic.ts"), "utf-8");
    const at = src.indexOf('mode: "interactive"');
    const row = src.slice(at, src.indexOf("attempt_count: attempt", at));
    expect(row).toMatch(/teacher_score: null/);
    expect(row).toMatch(/grade_status: score\.needsReview \? "pending" : "auto"/);
  });
});

describe("analytics page wiring", () => {
  const page = readFileSync(path.resolve(__dirname, "../analytics/page.tsx"), "utf-8");

  it("renders the auto-marked list with the override variant", () => {
    expect(page).toMatch(/autoMarkedForReview\(subs, AUTO_MARKED_LIMIT\)/);
    expect(page).toMatch(/<GradeList pending=\{autoMarked\} variant="autoMarked" \/>/);
  });

  it("signs quiz questions for auto-marked rows too, so 'Review answers' works", () => {
    const at = page.indexOf("const pendingInteractiveGenIds");
    expect(page.slice(at, page.indexOf("];", at))).toMatch(/autoMarkedSubs/);
  });

  it("keeps the To-grade queue to pending rows only", () => {
    expect(page).toMatch(/subs\.filter\(\(s\) => s\.grade_status === "pending"\)\.map\(toPendingSub\)/);
  });
});

describe("i18n", () => {
  const LOCALES = ["en", "ar", "es", "fr", "hi", "mr", "ms", "ms-arab", "pt", "te"];
  it.each(LOCALES)("%s has both new strings, translated (not English) outside en", (loc) => {
    const d = JSON.parse(
      readFileSync(path.resolve(__dirname, `../../../i18n/messages/${loc}.json`), "utf-8"),
    ) as { school: { myAnalytics: Record<string, string> } };
    const t = d.school.myAnalytics;
    expect(t.autoMarkedTitle).toBeTruthy();
    expect(t.autoMarkedHint).toBeTruthy();
    if (loc !== "en") {
      expect(t.autoMarkedTitle).not.toBe("Auto-marked quizzes");
      expect(t.autoMarkedHint).not.toMatch(/Review the answers/);
    }
  });
});
