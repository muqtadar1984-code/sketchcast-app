// `diary.note` — a class (or one learner's) diary note, SK's second
// confirm-tier action (S2 slice A; Final Plan 2026-10-28 §2.5, §4, §8.2, §9.2).
//
// "post a notice to 7B: no school on Friday", "tell 7B to bring their atlas",
// "write in Ali's diary that he did well today", "tulis dalam diari 7B …",
// "اكتب في مذكرة 7B …".
//
// This handler RESOLVES, it never writes. It turns the teacher's words into a
// fully resolved note — her own class (or a learner in her own classes), the
// note type, the exact text, parents-only or not, the KL day it is filed
// under — and returns a `confirm` card that shows the EXACT text. The write
// happens only in /api/sk/act → act-diary.ts, AS THE TEACHER through the
// user-session client, so 0066's `dn_insert` RLS decides standing.
//
// Reads go through the USER-SESSION client only (§2.3) and reuse the resolve /
// assign helpers: a row that is not the caller's never becomes a parameter.
// Ambiguity asks; nothing is guessed. One target per note: several classes is
// `notice.multi_class` (click-only, not built here).
//
// Days: the diary's FIXED civil zone (Malaysia, UTC+8, no DST) — the convention
// every diary surface reads by (src/app/api/diary/notes/route.ts). "today" /
// "hari ini" / "اليوم", "tomorrow" / "esok" / "غدا", "day after tomorrow" /
// "lusa", a weekday = its next occurrence 0–6 days ahead (today counts — a note
// "for Friday" said on Friday is today's), "next <day>" / "<day> depan" = that
// weekday of next calendar week, or ISO YYYY-MM-DD. No day said → today.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkChild, SkContext } from "@/sk/shell/types";
import { cleanQuery, normalizeName, resolveEntities } from "./resolve";
import { classEnrollments, teacherClasses } from "./shared";
import { pickClass } from "./assign";
import { lineFor } from "@/sk/shell/lines";
import { DIARY_CARD_TITLE } from "@/sk/shell/act-lines";
import { resolveChild } from "./child-scope";
import {
  P_DIARY_CARD_TITLE,
  P_DIARY_NO_CLASS,
  P_DIARY_SEEN_HOME,
  P_DIARY_SEEN_HOME_PRIVATE,
  P_DIARY_SEEN_LEADERS,
  P_DIARY_SEEN_LEADERS_PRIVATE,
  P_DIARY_SEEN_SCHOOL,
  P_DIARY_SEEN_SCHOOL_PRIVATE,
  P_DIARY_SEEN_TEACHER,
  P_DIARY_SEEN_TEACHER_PRIVATE,
  P_DIARY_UNVERIFIED,
  P_NO_CHILDREN,
  P_NOT_LINKED,
  P_WHICH_CHILD,
} from "@/sk/shell/parent-lines";

export const DIARY_NOTE_TYPES = ["homework", "reminder", "praise", "concern", "health", "general"] as const;
export type DiaryNoteType = (typeof DIARY_NOTE_TYPES)[number];
export const DIARY_BODY_MAX = 4000;
/** The diary's fixed civil zone (UTC+8), minutes. */
export const DIARY_OFFSET_MINUTES = 8 * 60;

// ── Days (pure) ──────────────────────────────────────────────────────────────

/** YYYY-MM-DD of the KL civil day `plusDays` from now. */
export function diaryDayKey(now: Date, plusDays = 0): string {
  const s = new Date(now.getTime() + DIARY_OFFSET_MINUTES * 60_000);
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + plusDays)).toISOString().slice(0, 10);
}

/** Is this a real calendar day? (the diary route's own round-trip check) */
export function isRealDay(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// `\b` is ASCII-only, so Arabic words get letter-class boundaries.
const W = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "u");
const WEEKDAYS: Array<[number, RegExp]> = [
  [1, W("monday|mon|isnin|الاثنين|الإثنين")],
  [2, W("tuesday|tue|tues|selasa|الثلاثاء")],
  [3, W("wednesday|wed|rabu|الأربعاء|الاربعاء")],
  [4, W("thursday|thu|thur|thurs|khamis|الخميس")],
  [5, W("friday|fri|jumaat|الجمعة")],
  [6, W("saturday|sat|sabtu|السبت")],
  [0, W("sunday|sun|ahad|الأحد|الاحد")],
];
const NEXT_RE = W("next|depan|القادم|القادمة");
const TODAY_RE = W("today|tonight|hari ini|malam ini|اليوم|الليلة");
const DAY_AFTER_RE = W("day after tomorrow|lusa|بعد غد|بعد غدا");
const TOMORROW_RE = W("tomorrow|esok|besok|غدا|غداً|بكرة");

