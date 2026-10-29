/**
 * S5 slice A — the leader phrasings (EN / MS / AR), at least six per
 * capability, routed deterministically ONLY on a leader hat; and
 * sk.shell.school.* (school-lines.ts) equal to the ten dictionaries.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/leader-rules.test.ts
 */
import { describe, expect, it } from "vitest";
import { gradeOf, routeLeader } from "../leader-rules";
import { routeByRules } from "../rules";
import { SCHOOL_LINES } from "../school-lines";
import { makeCtx, NOW } from "./fixtures";
import { LOCALES } from "@/i18n/locales";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import te from "@/i18n/messages/te.json";
import mr from "@/i18n/messages/mr.json";
import hi from "@/i18n/messages/hi.json";
import msArab from "@/i18n/messages/ms-arab.json";

const principal = makeCtx({ role: "school_admin", hat: "principal" });
const coordinator = makeCtx({ role: "teacher", hat: "coordinator", scope: [{ grade: "5", subject: null }] });

const CASES: Array<[string, string, Record<string, string>]> = [
  // school.health — overview
  ["how is the school doing", "school.health", { focus: "overview" }],
  ["How's the school doing?", "school.health", { focus: "overview" }],
  ["how are we doing as a school", "school.health", { focus: "overview" }],
  ["give me a school summary", "school.health", { focus: "overview" }],
  ["how is grade 5 doing", "school.health", { focus: "overview", grade: "grade 5" }],
  ["bagaimana prestasi sekolah", "school.health", { focus: "overview" }],
  ["macam mana sekolah kita?", "school.health", { focus: "overview" }],
  ["ringkasan sekolah", "school.health", { focus: "overview" }],
  ["bagaimana prestasi tahun 5", "school.health", { focus: "overview", grade: "tahun 5" }],
  ["كيف حال المدرسة", "school.health", { focus: "overview" }],
  ["كيف أداء المدرسة؟", "school.health", { focus: "overview" }],
  ["ملخص المدرسة", "school.health", { focus: "overview" }],
  // school.health — teachers
  ["which teachers have marking piling up", "school.health", { focus: "teachers" }],
  ["Which teachers are behind on marking?", "school.health", { focus: "teachers" }],
  ["which teachers need help in grade 5", "school.health", { focus: "teachers", grade: "grade 5" }],
  ["show me the teacher flags", "school.health", { focus: "teachers" }],
  ["guru mana yang tertunggak menanda", "school.health", { focus: "teachers" }],
  ["guru mana perlukan bantuan", "school.health", { focus: "teachers" }],
  ["أي المعلمين لديهم تصحيح متراكم", "school.health", { focus: "teachers" }],
  ["المعلمون المتأخرون في التصحيح", "school.health", { focus: "teachers" }],
  // learners.risk
  ["who's at risk in grade 5", "learners.risk", { grade: "grade 5" }],
  ["who is at risk?", "learners.risk", {}],
  ["which students are at risk", "learners.risk", {}],
  ["show me the at-risk students", "learners.risk", {}],
  ["who is falling behind in year 5", "learners.risk", { grade: "year 5" }],
  ["siapa berisiko dalam tahun 5", "learners.risk", { grade: "tahun 5" }],
  ["murid mana yang berisiko", "learners.risk", {}],
  ["siapa yang ketinggalan", "learners.risk", {}],
  ["من المعرضون للخطر في الصف 5", "learners.risk", { grade: "grade 5" }],
  ["أي الطلاب في خطر", "learners.risk", {}],
  ["من هم الطلاب المتعثرون", "learners.risk", {}],
  // assignments.status
  ["how are assignments going", "assignments.status", {}],
  ["what's overdue in grade 5", "assignments.status", { grade: "grade 5" }],
  ["show me the assignment status", "assignments.status", {}],
  ["which assignments are overdue", "assignments.status", {}],
  ["status tugasan", "assignments.status", {}],
  ["tugasan yang lewat dalam tahun 5", "assignments.status", { grade: "tahun 5" }],
  ["bagaimana dengan kerja rumah", "assignments.status", {}],
  ["ما حالة الواجبات", "assignments.status", {}],
  ["الواجبات المتأخرة في الصف ٥", "assignments.status", { grade: "grade 5" }],
  ["كيف تسير الواجبات", "assignments.status", {}],
  // timetable.now_next
  ["what's happening now", "timetable.now_next", {}],
  ["who is teaching right now", "timetable.now_next", {}],
  ["what lessons are on now", "timetable.now_next", {}],
  // S5 gate finding 2026-10-29 (p-tt-02, c-tt-03): "next" asks for the NEXT period.
  ["what's on next period", "timetable.now_next", { when: "next" }],
  ["what's on next", "timetable.now_next", { when: "next" }],
  ["who is teaching next", "timetable.now_next", { when: "next" }],
  ["what's next in grade 5", "timetable.now_next", { when: "next", grade: "grade 5" }],
  ["kelas apa seterusnya", "timetable.now_next", { when: "next" }],
  ["siapa mengajar seterusnya", "timetable.now_next", { when: "next" }],
  ["ما الحصة التالية", "timetable.now_next", { when: "next" }],
  ["من يدرس في الحصة التالية", "timetable.now_next", { when: "next" }],
  ["siapa mengajar sekarang", "timetable.now_next", {}],
  ["kelas apa sekarang", "timetable.now_next", {}],
  ["من يدرّس الآن", "timetable.now_next", {}],
  ["ما الحصص الآن", "timetable.now_next", {}],
  ["ماذا يحدث الآن", "timetable.now_next", {}],
];

