// The marking queue — `marking.next` (read) and `marking.grade` (confirm),
// S2 slice B (Final Plan 2026-10-28 §2.5, §4, §8.2, §9.2).
//
// "mark the next one from 7B", "next worksheet to mark", "what's left to mark"
// → marking.next: the OLDEST submission still awaiting a grade
// (`submissions.grade_status = 'pending'`, the analytics page's To-grade queue)
// on the teacher's OWN generations, optionally narrowed to a class, a learner
// or a kit, with how many remain. No write.
//
// "give it 7 out of 10, good work on part 2" → marking.grade: resolves the
// submission (the latest `submission` entity in the conversation, or asks),
// the score, what it is out of (the submission's own max when it has one, else
// what she says, else it asks) and her feedback, and returns a `confirm` card.
// The write happens only in /api/sk/act → act-marking.ts, AS THE TEACHER
// through the user-session client, with GradeList's own row
// (grade-update.ts buildGradeUpdate) and a `grade_status = 'pending'` guard.
//
// Reads go through the USER-SESSION client only (§2.3). RLS already limits
// submissions to the caller's generations for a plain teacher, but a school
// admin or coordinator can read more, so every row is re-checked in code
// against `generations.owner_id = me` — "own only" is a rule here, not a hope.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "@/sk/shell/types";
import { buildGradeUpdate, needsOutOf } from "@/app/dashboard/grade-update";
import { textMatches } from "@/utils/availability";
import { shareTitle } from "@/utils/assignment-status";
import { classEnrollments, teacherClasses } from "./shared";
import { pickClass } from "./assign";
import { pickLearner } from "./diary";
import { cleanQuery } from "./resolve";
import { lineFor } from "@/sk/shell/lines";
import { MARK_ALREADY_GRADED, MARK_CARD_TITLE, MARK_EMPTY, MARK_NEXT, MARK_NEXT_LAST, MARK_WHAT_OTHER, MARK_WHAT_TEST, MARK_WHAT_WORKSHEET } from "@/sk/shell/act-lines";

/** How many pending rows one queue read considers (oldest first). */
export const MARKING_SCAN = 200;
export const FEEDBACK_MAX = 2000;
const ANSWERS_MAX = 160;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;
const rows = <T = Row>(res: unknown, what: string): T[] => {
  const r = res as { data?: unknown; error?: { message?: string } | null } | null;
  if (!r) return [];
  if (r.error) throw new Error(`${what}: ${r.error.message ?? "query failed"}`);
  return (Array.isArray(r.data) ? r.data : []) as T[];
};
const argStr = (args: Record<string, unknown>, key: string, max = 120): string => (typeof args[key] === "string" ? (args[key] as string).trim().slice(0, max) : "");

export type SubmissionRow = {
  id: string;
  generation_id: string;
  student_id: string;
  mode: string;
  grade_status: string;
  auto_score: number | null;
  max_score: number | null;
  answers?: Record<string, unknown> | null;
  submitted_at: string;
};
type GenRow = { id: string; kind: string | null; title: string | null; chapter_ref: string | null; book_id: string | null; owner_id: string };
type BookRow = { id: string; title: string | null; chapters: Array<{ num?: number; title?: string | null }> | null };

export type MarkingItem = {
  id: string;
  generationId: string;
  studentId: string;
  learner: string;
  kitKind: string;
  kitTitle: string;
  /** "Ali's worksheet" in the teacher's language. */
  what: string;
  submittedAt: string;
  mode: string;
  autoScore: number | null;
  maxScore: number | null;
  answers: string;
  classIds: string[];
};

export const SUBMISSION_COLS = "id, generation_id, student_id, mode, grade_status, auto_score, max_score, answers, submitted_at";

/** "Ali's worksheet" / "Ali's test paper" / "Ali's work", localized. */
export function whatOf(kind: string | null | undefined, learner: string, locale: string): string {
  const table = kind === "worksheet" ? MARK_WHAT_WORKSHEET : kind === "exam_paper" ? MARK_WHAT_TEST : MARK_WHAT_OTHER;
  return lineFor(table, locale, { learner });
}

/** Sentence-initial capital for scripts that have one ("la fiche…" → "La fiche…"). */
export const capFirst = (s: string): string => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