export type EntryDateParse = { ok: true; date: string } | { ok: false };

/** null = no day given (→ today). Never guesses: unknown words → { ok: false }. */
export function parseEntryDate(text: string | null | undefined, now: Date): EntryDateParse | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/\s+/g, " ");
  const iso = t.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return isRealDay(iso[1]) ? { ok: true, date: iso[1] } : { ok: false };
  if (DAY_AFTER_RE.test(t)) return { ok: true, date: diaryDayKey(now, 2) };
  if (TOMORROW_RE.test(t)) return { ok: true, date: diaryDayKey(now, 1) };
  if (TODAY_RE.test(t)) return { ok: true, date: diaryDayKey(now, 0) };
  const wd = WEEKDAYS.find(([, re]) => re.test(t));
  if (!wd) return { ok: false };
  const today = new Date(now.getTime() + DIARY_OFFSET_MINUTES * 60_000).getUTCDay();
  let delta = (wd[0] - today + 7) % 7; // today counts
  if (NEXT_RE.test(t)) {
    const toNextMonday = (1 - today + 7) % 7 || 7;
    delta = toNextMonday + ((wd[0] - 1 + 7) % 7);
  }
  return { ok: true, date: diaryDayKey(now, delta) };
}

// ── Learner pick (own classes only) ──────────────────────────────────────────

type Row = Record<string, unknown>;
const rowsOf = async (q: unknown): Promise<Row[]> => {
  try {
    const r = (await q) as { data?: unknown } | null;
    return Array.isArray(r?.data) ? (r!.data as Row[]) : [];
  } catch {
    return [];
  }
};
const argStr = (args: Record<string, unknown>, key: string, max = 120): string => (typeof args[key] === "string" ? (args[key] as string).trim().slice(0, max) : "");

export type LearnerPick = { kind: "none"; query: string } | { kind: "one"; id: string; name: string } | { kind: "many"; options: Array<{ id: string; name: string }> };

export async function pickLearner(ctx: SkContext, deps: SkCapabilityDeps, learnerId: string, learnerQuery: string): Promise<LearnerPick> {
  const me = ctx.user.id;
  if (learnerId) {
    const own = (await rowsOf(teacherClasses(deps, me))).filter((c) => c.teacher_id === me);
    const ids = new Set(own.map((c) => c.id as string));
    if (!ids.size) return { kind: "none", query: learnerId };
    const enr = await rowsOf(classEnrollments(deps, me, [...ids]));
    const e = enr.find((r) => r.student_id === learnerId && ids.has(r.class_id as string));
    if (!e) return { kind: "none", query: learnerId };
    const p = (e.profiles ?? null) as { full_name?: string | null; username?: string | null } | null;
    return { kind: "one", id: learnerId, name: (p?.full_name || p?.username || "Student").trim() };
  }
  const r = await resolveEntities(ctx, { query: learnerQuery, kind: "learner" }, deps);
  const learners = (r.entities ?? []).filter((e) => e.kind === "learner");
  if (!learners.length) return { kind: "none", query: learnerQuery };
  if (learners.length === 1) return { kind: "one", id: learners[0].id, name: learners[0].label };
  const exact = learners.filter((l) => normalizeName(l.label) === normalizeName(learnerQuery));
  if (exact.length === 1) return { kind: "one", id: exact[0].id, name: exact[0].label };
  return { kind: "many", options: learners.slice(0, 6).map((l) => ({ id: l.id, name: l.label })) };
}

const which = (what: string, names: string[]) => `Which ${what}: ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}?`;

// ── Resolution ───────────────────────────────────────────────────────────────

type NoteBasics = { ok: true; body: string; parentsOnly: boolean; entryDate: string } | { ok: false; result: SkCapabilityResult };