describe("routeLeader — leader hats only, deterministic", () => {
  for (const [text, capability, args] of CASES) {
    it(`"${text}" → ${capability}`, () => {
      expect(routeLeader(text, principal)).toEqual({ capability, args });
      expect(routeLeader(text, coordinator)).toEqual({ capability, args });
    });
  }

  it("at least six phrasings per capability, in all three launch languages", () => {
    const by = new Map<string, string[]>();
    for (const [t, c] of CASES) by.set(c, [...(by.get(c) ?? []), t]);
    for (const [c, ts] of by) {
      expect(ts.length, c).toBeGreaterThanOrEqual(6);
      expect(ts.some((t) => /[؀-ۿ]/.test(t)), `${c} arabic`).toBe(true);
      expect(ts.some((t) => /\b(?:sekolah|siapa|murid|guru|tugasan|kelas|kerja|status tugasan)\b/.test(t)), `${c} malay`).toBe(true);
    }
  });

  it("the teacher hat, hats off, a parent and a student get no leader route (S0 behaviour unchanged)", () => {
    for (const ctx of [
      makeCtx({ role: "teacher", hat: "teacher" }),
      makeCtx({ role: "school_admin", hat: "teacher" }),
      makeCtx({ role: "school_admin", hat: null }),
      makeCtx({ role: "teacher", hat: "teacher", scope: [{ grade: "5", subject: null }] }),
      makeCtx({ role: "parent", hat: "parent" }),
      makeCtx({ role: "student" }),
    ])
      expect(routeLeader("who's at risk in grade 5", ctx)).toBeNull();
  });

  it("not a leader phrasing → null", () => {
    for (const t of ["open analytics", "post a notice to 5A: sports day", "explain photosynthesis", "how is Aisyah doing", "who is Aisyah"]) expect(routeLeader(t, principal)).toBeNull();
  });

  it("routeByRules returns the leader decision before navigation", () => {
    expect(routeByRules("how is the school doing", principal, NOW)).toEqual({ intent: "ask", leader: { capability: "school.health", args: { focus: "overview" } } });
    expect(routeByRules("siapa berisiko dalam tahun 5", coordinator, NOW)).toEqual({ intent: "ask", leader: { capability: "learners.risk", args: { grade: "tahun 5" } } });
    // The same words on the teacher hat go to the model, as before S5.
    expect(routeByRules("who's at risk in grade 5", makeCtx({ role: "teacher", hat: "teacher" }), NOW)).toEqual({ intent: "ask" });
    // Navigation is untouched for leaders.
    expect(routeByRules("open analytics", principal, NOW)).toMatchObject({ intent: "navigate", target: "analytics" });
  });

  it("gradeOf", () => {
    expect(gradeOf("who is at risk in form 2")).toBe("form 2");
    expect(gradeOf("siapa berisiko dalam tingkatan 3")).toBe("tingkatan 3");
    expect(gradeOf("من المعرضون للخطر في الصف ٥")).toBe("grade 5");
    expect(gradeOf("who is at risk in 5b")).toBeUndefined();
    expect(gradeOf("who is at risk")).toBeUndefined();
  });
});

type Shell = { sk: { shell: { school: Record<string, string | Record<string, string>> } } };
const FILES: Record<string, Shell> = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, Shell>;

describe("school-lines.ts ⇄ messages/*.json (sk.shell.school.*)", () => {
  it("every key, every locale, equal; placeholders kept", () => {
    for (const { value } of LOCALES) {
      const dict = FILES[value].sk.shell.school;
      // S5 slice C keeps its own lines in the `figures` sub-block (school-figure-lines.ts).
      expect(Object.keys(dict).filter((k) => typeof dict[k] === "string").sort(), value).toEqual(Object.keys(SCHOOL_LINES).sort());
      for (const [key, line] of Object.entries(SCHOOL_LINES)) {
        expect(line[value], `${value}.${key}`).toBe(dict[key]);
        const want = (line.en.match(/\{\w+\}/g) ?? []).sort();
        expect((line[value].match(/\{\w+\}/g) ?? []).sort(), `${value}.${key} placeholders`).toEqual(want);
      }
    }
    for (const line of Object.values(SCHOOL_LINES)) expect(Object.keys(line).sort()).toEqual(LOCALES.map((l) => l.value).sort());
  });
  it("Jawi is Jawi (Arabic script), not Rumi", () => {
    for (const [key, line] of Object.entries(SCHOOL_LINES)) expect(line["ms-arab"], key).toMatch(/[؀-ۿ]/);
  });
});
