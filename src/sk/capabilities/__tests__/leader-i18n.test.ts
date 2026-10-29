/**
 * S5 gate finding 2026-10-29 — the i18n leftovers in leader answers:
 *   - at-risk reasons and teacher flags ("never started", "3 to grade") are
 *     said from school-health's CODES through sk.shell.school.reason* /
 *     flag* keys, never by matching the English;
 *   - a grade said as "grade 5" / "الصف 5" is localised ("نظرة عامة على grade 5");
 *   - the notice card's "Nothing is posted until…" closes in the leader's language.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/leader-i18n.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSchoolHealth, learnerReasons, riskReasonText, teacherFlagText, type RiskReason, type SchoolHealth, type TeacherFlag } from "@/utils/school-health";
import { flagLabel, flagsSaid, gradeLabel, reasonLabel, reasonsSaid, whereLabel, leaderScope } from "../leader-scope";
import { schoolSummary } from "../school";
import { learnersRisk } from "../risk";
import { resolveNoticeSchool } from "../notice";
import { NOTICE_NOT_UNTIL } from "@/sk/shell/act-notice-lines";
import { S_F_TO_GRADE, S_R_NEVER } from "@/sk/shell/school-lines";
import { localizeReason } from "@/sk/parent-digest";
import { NOW as SHELL_NOW, SCHOOL_ID, fakeSession, makeCtx } from "@/sk/shell/__tests__/fixtures";
import { FakeDb, allRows, coordinatorCtx, depsFor, principalCtx } from "./leader-fixtures";

const ALL_REASONS: RiskReason[] = [
  { code: "completion", pct: 40 },
  { code: "inactive", days: 16 },
  { code: "never_started" },
  { code: "avg_score", pct: 35 },
  { code: "declining" },
  { code: "overdue", n: 2 },
];
const ALL_FLAGS: TeacherFlag[] = [
  { code: "below_cohort", pts: 20 },
  { code: "to_grade", n: 3 },
  { code: "slow_grading", days: 8.5 },
];

describe("reason and flag codes (school-health)", () => {
  it("the English text is exactly the pages' wording", () => {
    expect(ALL_REASONS.map(riskReasonText)).toEqual(["40% completion", "inactive 16d", "never started", "avg score 35%", "scores declining", "2 overdue"]);
    expect(ALL_FLAGS.map(teacherFlagText)).toEqual(["20pts below cohort", "3 to grade", "8.5d to grade"]);
  });
  it("learnerReasons returns the codes beside the text, in the same order", () => {
    const r = learnerReasons({ assigned: 4, completed: 1, overdue: 3, lastActivity: null, scores: [], now: 0 });
    expect(r.codes.map(riskReasonText)).toEqual(r.reasons);
    expect(r.codes.map((c) => c.code)).toEqual(["completion", "never_started", "overdue"]);
  });
  it("computeSchoolHealth carries codes on at-risk rows and flag codes on teachers (opt-in; the Briefing snapshot is unchanged)", () => {
    const rows = {
        classes: [{ id: "c1", name: "5A", grade: "5", teacher_id: "t1" }],
        enrollments: [{ class_id: "c1", student_id: "s1", full_name: "Amir", username: null, parent_email: null }],
        shares: [1, 2, 3].map((i) => ({ generation_id: `g${i}`, class_id: "c1", shared_by: "t1", due_at: "2026-10-01T00:00:00Z" })),
        progress: [],
        submissions: [1, 2, 3].map((i) => ({ generation_id: `g${i}`, student_id: "s9", auto_score: null, max_score: null, teacher_score: null, submitted_at: "2026-10-20T00:00:00Z", graded_at: null, grade_status: "pending" })),
        generations: [1, 2, 3].map((i) => ({ id: `g${i}`, owner_id: "t1" })),
        teacherNames: { t1: "Cikgu Bakar" },
      };
    const now = new Date("2026-10-28T00:00:00Z").getTime();
    const h = computeSchoolHealth(rows, now, { codes: true });
    const plain = computeSchoolHealth(rows, now);
    expect(plain.atRisk[0]).not.toHaveProperty("codes");
    expect(plain.teachers[0]).not.toHaveProperty("flagCodes");
    expect(plain.atRisk[0].reasons).toEqual(h.atRisk[0].reasons);
    expect(plain.teachers[0].flags).toEqual(h.teachers[0].flags);
    const row = h.atRisk[0];
    expect(row.codes!.map(riskReasonText)).toEqual(row.reasons);
    expect(h.teachers[0].flagCodes!.map(teacherFlagText)).toEqual(h.teachers[0].flags);
    expect(h.teachers[0].flags).toContain("3 to grade");
  });
});

describe("reasons and flags in the reader's language", () => {
  it("English is unchanged; Malay and Arabic carry no English reason text", () => {
    expect(ALL_REASONS.map((r) => reasonLabel(r, "en"))).toEqual(ALL_REASONS.map(riskReasonText));
    expect(ALL_FLAGS.map((f) => flagLabel(f, "en"))).toEqual(ALL_FLAGS.map(teacherFlagText));
    for (const loc of ["ms", "ar", "ms-arab", "fr", "hi"]) {
      const said = [...ALL_REASONS.map((r) => reasonLabel(r, loc)), ...ALL_FLAGS.map((f) => flagLabel(f, loc))].join(" | ");
      expect(said, loc).not.toMatch(/never started|to grade|completion|inactive|avg score|declining|overdue|below cohort/);
      // Every number survives the translation (the answer stays grounded).
      for (const n of ["40", "16", "35", "2", "20", "3", "8.5"]) expect(said, `${loc} ${n}`).toContain(n);
    }
    expect(flagLabel({ code: "to_grade", n: 3 }, "ms")).toBe("3 untuk ditanda");
    expect(reasonLabel({ code: "never_started" }, "ar")).toBe(S_R_NEVER.ar);
    expect(flagLabel({ code: "to_grade", n: 3 }, "ar")).toBe(S_F_TO_GRADE.ar.replace("{n}", "3"));
  });
  it("a row without codes falls back to its English text", () => {
    expect(reasonsSaid({ reasons: ["never started"] }, "ms")).toBe("never started");
    expect(flagsSaid({ flags: ["3 to grade"] }, "ar")).toBe("3 to grade");
  });
  it("schoolSummary (school.health) says flags and reasons in Malay and Arabic", () => {
    const h: SchoolHealth = {
      totals: { students: 13, classes: 4, teachers: 3, activePct: 62, completionPct: 62, atRisk: 1, overdue: 5, pendingToGrade: 5 },
      atRiskByGrade: [{ grade: "5", count: 1 }],
      atRisk: [{ name: "Amir", className: "5 Amanah", grade: "5", reasons: ["never started"], codes: [{ code: "never_started" }], parentEmail: null }],
      classes: [],
      teachers: [{ name: "Cikgu Bakar", lessons: 2, assignments: 2, pendingToGrade: 3, avgTurnaroundDays: null, completionPct: 50, flags: ["3 to grade"], flagCodes: [{ code: "to_grade", n: 3 }] }],
    };
    const ms = schoolSummary(h, "overview", "sekolah", "ms");
    expect(ms).toContain("Cikgu Bakar — 3 untuk ditanda");
    expect(ms).not.toContain("to grade");
    const ar = schoolSummary(h, "at_risk", "المدرسة", "ar");
    expect(ar).toContain(`Amir (5 Amanah) — ${S_R_NEVER.ar}`);
    expect(ar).not.toContain("never started");
    expect(schoolSummary(h, "teachers", "the school", "en")).toContain("Cikgu Bakar — 3 to grade");
  });
  it("learners.risk (principal, Malay / Arabic) through the capability", async () => {
    const db = new FakeDb(allRows());
    const ms = await learnersRisk.handler(principalCtx(undefined, undefined, "principal", "ms"), {}, depsFor(db));
    expect(ms.summary).toContain(S_R_NEVER.ms);
    expect(ms.summary).not.toContain("never started");
    const ar = await learnersRisk.handler(principalCtx(undefined, undefined, "principal", "ar"), {}, depsFor(db));
    expect(ar.summary).toContain(S_R_NEVER.ar);
    const en = await learnersRisk.handler(principalCtx(), {}, depsFor(db));
    expect(en.summary).toContain("never started");
  });
  it("a parent's child.risk reasons come from the codes too", () => {
    expect(localizeReason({ code: "inactive", days: 16 }, "ms")).toMatch(/16/);
    expect(localizeReason({ code: "never_started" }, "en")).toBe("has not started yet");
  });
});

describe("grade labels", () => {
  it('"grade 5" / "الصف 5" / "year 5" are said in the reader\'s language; other systems are kept', () => {
    expect(gradeLabel("grade 5", "ar")).toBe("الصف 5");
    expect(gradeLabel("الصف 5", "ar")).toBe("الصف 5");
    expect(gradeLabel("grade 5", "ms")).toBe("tahun 5");
    expect(gradeLabel("year 6", "en")).toBe("grade 6");
    expect(gradeLabel("tahun 4", "en")).toBe("grade 4");
    expect(gradeLabel("5", "ar")).toBe("الصف 5");
    expect(gradeLabel("Form 1", "ar")).toBe("Form 1");
    expect(gradeLabel("tingkatan 2", "ms")).toBe("tingkatan 2");
  });
  it("whereLabel for a coordinator asked in Arabic about 'grade 5' (the rules' gradeOf form)", () => {
    const ctx = coordinatorCtx("coordinator", [{ grade: "5", subject: null }], "ar");
    expect(whereLabel(leaderScope(ctx), "ar", "grade 5")).toBe("الصف 5");
    expect(whereLabel(leaderScope(ctx), "ar", "grade 6")).toBe("الصف 6");
  });
});

describe("notice card — the closing line in the leader's language", () => {
  const saved: { v?: string } = {};
  beforeEach(() => {
    saved.v = process.env.FEATURE_NOTICES;
    process.env.FEATURE_NOTICES = "true";
  });
  afterEach(() => {
    if (saved.v === undefined) delete process.env.FEATURE_NOTICES;
    else process.env.FEATURE_NOTICES = saved.v;
  });
  const deps = () => ({ session: fakeSession({ schools: [{ id: SCHOOL_ID, name: "Demo School" }] }) as never, now: SHELL_NOW });
  it.each(["en", "ms", "ar", "ms-arab"])("%s", async (locale) => {
    const r = await resolveNoticeSchool(makeCtx({ role: "school_admin", hat: "principal", locale }), { body: "Sports Day this Friday." }, deps());
    expect(r.ok).toBe(true);
    expect(r.summary.endsWith(NOTICE_NOT_UNTIL[locale])).toBe(true);
    if (locale !== "en") expect(r.summary).not.toContain("Nothing is posted until");
  });
});