/** The body, parents-only flag and day — the same checks for every writer. */
function noteBasics(args: Record<string, unknown>, deps: SkCapabilityDeps): NoteBasics {
  const body = typeof args.body === "string" ? args.body.replace(/\r\n/g, "\n").trim() : "";
  if (!body) return { ok: false, result: { ok: false, summary: "What should the note say?", error: "body required", facts: [] } };
  if (body.length > DIARY_BODY_MAX) return { ok: false, result: { ok: false, summary: `That note is too long — the diary takes up to ${DIARY_BODY_MAX} characters.`, error: "body_too_long", facts: [] } };
  const parentsOnly = args.parentsOnly === true;
  const day = argStr(args, "entryDate", 60);
  const parsed = parseEntryDate(day, deps.now);
  if (parsed && !parsed.ok) {
    return { ok: false, result: { ok: false, summary: `I didn't catch the day "${day}" — say today, tomorrow, a weekday, or 2026-11-03.`, error: "date_unparsed", facts: [] } };
  }
  return { ok: true, body, parentsOnly, entryDate: parsed?.ok ? parsed.date : diaryDayKey(deps.now) };
}

export async function resolveDiaryNote(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  if (isParentWriter(ctx)) return resolveParentDiaryNote(ctx, args, deps);
  const basics = noteBasics(args, deps);
  if (!basics.ok) return basics.result;
  const { body, parentsOnly, entryDate } = basics;
  const noteType: DiaryNoteType = DIARY_NOTE_TYPES.find((t) => t === args.type) ?? "general";

  const learnerId = argStr(args, "learnerId");
  const learnerQuery = cleanQuery(args.learnerQuery);
  let classId = argStr(args, "classId");
  const classQuery = cleanQuery(args.classQuery);

  let target: { kind: "class" | "learner"; id: string; label: string } | null = null;
  if (learnerId || learnerQuery) {
    const l = await pickLearner(ctx, deps, learnerId, learnerQuery);
    if (l.kind === "none") return { ok: false, summary: `I can't find a learner called "${l.query}" in your classes.`, error: "learner_not_found", facts: [] };
    if (l.kind === "many") {
      return {
        ok: true,
        summary: which("learner", l.options.map((o) => o.name)),
        facts: l.options.map((o) => ({ kind: "learner", id: o.id, name: o.name })),
        entities: l.options.map<ResolvedEntity>((o) => ({ kind: "learner", id: o.id, label: o.name, via: "diary.note" })),
      };
    }
    target = { kind: "learner", id: l.id, label: l.name };
  } else {
    if (!classId && !classQuery) classId = ctx.selection.classId ?? "";
    if (!classId && !classQuery) return { ok: false, summary: "Which class — or which learner — is the note for?", error: "target required", facts: [] };
    const c = await pickClass(ctx, deps, classId, classQuery);
    if (c.kind === "none") return { ok: false, summary: `I can't find a class called "${c.query}" among yours.`, error: "class_not_found", facts: [] };
    if (c.kind === "many") {
      return {
        ok: true,
        summary: which("class", c.options.map((o) => o.name)),
        facts: c.options.map((o) => ({ kind: "class", id: o.id, name: o.name })),
        entities: c.options.map<ResolvedEntity>((o) => ({ kind: "class", id: o.id, label: o.name, via: "diary.note" })),
      };
    }
    target = { kind: "class", id: c.id, label: c.name };
  }

  const title = lineFor(DIARY_CARD_TITLE, ctx.user.locale, { target: target.label });
  const params: Record<string, string | number | boolean | null> = {
    ...(target.kind === "class" ? { class_id: target.id } : { student_id: target.id }),
    note_type: noteType,
    body,
    parents_only: parentsOnly,
    entry_date: entryDate,
    target_label: target.label,
  };
  return {
    ok: true,
    summary: `${title}: "${body}" (${noteType}${parentsOnly ? ", parents only" : ""}, ${entryDate}). Nothing is posted until the teacher confirms.`.slice(0, 600),
    facts: [{ kind: "diary.note", target: target.label, note_type: noteType, body, parents_only: parentsOnly, entry_date: entryDate }],
    entities: [{ kind: target.kind, id: target.id, label: target.label, via: "diary.note" }],
    confirm: { action: "diary.note", title, params },
  };
}