/** The learner's OWN answers as one short line — never the questions, never the key. */
export function answersSummary(mode: string, answers: unknown): string {
  if (mode === "file") return "(uploaded a file)";
  if (!answers || typeof answers !== "object") return "(no answers)";
  const parts: string[] = [];
  for (const v of Object.values(answers as Record<string, unknown>)) {
    if (v == null || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(String(v).replace(/\s+/g, " ").trim());
    else if (Array.isArray(v)) parts.push(v.map((x) => String(x)).join(", "));
    else parts.push(Object.values(v as Record<string, unknown>).map((x) => String(x)).join(", "));
  }
  if (!parts.length) return "(no answers)";
  const s = parts.join("; ");
  return s.length > ANSWERS_MAX ? `${s.slice(0, ANSWERS_MAX - 1).trimEnd()}…` : s;
}

/** Kind words a teacher says for a kit kind, so "next worksheet to mark" or
 *  "the test papers" narrow the queue. */
const KIND_WORDS: Record<string, string[]> = {
  worksheet: ["worksheet", "worksheets", "lembaran kerja", "ورقة عمل"],
  exam_paper: ["test", "tests", "test paper", "test papers", "exam", "exams", "exam paper", "quiz", "ujian", "peperiksaan", "kuiz", "اختبار", "امتحان"],
  presentation: ["lesson", "lessons", "quiz", "pelajaran", "درس"],
};

export type MarkingFilter = { classId?: string; studentId?: string; kitQuery?: string; excludeIds?: string[] };

/**
 * The teacher's marking queue, oldest first: pending submissions on HER OWN
 * generations (checked in code), named from her class rosters, titled from
 * the kit (its title, else its book chapter's title, else "worksheet chapter N").
 */
export async function markingQueue(ctx: SkContext, deps: SkCapabilityDeps, filter: MarkingFilter = {}): Promise<MarkingItem[]> {
  const me = ctx.user.id;
  const locale = ctx.user.locale;
  const db = deps.session;
  const subs = rows<SubmissionRow>(
    await db.from("submissions").select(SUBMISSION_COLS).eq("grade_status", "pending").order("submitted_at", { ascending: true }).limit(MARKING_SCAN),
    "submissions",
  ).filter((s) => s.grade_status === "pending");
  if (!subs.length) return [];
  const genIds = [...new Set(subs.map((s) => s.generation_id))];
  const gens = rows<GenRow>(await db.from("generations").select("id, kind, title, chapter_ref, book_id, owner_id").eq("owner_id", me).in("id", genIds), "generations").filter((g) => g.owner_id === me);
  const genById = new Map(gens.map((g) => [g.id, g]));
  const own = subs.filter((s) => genById.has(s.generation_id));
  if (!own.length) return [];

  const classes = rows<Row>(await teacherClasses(deps, me), "classes").filter((c) => c.teacher_id === me);
  const classIds = classes.map((c) => c.id as string);
  const enr = classIds.length ? rows<{ class_id: string; student_id: string; profiles?: { full_name?: string | null; username?: string | null } | null }>(await classEnrollments(deps, me, classIds), "enrollments") : [];
  const mine = new Set(classIds);
  const nameOf = new Map<string, string>();
  const classesOf = new Map<string, string[]>();
  for (const e of enr) {
    if (!mine.has(e.class_id)) continue;
    nameOf.set(e.student_id, (e.profiles?.full_name || e.profiles?.username || "Student").trim());
    classesOf.set(e.student_id, [...(classesOf.get(e.student_id) ?? []), e.class_id]);
  }

  const bookIds = [...new Set(gens.map((g) => g.book_id).filter((b): b is string => !!b))];
  const books = bookIds.length ? rows<BookRow>(await db.from("books").select("id, title, chapters").in("id", bookIds), "books") : [];
  const bookById = new Map(books.map((b) => [b.id, b]));
  const titleOf = (g: GenRow): string => {
    if (g.title) return g.title;
    const b = g.book_id ? bookById.get(g.book_id) : undefined;
    const n = g.chapter_ref != null && g.chapter_ref !== "" ? Number(g.chapter_ref) : NaN;
    const ch = b && !Number.isNaN(n) ? (b.chapters ?? []).find((c) => c?.num === n)?.title : null;
    return ch || shareTitle({ kind: g.kind ?? "item", chapter_ref: g.chapter_ref, title: null });
  };

  const exclude = new Set(filter.excludeIds ?? []);
  const items = own
    .filter((s) => !exclude.has(s.id))
    .map<MarkingItem>((s) => {
      const g = genById.get(s.generation_id)!;
      const learner = nameOf.get(s.student_id) ?? "Student";
      return {
        id: s.id,
        generationId: s.generation_id,
        studentId: s.student_id,
        learner,
        kitKind: g.kind ?? "item",
        kitTitle: titleOf(g),
        what: whatOf(g.kind, learner, locale),
        submittedAt: s.submitted_at,
        mode: s.mode,
        autoScore: s.auto_score,
        maxScore: s.max_score,
        answers: answersSummary(s.mode, s.answers),
        classIds: classesOf.get(s.student_id) ?? [],
      };
    })
    .filter((i) => !filter.classId || i.classIds.includes(filter.classId))
    .filter((i) => !filter.studentId || i.studentId === filter.studentId)
    .filter((i) => !filter.kitQuery || textMatches(filter.kitQuery, [i.kitTitle, i.kitKind, ...(KIND_WORDS[i.kitKind] ?? [])]));
  // Oldest first, whatever order the rows arrived in (ties by id: stable).
  return items.sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || a.id.localeCompare(b.id));
}

