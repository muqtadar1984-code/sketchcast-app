// SK S5 slice A — school.health: the leader's "how is the school doing"
// (design 2026-10-29 decision 2; Final Plan §4 "School health, teacher flags":
// principal read, coordinator read (scope)).
//
// The School Briefing panel's snapshot, as a tool: school-health's RLS rows
// (one read per turn, shared.ts), cut by leader-scope.ts to the principal's
// school or the coordinator's scope grades (the app-side intersect that closes
// the teacher-class union leak), then computeSchoolHealth — the same rules the
// leadership pages and the teacher's learners.risk use.
//
// Names: a principal hears at-risk learners' names school-wide, a coordinator
// within scope. NEVER a parent's email: computeSchoolHealth carries
// `parentEmail` on each at-risk row; the facts below are built field by field
// without it, and stripEmails runs on the whole result at the boundary.
//
// Session client only (§2.3). Deterministic text from school-lines.ts, so a
// rules-routed answer quotes its own facts and nothing else.

import type { SkCapability, SkCapabilityResult } from "../shell/types";
import { computeSchoolHealth, type SchoolHealth } from "@/utils/school-health";
import { lineFor } from "../shell/lines";
import { S_AT_RISK, S_AT_RISK_NONE, S_BY_GRADE, S_EMPTY, S_NO_SCOPE, S_NOT_YET, S_OUT_OF_SCOPE, S_OVERVIEW, S_READ_FAILED, S_TEACHERS, S_TEACHERS_NONE } from "../shell/school-lines";
import { cutLeaderRows, gradeOutsideScope, leaderScope, needsSubjects, scopeLabel, stripEmails, whereLabel, type LeaderScope } from "./leader-scope";
import { generationSubjects, schoolHealthRows } from "./shared";

export const SCHOOL_AT_RISK_CAP = 30;
export const SCHOOL_TEACHERS_CAP = 10;
const SAY_NAMES = 6;
/** runner.ts SK_FACTS_MAX_ROWS (not imported: the runner imports the registry). */
const FACT_ROWS = 40;

const FOCUS = ["overview", "at_risk", "teachers"] as const;
type Focus = (typeof FOCUS)[number];

const str = (args: Record<string, unknown>, key: string, max = 40): string | undefined =>
  typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim().slice(0, max) : undefined;

const pct = (n: number | null, locale: string) => (n === null ? lineFor(S_NOT_YET, locale) : `${n}%`);

/** The facts a leader answer quotes. Built field by field: no email key exists. Pure. */
export function schoolFacts(h: SchoolHealth, ls: LeaderScope, where: string): Array<Record<string, string | number | null>> {
  const facts: Array<Record<string, string | number | null>> = [
    {
      row: "totals",
      scope: ls.mode,
      where,
      students: h.totals.students,
      classes: h.totals.classes,
      teachers: h.totals.teachers,
      activePct: h.totals.activePct,
      completionPct: h.totals.completionPct,
      atRisk: h.totals.atRisk,
      overdue: h.totals.overdue,
      pendingToGrade: h.totals.pendingToGrade,
    },
  ];
  for (const g of h.atRiskByGrade) facts.push({ row: "grade", grade: g.grade, atRisk: g.count });
  const teachers = [...h.teachers].sort((a, b) => b.flags.length - a.flags.length);
  for (const t of teachers.slice(0, SCHOOL_TEACHERS_CAP))
    facts.push({
      row: "teacher",
      name: t.name,
      lessons: t.lessons,
      assignments: t.assignments,
      pendingToGrade: t.pendingToGrade,
      avgTurnaroundDays: t.avgTurnaroundDays,
      completionPct: t.completionPct,
      flags: t.flags.join(", "),
    });
  // The runner keeps 40 fact rows: the at-risk rows fill what is left.
  const room = Math.max(0, Math.min(SCHOOL_AT_RISK_CAP, FACT_ROWS - facts.length));
  for (const r of h.atRisk.slice(0, room)) facts.push({ row: "at_risk", name: r.name, className: r.className, grade: r.grade, reasons: r.reasons.join(", ") });
  return facts;
}