// ── S4 slice C: the parent branch ──────────────────────────────────────────
//
// A parent (role parent, or an adult wearing the parent hat) writes to ONE of
// her own VERIFIED children's diary — never a class (0066 dn_insert: a
// student_id she is_parent_of; POST /api/diary/notes refuses a parent's
// classId too). The child comes from ctx.children ONLY (resolveChild): an id or
// name that is not one of hers is refused, an unverified link is refused, and
// two children with none named asks. Nothing is read about a child before that.
//
// The card says WHO WILL SEE the note, from 0066's dn_read: the child's
// teachers (diary_teacher_of → teaches_student: a class she is enrolled in),
// the school's leaders (diary_leader_of: her school's admin / coordinators),
// and the child herself unless parents_only (diary_student_target … and not
// parents_only). parents_only hides the note from the CHILD only — never from
// the teacher. A home learner (no school, no class) has neither teacher nor
// leaders: the note is the parent's own record, and the child's.
//
// The write is S2's executor, unchanged (act-diary.ts runDiaryNote: student_id
// only, session client, sk_action_id); act-diary.ts runDiaryNoteChecked
// re-checks the child against the live ctx.children BEFORE the token is consumed.

/** The note types a parent may file (homework is the teacher's word). */
export const PARENT_NOTE_TYPES = ["health", "concern", "general", "reminder", "praise"] as const;

/** Is this request the parent writing (the parent role, or the parent hat)? */
export function isParentWriter(ctx: SkContext): boolean {
  return ctx.user.role === "parent" || ctx.user.hat === "parent";
}

export type DiaryAudience = "school" | "teacher" | "leaders" | "home";

/** Who reads a parent's note about this child (0066 dn_read). Pure. */
export function diaryAudience(child: Pick<SkChild, "schoolId">, hasTeacher: boolean): DiaryAudience {
  if (hasTeacher) return child.schoolId ? "school" : "teacher";
  return child.schoolId ? "leaders" : "home";
}

const SEEN_BY: Record<DiaryAudience, [Record<string, string>, Record<string, string>]> = {
  school: [P_DIARY_SEEN_SCHOOL, P_DIARY_SEEN_SCHOOL_PRIVATE],
  teacher: [P_DIARY_SEEN_TEACHER, P_DIARY_SEEN_TEACHER_PRIVATE],
  leaders: [P_DIARY_SEEN_LEADERS, P_DIARY_SEEN_LEADERS_PRIVATE],
  home: [P_DIARY_SEEN_HOME, P_DIARY_SEEN_HOME_PRIVATE],
};

/** The card's "who sees it" line. Pure. */
export function seenByLine(child: Pick<SkChild, "firstName">, audience: DiaryAudience, parentsOnly: boolean, locale: string): string {
  return lineFor(SEEN_BY[audience][parentsOnly ? 1 : 0], locale, { name: child.firstName });
}

/** Is the child in any class (so a teacher reads her diary)? Session read, cut
 *  to this child in code. A failed read falls back to the school link. */
async function childHasTeacher(deps: SkCapabilityDeps, child: SkChild): Promise<boolean> {
  try {
    const r = (await deps.session.from("enrollments").select("class_id, student_id").eq("student_id", child.id)) as { data?: unknown; error?: unknown } | null;
    if (!r || r.error || !Array.isArray(r.data)) return !!child.schoolId;
    return (r.data as Row[]).some((e) => e.student_id === child.id && typeof e.class_id === "string" && !!e.class_id);
  } catch {
    return !!child.schoolId;
  }
}