export const submissionEntity = (i: MarkingItem, via: string): ResolvedEntity => ({
  kind: "submission",
  id: i.id,
  label: `${capFirst(i.what)} — ${i.kitTitle}`,
  via,
  ids: [i.generationId, i.studentId],
});

/** The one line SK says about the head of the queue. */
export function nextLine(head: MarkingItem, remainingAfter: number, locale: string): string {
  const what = capFirst(head.what);
  return remainingAfter > 0 ? lineFor(MARK_NEXT, locale, { what, kit: head.kitTitle, n: remainingAfter }) : lineFor(MARK_NEXT_LAST, locale, { what, kit: head.kitTitle });
}

const which = (what: string, names: string[]) => `Which ${what}: ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}?`;

// ── marking.next ─────────────────────────────────────────────────────────────

export async function resolveMarkingNext(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const locale = ctx.user.locale;
  const filter: MarkingFilter = {};
  const narrowed: Record<string, string> = {};
  try {
    const classId = argStr(args, "classId");
    const classQuery = cleanQuery(args.classQuery);
    if (classId || classQuery) {
      const c = await pickClass(ctx, deps, classId, classQuery);
      if (c.kind === "none") return { ok: false, summary: `I can't find a class called "${c.query}" among yours.`, error: "class_not_found", facts: [] };
      if (c.kind === "many") {
        return {
          ok: true,
          summary: which("class", c.options.map((o) => o.name)),
          facts: c.options.map((o) => ({ kind: "class", id: o.id, name: o.name })),
          entities: c.options.map<ResolvedEntity>((o) => ({ kind: "class", id: o.id, label: o.name, via: "marking.next" })),
        };
      }
      filter.classId = c.id;
      narrowed.class = c.name;
    }
    const learnerId = argStr(args, "learnerId");
    const learnerQuery = cleanQuery(args.learnerQuery);
    if (learnerId || learnerQuery) {
      const l = await pickLearner(ctx, deps, learnerId, learnerQuery);
      if (l.kind === "none") return { ok: false, summary: `I can't find a learner called "${l.query}" in your classes.`, error: "learner_not_found", facts: [] };
      if (l.kind === "many") {
        return {
          ok: true,
          summary: which("learner", l.options.map((o) => o.name)),
          facts: l.options.map((o) => ({ kind: "learner", id: o.id, name: o.name })),
          entities: l.options.map<ResolvedEntity>((o) => ({ kind: "learner", id: o.id, label: o.name, via: "marking.next" })),
        };
      }
      filter.studentId = l.id;
      narrowed.learner = l.name;
    }
    const kitQuery = argStr(args, "kitQuery", 80);
    if (kitQuery) {
      filter.kitQuery = kitQuery;
      narrowed.kit = kitQuery;
    }
    const skip = argStr(args, "skipId");
    if (UUID_RE.test(skip)) filter.excludeIds = [skip];

    const queue = await markingQueue(ctx, deps, filter);
    if (!queue.length) {
      const where = Object.values(narrowed).join(", ");
      return {
        ok: true,
        summary: lineFor(MARK_EMPTY, locale) + (where ? ` (${where})` : ""),
        facts: [{ kind: "marking.queue", remaining: 0, ...narrowed }],
        entities: [],
      };
    }
    const head = queue[0];
    const after = queue.length - 1;
    return {
      ok: true,
      summary: nextLine(head, after, locale),
      facts: [
        {
          kind: "submission",
          id: head.id,
          learner: head.learner,
          kit: head.kitTitle,
          kit_kind: head.kitKind,
          submitted_at: head.submittedAt,
          answers: head.answers,
          auto_score: head.autoScore,
          max_score: head.maxScore,
          remaining_after: after,
        },
      ],
      entities: [submissionEntity(head, "marking.next")],
    };
  } catch (e) {
    return { ok: false, summary: "I could not read your marking right now.", error: e instanceof Error ? e.message : String(e), facts: [] };
  }
}

