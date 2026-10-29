// S4 — the parent's answers, written deterministically (no model call): one
// block per child for child.status / diary / notices / risk / progress, and
// the in-app weekly digest (child.week) with "What to do about it" — up to two
// concrete next steps (design 2026-10-29, decision 1; Final Plan §4 "parent
// weekly digest and what to do about it").
//
// PURE: rows in, words out. Every input is ALREADY one child's (the capability
// cut it with child-work.ts / computeLearnerHealth / childMastery); nothing
// here reads, and every line comes from parent-lines.ts in the parent's locale.

import type { SkChild } from "./shell/types";
import { lineFor } from "./shell/lines";
import {
  P_DIARY_LINE,
  P_DIARY_NONE,
  P_DUE_ON,
  P_GROUP_GETTING,
  P_GROUP_LIST,
  P_GROUP_MASTERED,
  P_GROUP_NEEDS,
  P_LATEST_SCORE,
  P_NOTICES_HOME,
  P_NOTICES_LINE,
  P_NOTICES_NONE,
  P_OVERDUE_LIST,
  P_PROGRESS_LINE,
  P_PROGRESS_NONE,
  P_R_AVG,
  P_R_COMPLETION,
  P_R_DECLINING,
  P_R_INACTIVE,
  P_R_NEVER,
  P_R_OVERDUE,
  P_RISK_AT_RISK,
  P_RISK_NO_WORK,
  P_RISK_ON_TRACK,
  P_RISK_WELL,
  P_STATUS_LINE,
  P_STATUS_NONE,
  P_STEP_FINISH,
  P_STEP_FINISH_BY,
  P_STEP_GO_OVER,
  P_STEP_REVISIT,
  P_TEACHER_NOTE,
  P_UNTITLED,
  P_WEEK_LINE,
  P_WEEK_NOTHING,
  P_WEEK_TODO,
} from "./shell/parent-lines";
import { isDoneStatus, type ChildWorkItem } from "@/utils/child-work";
import { MIN_ASSIGNED, type LearnerHealth } from "@/utils/school-health";
import type { ChildMasteryRow } from "./parent-mastery";

export type Fact = Record<string, string | number | boolean | null>;
export type Block = { summary: string; facts: Fact[] };

const DAY = 86_400_000;
export const DIARY_DAYS = 14;
export const WEEK_DAYS = 7;
/** "Did well" (S4; school-health defines only at-risk): no at-risk reason, and
 *  at least this share of 2+ pieces done, or this average score. */
export const DID_WELL_COMPLETION = 0.8;
export const DID_WELL_SCORE = 0.8;
/** A scored piece below this is worth going over together. */
export const GO_OVER_SCORE = 0.5;

const LANG: Record<string, string> = { en: "en-GB", ms: "ms-MY", "ms-arab": "ms-MY", ar: "ar", fr: "fr-FR", es: "es-ES", pt: "pt-PT", te: "te-IN", mr: "mr-IN", hi: "hi-IN" };