/** The answer's text for a focus. Pure. */
export function schoolSummary(h: SchoolHealth, focus: Focus, where: string, locale: string): string {
  const atRiskLine = () =>
    h.atRisk.length
      ? lineFor(S_AT_RISK, locale, {
          where,
          n: h.totals.atRisk,
          items: `${h.atRisk
            .slice(0, SAY_NAMES)
            .map((r) => `${r.name} (${r.className}) — ${r.reasons.join(", ")}`)
            .join("; ")}${h.atRisk.length > SAY_NAMES ? "; …" : ""}`,
        })
      : lineFor(S_AT_RISK_NONE, locale, { where, students: h.totals.students });
  const flagged = h.teachers.filter((t) => t.flags.length);
  const teachersLine = () =>
    flagged.length
      ? lineFor(S_TEACHERS, locale, {
          where,
          n: flagged.length,
          items: `${flagged
            .slice(0, SAY_NAMES)
            .map((t) => `${t.name} — ${t.flags.join(", ")}`)
            .join("; ")}${flagged.length > SAY_NAMES ? "; …" : ""}`,
        })
      : lineFor(S_TEACHERS_NONE, locale, { where, teachers: h.totals.teachers });
  if (focus === "at_risk") return atRiskLine();
  if (focus === "teachers") return teachersLine();
  const parts = [
    lineFor(S_OVERVIEW, locale, {
      where,
      students: h.totals.students,
      classes: h.totals.classes,
      teachers: h.totals.teachers,
      active: pct(h.totals.activePct, locale),
      completion: pct(h.totals.completionPct, locale),
      atRisk: h.totals.atRisk,
      overdue: h.totals.overdue,
      pending: h.totals.pendingToGrade,
    }),
  ];
  if (h.atRiskByGrade.length > 1) parts.push(lineFor(S_BY_GRADE, locale, { items: h.atRiskByGrade.map((g) => `${g.grade}: ${g.count}`).join(", ") }));
  if (flagged.length) parts.push(teachersLine());
  return parts.join(" ");
}

export const schoolHealth: SkCapability = {
  meta: {
    name: "school.health",
    description:
      "How the school is doing (principal: the whole school; coordinator: their scope grades only): learners, classes, teachers, % active, % work done, at risk, overdue, awaiting marking; at risk by grade; at-risk learners with reasons; teachers flagged for marking backlog, slow marking or completion below the cohort. Optionally one grade, and a focus (overview, at_risk, teachers).",
    parameters: {
      type: "object",
      properties: {
        focus: { type: "string", enum: [...FOCUS], description: "overview (default), at_risk (names and reasons) or teachers (flags)." },
        grade: { type: "string", description: "Only this grade, e.g. \"5\" or \"Form 2\" (a coordinator: one of their scope grades)." },
      },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["school_admin", "coordinator"],
    hats: ["principal", "coordinator"],
  },
  async handler(ctx, args, deps) {
    const me = ctx.user.id;
    const locale = ctx.user.locale;
    const focus: Focus = FOCUS.find((f) => f === str(args, "focus")) ?? "overview";
    const grade = str(args, "grade", 20);
    const ls = leaderScope(ctx, { hatless: "leader" });
    // Registry already narrows to the leader hats; a context that still lands
    // on "own" (a principal hat without the school_admin role) gets nothing.
    if (ls.mode === "own") return { ok: true, summary: lineFor(S_NO_SCOPE, locale), facts: [], entities: [] };
    if (ls.mode === "scope" && !(ls.rows ?? []).length) return { ok: true, summary: lineFor(S_NO_SCOPE, locale), facts: [], entities: [] };
    if (gradeOutsideScope(ls, grade)) {
      return { ok: true, summary: lineFor(S_OUT_OF_SCOPE, locale, { grade: whereLabel(ls, locale, grade), scope: scopeLabel(ls.rows ?? [], locale) }), facts: [], entities: [] };
    }
    try {
      const all = await schoolHealthRows(deps, me);
      const subjectOf = needsSubjects(ls) ? await generationSubjects(deps, me, all.shares.map((s) => s.generation_id)) : undefined;
      const rows = cutLeaderRows(all, ls, { grade, subjectOf });
      const where = whereLabel(ls, locale, grade);
      if (!rows.classes.length) return { ok: true, summary: lineFor(S_EMPTY, locale, { where }), facts: [], entities: [] };
      const h = computeSchoolHealth(rows, deps.now.getTime());
      const result: SkCapabilityResult = {
        ok: true,
        summary: schoolSummary(h, focus, where, locale).slice(0, 900),
        facts: schoolFacts(h, ls, where),
        entities: rows.classes.slice(0, 20).map((c) => ({ kind: "class" as const, id: c.id, label: c.name || "Class", via: "school.health" })),
      };
      return stripEmails(result);
    } catch (e) {
      return { ok: false, summary: lineFor(S_READ_FAILED, locale), error: e instanceof Error ? e.message : String(e) };
    }
  },
};