export async function resolveParentDiaryNote(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const locale = ctx.user.locale;
  // A class is never a parent's target — refused before anything is read.
  if (argStr(args, "classId") || cleanQuery(args.classQuery)) return { ok: false, summary: lineFor(P_DIARY_NO_CLASS, locale), error: "class_not_allowed", facts: [] };
  const basics = noteBasics(args, deps);
  if (!basics.ok) return basics.result;
  const { body, parentsOnly, entryDate } = basics;
  const noteType: DiaryNoteType = PARENT_NOTE_TYPES.find((t) => t === args.type) ?? "general";

  const scope = resolveChild(ctx, argStr(args, "child") || argStr(args, "learnerId") || cleanQuery(args.learnerQuery));
  if (scope.kind === "refused") return { ok: false, summary: lineFor(scope.reason === "no_children" ? P_NO_CHILDREN : P_NOT_LINKED, locale), error: scope.reason, facts: [] };
  if (scope.kind === "unverified") return { ok: false, summary: lineFor(P_DIARY_UNVERIFIED, locale, { name: scope.child.firstName }), error: "unverified", facts: [] };
  const options = scope.kind === "ask" ? scope.candidates : scope.children;
  if (options.length !== 1) {
    // Two children and none named (or a name both share): ask — one note, one child.
    return {
      ok: true,
      summary: lineFor(P_WHICH_CHILD, locale, { names: options.map((c) => c.firstName).join(", ") }),
      facts: options.map((c) => ({ kind: "learner", id: c.id, name: c.name })),
      entities: options.map<ResolvedEntity>((c) => ({ kind: "learner", id: c.id, label: c.name, via: "diary.note" })),
    };
  }
  const child = options[0];

  const seenBy = seenByLine(child, diaryAudience(child, await childHasTeacher(deps, child)), parentsOnly, locale);
  const title = lineFor(P_DIARY_CARD_TITLE, locale, { name: child.firstName });
  const params: Record<string, string | number | boolean | null> = {
    student_id: child.id,
    note_type: noteType,
    body,
    parents_only: parentsOnly,
    entry_date: entryDate,
    target_label: child.name,
    seen_by: seenBy,
  };
  return {
    ok: true,
    summary: `${title}: "${body}" (${noteType}, ${entryDate}). ${seenBy} Nothing is written until you confirm.`.slice(0, 600),
    facts: [{ kind: "diary.note", target: child.name, note_type: noteType, body, parents_only: parentsOnly, entry_date: entryDate, seen_by: seenBy }],
    entities: [{ kind: "learner", id: child.id, label: child.name, via: "diary.note" }],
    confirm: { action: "diary.note", title, params },
  };
}

export const diaryNoteAction: SkCapability = {
  meta: {
    name: "diary.note",
    description:
      "Post a note to the diary of ONE of the teacher's own classes (class-wide) or ONE learner in her classes (personal). Returns a confirmation card showing the exact text — nothing is posted until the teacher confirms. Use for 'post a notice to 7B: …', 'tell 7B …', 'add to the diary for 7B: …', 'write in Ali's diary …', 'tulis dalam diari 7B …', 'maklumkan kepada 7B …', 'اكتب في مذكرة 7B …'. body = the teacher's own words: you may fix grammar and spelling, never add facts, dates or names she did not say. type: homework / reminder / praise / concern / health when she says so, else general. parentsOnly: true only when she says it is for the parents ('tell 7B's parents …', 'to the parents'). entryDate in her words (today, tomorrow, Friday, 2026-11-03); omit for today. Several classes at once is not this tool — one class at a time. If more than one class or learner matches, the result asks which — pass the answer back, never guess. " +
      "A PARENT uses it to write in ONE of her own children's diary (never a class): 'tell Aisyah's teacher she was sick yesterday', 'write in Adam's diary …', 'tulis dalam diari Aisyah …', 'beritahu cikgu Adam …', 'اكتب في مذكرة آدم …'. Pass child = the child's name (omit it with one child; with two, the result asks which). body = the parent's own words, grammar tidied only — never a fact, date or name she did not say. type: health / concern / reminder / praise when she says so, else general. parentsOnly: true only when she says it is just for the teacher, not the child ('don't let Aisyah see', 'jangan tunjuk kepada Aisyah'). The card says who will see it.",
    parameters: {
      type: "object",
      properties: {
        classQuery: { type: "string", description: "The class as the teacher said it, e.g. '7B'." },
        classId: { type: "string", description: "A class id already resolved this conversation." },
        learnerQuery: { type: "string", description: "The learner's name for a personal note, e.g. 'Ali'." },
        learnerId: { type: "string", description: "A learner id already resolved this conversation." },
        child: { type: "string", description: "Parents only: the child's name (or id) — one of the parent's own children." },
        body: { type: "string", description: "The note text: the teacher's words (grammar may be tidied, no facts added)." },
        type: { type: "string", enum: [...DIARY_NOTE_TYPES], description: "Note type; default general." },
        parentsOnly: { type: "boolean", description: "True only when the note is for the parents (hidden from students)." },
        entryDate: { type: "string", description: "The day in the teacher's words; omit for today." },
      },
      required: ["body"],
      additionalProperties: false,
    },
    tier: "confirm",
    kind: "act",
    // S4 slice C: parents too (the parent branch above); an adult wearing the
    // parent hat writes as a parent. /api/sk/act re-checks this meta.
    roles: ["teacher", "parent"],
    hats: ["teacher", "parent"],
    flags: ["diary"],
  },
  handler: resolveDiaryNote,
};