export const markingNext: SkCapability = {
  meta: {
    name: "marking.next",
    description:
      "The teacher's marking queue: the OLDEST submission still waiting for her grade on her own kits, with the learner's own answers (short) and how many remain. Use for 'mark the next one', 'next to mark', 'what's left to mark', 'next worksheet to mark from 7B', 'tanda yang seterusnya', 'التالي للتصحيح'. Narrow with classQuery, learnerQuery or kitQuery only when she says so. skipId = a submission to pass over ('skip this one'). Read only — grading is marking.grade.",
    parameters: {
      type: "object",
      properties: {
        classQuery: { type: "string", description: "Only learners of this class, e.g. '7B'." },
        classId: { type: "string", description: "A class id already resolved this conversation." },
        learnerQuery: { type: "string", description: "Only this learner, e.g. 'Ali'." },
        learnerId: { type: "string", description: "A learner id already resolved this conversation." },
        kitQuery: { type: "string", description: "Only this kit or kind: a title, 'worksheet', 'test'." },
        skipId: { type: "string", description: "A submission id to skip." },
      },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher"],
    hats: ["teacher"],
  },
  handler: resolveMarkingNext,
};

// ── marking.grade ────────────────────────────────────────────────────────────

/** The submission an instruction refers to: an explicit id, else the most
 *  recent `submission` entity in the conversation ("give it 7 out of 10"). */
export function submissionIdFor(ctx: SkContext, args: Record<string, unknown>): string | null {
  const v = argStr(args, "submissionId");
  if (UUID_RE.test(v)) return v;
  const recent = ctx.recent.entities.find((e) => e.kind === "submission" && UUID_RE.test(e.id));
  return recent ? recent.id : null;
}

/** "7", 7, "7.5" → a number; anything else → null. */
export function numberArg(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

export async function resolveMarkingGrade(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const me = ctx.user.id;
  const locale = ctx.user.locale;
  const id = submissionIdFor(ctx, args);
  if (!id) return { ok: false, summary: "Which one? Say “next to mark” first and I'll bring up the oldest.", error: "submission required", facts: [] };
  const score = numberArg(args.score);
  if (score === null) return { ok: false, summary: "What score should it get?", error: "score required", facts: [] };
  const saidOutOf = args.outOf === undefined || args.outOf === null || args.outOf === "" ? null : numberArg(args.outOf);
  if (args.outOf !== undefined && args.outOf !== null && args.outOf !== "" && saidOutOf === null) return { ok: false, summary: "What is it marked out of?", error: "out_of_unparsed", facts: [] };
  const feedback = typeof args.feedback === "string" ? args.feedback.replace(/\r\n/g, "\n").trim() : "";
  if (feedback.length > FEEDBACK_MAX) return { ok: false, summary: `That feedback is too long — keep it under ${FEEDBACK_MAX} characters.`, error: "feedback_too_long", facts: [] };

  try {
    const sub = rows<SubmissionRow>(await deps.session.from("submissions").select(SUBMISSION_COLS).eq("id", id), "submissions").find((s) => s.id === id);
    const gen = sub
      ? rows<GenRow>(await deps.session.from("generations").select("id, kind, title, chapter_ref, book_id, owner_id").eq("id", sub.generation_id).eq("owner_id", me), "generations").find((g) => g.id === sub.generation_id && g.owner_id === me)
      : undefined;
    if (!sub || !gen) return { ok: false, summary: "I can't find that submission among your kits.", error: "submission_not_found", facts: [] };
    if (sub.grade_status !== "pending") return { ok: false, summary: lineFor(MARK_ALREADY_GRADED, locale), error: "already_graded", facts: [{ kind: "submission", id, grade_status: sub.grade_status }] };

    // What it is out of: the submission's own max when it has one (an
    // interactive quiz's auto-scorer total — never overwritten), else hers.
    const target = { mode: sub.mode, max: sub.max_score };
    const ask = needsOutOf(target);
    if (!ask && saidOutOf !== null && saidOutOf !== sub.max_score) {
      return { ok: false, summary: `That one is marked out of ${sub.max_score} — give the score out of ${sub.max_score}.`, error: "out_of_mismatch", facts: [] };
    }
    if (ask && saidOutOf === null) return { ok: false, summary: "What is it marked out of?", error: "out_of required", facts: [] };
    const outOf = ask ? (saidOutOf as number) : (sub.max_score as number);
    // max_score is an integer column: an "out of" that is not a whole number cannot be stored.
    if (!Number.isInteger(outOf) || outOf <= 0) return { ok: false, summary: "“Out of” must be a whole number more than 0.", error: "bad_out_of", facts: [] };
    const check = buildGradeUpdate(target, { score: String(score), outOf: String(outOf), feedback }, me, deps.now);
    if (!check.ok) return { ok: false, summary: check.error, error: "bad_score", facts: [] };

    // Names, from her own rosters (the queue's read).
    const queue = await markingQueue(ctx, deps, {});
    const item = queue.find((q) => q.id === id);
    const learner = item?.learner ?? "Student";
    const kitTitle = item?.kitTitle ?? (gen.title || shareTitle({ kind: gen.kind ?? "item", chapter_ref: gen.chapter_ref, title: null }));
    const what = whatOf(gen.kind, learner, locale);
    const title = lineFor(MARK_CARD_TITLE, locale, { what });
    return {
      ok: true,
      summary: `${title}: ${score}/${outOf}${feedback ? `, feedback "${feedback}"` : ""}. Nothing is saved until the teacher confirms.`.slice(0, 600),
      facts: [{ kind: "marking.grade", learner, kit: kitTitle, score, out_of: outOf, feedback: feedback || null }],
      entities: [{ kind: "submission", id, label: `${capFirst(what)} — ${kitTitle}`, via: "marking.grade", ids: [sub.generation_id, sub.student_id] }],
      confirm: {
        action: "marking.grade",
        title,
        params: { submission_id: id, score, out_of: outOf, feedback: feedback || null, learner_label: learner, kit_title: kitTitle },
      },
    };
  } catch (e) {
    return { ok: false, summary: "I could not read that submission right now.", error: e instanceof Error ? e.message : String(e), facts: [] };
  }
}

export const markingGrade: SkCapability = {
  meta: {
    name: "marking.grade",
    description:
      "Grade ONE submission on the teacher's own kit: a score, what it is out of, and her feedback. Returns a confirmation card — nothing is saved until she confirms. Use after marking.next: 'give it 7 out of 10, good work on part 2', 'beri 8/10', 'أعطه 7 من 10'. submissionId: omit to grade the one most recently brought up. score = her number; outOf only when she says it (the submission's own total is used when it has one). feedback = her own words for the learner: fix grammar if needed, never add praise or criticism she did not say.",
    parameters: {
      type: "object",
      properties: {
        submissionId: { type: "string", description: "A submission id from marking.next; omit for the latest." },
        score: { type: "number", description: "The score she gave." },
        outOf: { type: "number", description: "What it is marked out of, when she says it." },
        feedback: { type: "string", description: "Her feedback for the learner, in her words." },
      },
      required: ["score"],
      additionalProperties: false,
    },
    tier: "confirm",
    kind: "act",
    roles: ["teacher"],
    hats: ["teacher"],
  },
  handler: resolveMarkingGrade,
};