/** "Tue, 27 Oct" in the parent's language, school time (UTC+8, the calendar doctrine). */
export function shortDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00+08:00` : iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(LANG[locale] ?? "en-GB", { timeZone: "Asia/Kuala_Lumpur", weekday: "short", day: "numeric", month: "short" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const titleOf = (it: Pick<ChildWorkItem, "title">, locale: string) => clip(it.title || lineFor(P_UNTITLED, locale), 60);
const scoreText = (it: ChildWorkItem) => (it.score ? `${it.score.points ?? "—"}/${it.score.max}` : null);
const scorePct = (it: ChildWorkItem) => (it.score && it.score.points != null && it.score.max > 0 ? it.score.points / it.score.max : null);
const at = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

// ── child.status ────────────────────────────────────────────────────────────

export function statusBlock(child: SkChild, items: ChildWorkItem[], locale: string): Block {
  const name = child.firstName;
  if (!items.length) return { summary: lineFor(P_STATUS_NONE, locale, { name }), facts: [] };
  const done = items.filter((i) => isDoneStatus(i.status)).length;
  const overdue = items.filter((i) => i.overdue).sort((a, b) => at(a.due) - at(b.due));
  const awaiting = items.filter((i) => i.awaitingMarking).length;
  const parts = [lineFor(P_STATUS_LINE, locale, { name, total: items.length, done, overdue: overdue.length, awaiting })];
  if (overdue.length)
    parts.push(lineFor(P_OVERDUE_LIST, locale, { items: overdue.slice(0, 3).map((i) => lineFor(P_DUE_ON, locale, { title: titleOf(i, locale), date: shortDate(i.due, locale) })).join("; ") }));
  const scored = items.filter((i) => i.score).sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
  if (scored[0]) parts.push(lineFor(P_LATEST_SCORE, locale, { title: titleOf(scored[0], locale), score: scoreText(scored[0])! }));
  const noted = items.filter((i) => i.feedback).sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
  if (noted[0]) parts.push(lineFor(P_TEACHER_NOTE, locale, { title: titleOf(noted[0], locale), text: clip(noted[0].feedback!, 140) }));
  return {
    summary: parts.join(" "),
    facts: items.slice(0, 15).map((i) => ({
      child: name,
      title: titleOf(i, locale),
      kind: i.kind,
      from: i.direct ? "direct" : "class",
      due: i.due ? i.due.slice(0, 10) : null,
      status: i.status,
      overdue: i.overdue,
      awaitingMarking: i.awaitingMarking,
      score: scoreText(i),
      feedback: i.feedback ? clip(i.feedback, 200) : null,
    })),
  };
}

// ── child.diary ─────────────────────────────────────────────────────────────

export type ChildDiaryNote = { id: string; authorId: string; classId: string | null; studentId: string | null; type: string; body: string; entryDate: string; createdAt: string };

export function diaryBlock(child: SkChild, notes: ChildDiaryNote[], locale: string, me: string): Block {
  const name = child.firstName;
  const sorted = notes.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!sorted.length) return { summary: lineFor(P_DIARY_NONE, locale, { name, days: DIARY_DAYS }), facts: [] };
  const latest = sorted[0];
  return {
    summary: lineFor(P_DIARY_LINE, locale, { name, days: DIARY_DAYS, n: sorted.length, date: shortDate(latest.entryDate, locale), text: clip(latest.body.replace(/\s+/g, " ").trim(), 160) }),
    facts: sorted.slice(0, 10).map((n) => ({
      child: name,
      date: n.entryDate,
      type: n.type,
      scope: n.studentId ? "child" : "class",
      from: n.authorId === me ? "you" : "school",
      text: clip(n.body.replace(/\s+/g, " ").trim(), 280),
    })),
  };
}

// ── child.notices ───────────────────────────────────────────────────────────

export type ChildNotice = { title: string; when: string };

/** `notices` null = the child's school has notices off (or the read failed). */
export function noticesBlock(child: SkChild, notices: ChildNotice[] | null, locale: string): Block {
  const name = child.firstName;
  if (child.source !== "school" || !child.schoolId) return { summary: lineFor(P_NOTICES_HOME, locale, { name }), facts: [] };
  if (!notices?.length) return { summary: lineFor(P_NOTICES_NONE, locale, { name }), facts: [] };
  return {
    summary: lineFor(P_NOTICES_LINE, locale, { name, items: notices.slice(0, 3).map((n) => `${clip(n.title, 80)} (${n.when})`).join("; ") }),
    facts: notices.slice(0, 8).map((n) => ({ child: name, title: clip(n.title, 120), when: n.when })),
  };
}

// ── child.risk ──────────────────────────────────────────────────────────────

/** school-health's reason text → the parent's language (the rule is the same). */
export function localizeReason(reason: string, locale: string): string {
  let m = reason.match(/^(\d+)% completion$/);
  if (m) return lineFor(P_R_COMPLETION, locale, { pct: m[1] });
  m = reason.match(/^inactive (\d+)d$/);
  if (m) return lineFor(P_R_INACTIVE, locale, { days: m[1] });
  if (reason === "never started") return lineFor(P_R_NEVER, locale);
  m = reason.match(/^avg score (\d+)%$/);
  if (m) return lineFor(P_R_AVG, locale, { pct: m[1] });
  if (reason === "scores declining") return lineFor(P_R_DECLINING, locale);
  m = reason.match(/^(\d+) overdue$/);
  if (m) return lineFor(P_R_OVERDUE, locale, { n: m[1] });
  return reason;
}

export type RiskVerdict = "at_risk" | "did_well" | "on_track" | "no_work";

export function riskVerdict(h: LearnerHealth): { verdict: RiskVerdict; well: Array<{ kind: "completion" | "score"; pct: number }> } {
  if (!h.assigned) return { verdict: "no_work", well: [] };
  if (h.reasons.length) return { verdict: "at_risk", well: [] };
  const well: Array<{ kind: "completion" | "score"; pct: number }> = [];
  if (h.assigned >= MIN_ASSIGNED && h.completed / h.assigned >= DID_WELL_COMPLETION) well.push({ kind: "completion", pct: Math.round((h.completed / h.assigned) * 100) });
  if (h.avg != null && h.avg >= DID_WELL_SCORE) well.push({ kind: "score", pct: Math.round(h.avg * 100) });
  return { verdict: well.length ? "did_well" : "on_track", well };
}

export function riskBlock(child: SkChild, h: LearnerHealth, locale: string): Block {
  const name = child.firstName;
  const { verdict, well } = riskVerdict(h);
  const fact: Fact = {
    child: name,
    verdict,
    reasons: h.reasons.join(", ") || null,
    assigned: h.assigned,
    done: h.completed,
    overdue: h.overdue,
    completionPct: h.completionPct,
    avgScorePct: h.avg == null ? null : Math.round(h.avg * 100),
  };
  if (verdict === "no_work") return { summary: lineFor(P_RISK_NO_WORK, locale, { name }), facts: [fact] };
  if (verdict === "at_risk") return { summary: lineFor(P_RISK_AT_RISK, locale, { name, reasons: h.reasons.map((r) => localizeReason(r, locale)).join(", ") }), facts: [fact] };
  if (verdict === "did_well")
    return {
      summary: lineFor(P_RISK_WELL, locale, { name, reasons: well.map((w) => lineFor(w.kind === "completion" ? P_R_COMPLETION : P_R_AVG, locale, { pct: w.pct })).join(", ") }),
      facts: [fact],
    };
  return { summary: lineFor(P_RISK_ON_TRACK, locale, { name }), facts: [fact] };
}

// ── child.progress ──────────────────────────────────────────────────────────

export type MasteryGroups = { mastered: ChildMasteryRow[]; gettingThere: ChildMasteryRow[]; needsWork: ChildMasteryRow[] };

export function groupMastery(rows: ChildMasteryRow[]): MasteryGroups {
  const by = (s: string[]) => rows.filter((r) => s.includes(r.status)).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return { mastered: by(["mastered"]), gettingThere: by(["in_progress", "provisional"]), needsWork: by(["needs_work"]) };
}

export function progressBlock(child: SkChild, rows: ChildMasteryRow[] | null, locale: string): Block {
  const name = child.firstName;
  const g = groupMastery(rows ?? []);
  const total = g.mastered.length + g.gettingThere.length + g.needsWork.length;
  if (!total) return { summary: lineFor(P_PROGRESS_NONE, locale, { name }), facts: [] };
  const parts = [lineFor(P_PROGRESS_LINE, locale, { name, mastered: g.mastered.length, getting: g.gettingThere.length, needs: g.needsWork.length })];
  const list = (rs: ChildMasteryRow[], group: Record<string, string>) =>
    rs.length ? parts.push(lineFor(P_GROUP_LIST, locale, { group: lineFor(group, locale), items: rs.slice(0, 3).map((r) => clip(r.label, 70)).join("; ") })) : 0;
  list(g.needsWork, P_GROUP_NEEDS);
  list(g.gettingThere, P_GROUP_GETTING);
  list(g.mastered, P_GROUP_MASTERED);
  const facts: Fact[] = [];
  for (const [group, rs] of [["needs_work", g.needsWork], ["getting_there", g.gettingThere], ["mastered", g.mastered]] as const)
    for (const r of rs.slice(0, 10)) facts.push({ child: name, group, idea: clip(r.label, 120), kit: r.kit });
  return { summary: parts.join(" "), facts };
}

// ── child.week: the digest + "What to do about it" ─────────────────────────

export type WeekInput = { items: ChildWorkItem[]; notes: ChildDiaryNote[]; mastery: ChildMasteryRow[] | null };

/** Up to two concrete next steps, the same for the same rows: the oldest
 *  overdue piece; then an idea that needs work (revisit it in its kit); then
 *  the next piece due within a week; then a low score to go over together. */
export function nextSteps(input: WeekInput, locale: string, now: number): string[] {
  const steps: string[] = [];
  const add = (s: string) => {
    if (steps.length < 2 && !steps.includes(s)) steps.push(s);
  };
  const overdue = input.items.filter((i) => i.overdue).sort((a, b) => at(a.due) - at(b.due));
  if (overdue[0]) add(lineFor(P_STEP_FINISH, locale, { title: titleOf(overdue[0], locale) }));
  const weak = groupMastery(input.mastery ?? []).needsWork[0];
  if (weak) add(lineFor(P_STEP_REVISIT, locale, { objective: clip(weak.label, 70), kit: weak.kit ? clip(weak.kit, 60) : "SK" }));
  const soon = input.items
    .filter((i) => !isDoneStatus(i.status) && !i.overdue && i.due && at(i.due) >= now && at(i.due) - now <= WEEK_DAYS * DAY)
    .sort((a, b) => at(a.due) - at(b.due))[0];
  if (soon) add(lineFor(P_STEP_FINISH_BY, locale, { title: titleOf(soon, locale), date: shortDate(soon.due, locale) }));
  const low = input.items
    .filter((i) => (scorePct(i) ?? 1) < GO_OVER_SCORE && i.submittedAt && now - at(i.submittedAt) <= 2 * WEEK_DAYS * DAY)
    .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""))[0];
  if (low) add(lineFor(P_STEP_GO_OVER, locale, { title: titleOf(low, locale) }));
  return steps;
}

export function weekBlock(child: SkChild, input: WeekInput, locale: string, now: number): Block {
  const name = child.firstName;
  const since = now - WEEK_DAYS * DAY;
  const done = input.items.filter((i) => isDoneStatus(i.status) && at(i.doneAt) >= since).length;
  const overdue = input.items.filter((i) => i.overdue).sort((a, b) => at(a.due) - at(b.due));
  const awaiting = input.items.filter((i) => i.awaitingMarking).length;
  const mastered = groupMastery(input.mastery ?? []).mastered.filter((r) => at(r.updatedAt) >= since).length;
  const notes = input.notes.filter((n) => at(n.createdAt) >= since).length;
  const overdueItems = overdue.length ? ` (${overdue.slice(0, 2).map((i) => lineFor(P_DUE_ON, locale, { title: titleOf(i, locale), date: shortDate(i.due, locale) })).join("; ")})` : "";
  const steps = nextSteps(input, locale, now);
  const summary = [
    lineFor(P_WEEK_LINE, locale, { name, done, overdue: overdue.length, overdueItems, awaiting, mastered, notes }),
    steps.length ? lineFor(P_WEEK_TODO, locale, { steps: steps.join("; ") }) : lineFor(P_WEEK_NOTHING, locale),
  ].join(" ");
  return {
    summary,
    facts: [{ child: name, doneThisWeek: done, overdue: overdue.length, awaitingMarking: awaiting, masteredThisWeek: mastered, newDiaryNotes: notes, nextSteps: steps.join("; ") || null }],
  };
}
