// `notice.school` — a school-wide or all-staff notice, SK's first LEADER
// action (S5 slice D; Final Plan 2026-10-28 §2.5, §4, §8.2, §9.2; SK S5
// design 2026-10-29 decisions 3 and 4).
//
// "post a notice to the whole school: …", "tell all staff …", "send a school
// notice …", "hantar notis kepada semua …", "maklumkan kepada semua guru …",
// "أرسل إشعارًا للمدرسة …".
//
// This handler RESOLVES, it never writes. It turns the leader's words into a
// fully resolved notice — the audience (school, or staff when she says staff /
// teachers / guru), a short title (hers, or the body's first line), the EXACT
// body, the school day it starts — and returns a CLICK-ONLY `confirm` card
// (§9.2: school-wide or multi-class notices are never confirmed by voice). The
// card says who will see it, worded from 0068's se_read. The write happens only
// in /api/sk/act → act-notice.ts, AS THE LEADER through the user-session client,
// with the row built by the same builder as POST /api/notices
// (utils/notice-row.ts), so se_admin_write / se_coordinator_write decide.
//
// Who: the principal (school_admin) or a coordinator (a scope grant in this
// school — a grant, not a role; effectiveRoles adds "coordinator"), wearing the
// principal or coordinator hat. Coordinators publish to school or staff, as the
// app allows today: a scope-limited (grade) notice has no audience to land in
// (design decision 4), and a class notice is the teacher's diary.note.
//
// Gate: the registry's `notices` flag (ctx.flags.notices = noticesEnabledFor —
// FEATURE_NOTICES AND the school's calendar gate, exactly what POST
// /api/notices applies); FEATURE_NOTICES is read again here and at execution.

import type { SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "@/sk/shell/types";
import { lineFor } from "@/sk/shell/lines";
import {
  NOTICE_CARD_TITLE_SCHOOL,
  NOTICE_CARD_TITLE_STAFF,
  NOTICE_DATE_PASSED,
  NOTICE_DATE_UNPARSED,
  NOTICE_NO_STANDING,
  NOTICE_NOT_UNTIL,
  NOTICE_OFF,
  NOTICE_SEEN_SCHOOL,
  NOTICE_SEEN_STAFF,
  NOTICE_TOO_LONG,
  NOTICE_WHAT_TO_SAY,
  NOTICE_YOUR_SCHOOL,
} from "@/sk/shell/act-notice-lines";
import { NOTICE_BODY_MAX, NOTICE_TITLE_MAX, schoolDayInstant, validateNotice, type NoticeAudience } from "@/utils/notice-row";
import { diaryDayKey, parseEntryDate } from "./diary";

/** The title SK derives when none was said: the body's first line, first sentence, ≤ 60 chars. */
export const NOTICE_TITLE_DERIVED_MAX = 60;

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Is the env half of the notices gate on (noticesEnabledFor's migration gate)? */
export function noticesOn(): boolean {
  return process.env.FEATURE_NOTICES === "true";
}

/** May this user post a school notice? The principal, or a coordinator of THIS
 *  school, wearing a leader hat (or hats off). Pure; RLS decides again at the write. */
export function noticeStanding(ctx: SkContext): boolean {
  if (!ctx.user.schoolId) return false;
  if (ctx.user.hat && ctx.user.hat !== "principal" && ctx.user.hat !== "coordinator") return false;
  if (ctx.user.role === "student" || ctx.user.role === "parent") return false;
  return ctx.user.role === "school_admin" || ctx.user.coordinatorScope.length > 0;
}

const L = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "u");
const STAFF_RE = L("staff|staffs|teachers?|teaching staff|educators?|guru|guru-guru|cikgu|staf|kakitangan|pendidik|warga guru|الموظفين|الموظفون|المعلمين|المعلمون|معلمين|الطاقم|الهيئة التدريسية|هيئة التدريس");
const EVERYONE_RE = L("parents?|families|students?|pupils?|learners?|everyone|everybody|whole school|entire school|ibu ?bapa|murid|pelajar|semua orang|seluruh sekolah|warga sekolah|أولياء|اولياء|الطلاب|طلاب|الجميع|المدرسة كلها");

/** "school" (default) or "staff" when she says staff / teachers / guru — and
 *  never staff when parents, students or everyone are named too. */
export function noticeAudience(said: unknown): NoticeAudience {
  if (said === "school" || said === "staff") return said;
  const t = typeof said === "string" ? said.toLowerCase() : "";
  if (!t) return "school";
  return STAFF_RE.test(t) && !EVERYONE_RE.test(t) ? "staff" : "school";
}

/** Grammar-neutral tidy: line endings, runs of spaces, stacked blank lines. No words change. */
export function tidyNoticeText(s: unknown): string {
  return typeof s === "string"
    ? s
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t ]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : "";
}

/** A short title from the body: its first line, cut at the first sentence end,
 *  at most 60 characters on a word boundary. */
export function deriveNoticeTitle(body: string): string {
  const first = (body.split("\n").find((l) => l.trim()) ?? "").trim();
  const sentence = (first.match(/^(.+?[.!?؟।])(?:\s|$)/u)?.[1] ?? first).replace(/[.!?؟।:;,،\s]+$/u, "").trim();
  if (sentence.length <= NOTICE_TITLE_DERIVED_MAX) return sentence;
  const cut = sentence.slice(0, NOTICE_TITLE_DERIVED_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,،:;]+$/u, "")}…`;
}

/** The card's "who sees it" line (0068 se_read). */
export function noticeSeenBy(audience: NoticeAudience, school: string, locale: string): string {
  return lineFor(audience === "staff" ? NOTICE_SEEN_STAFF : NOTICE_SEEN_SCHOOL, locale, { school });
}

async function schoolName(deps: SkCapabilityDeps, schoolId: string): Promise<string | null> {
  try {
    const r = (await deps.session.from("schools").select("id, name").eq("id", schoolId).maybeSingle()) as { data?: { id?: string; name?: string | null } | null; error?: unknown } | null;
    const name = r && !r.error && r.data && r.data.id === schoolId ? (r.data.name ?? "").trim() : "";
    return name ? name.slice(0, 80) : null;
  } catch {
    return null;
  }
}

const argStr = (args: Record<string, unknown>, key: string, max: number): string => (typeof args[key] === "string" ? (args[key] as string).trim().slice(0, max) : "");
const refuse = (summary: string, error: string): SkCapabilityResult => ({ ok: false, summary, error, facts: [] });

// ── Resolution ───────────────────────────────────────────────────────────────

export async function resolveNoticeSchool(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const locale = ctx.user.locale;
  if (!noticeStanding(ctx)) return refuse(lineFor(NOTICE_NO_STANDING, locale), "not_permitted");
  if (!noticesOn()) return refuse(lineFor(NOTICE_OFF, locale), "notices_off");

  const body = tidyNoticeText(args.body);
  if (!body) return refuse(lineFor(NOTICE_WHAT_TO_SAY, locale), "body required");
  if (body.length > NOTICE_BODY_MAX) return refuse(lineFor(NOTICE_TOO_LONG, locale), "body_too_long");
  const saidTitle = tidyNoticeText(args.title).replace(/\n+/g, " ");
  const title = saidTitle ? (saidTitle.length > NOTICE_TITLE_MAX ? deriveNoticeTitle(saidTitle) : saidTitle) : deriveNoticeTitle(body);
  const audience = noticeAudience(args.audience);

  const day = argStr(args, "startsAt", 60);
  const parsed = parseEntryDate(day, deps.now);
  if (parsed && !parsed.ok) return refuse(lineFor(NOTICE_DATE_UNPARSED, locale, { day }), "date_unparsed");
  const startsOn = parsed?.ok ? parsed.date : diaryDayKey(deps.now);

  // The composer's own rules (shared builder): the same checks the write will meet.
  const v = validateNotice({ title, body, audience, startsAt: schoolDayInstant(startsOn) }, deps.now.getTime());
  if (!v.ok) {
    if (v.code === "dates_passed") return refuse(lineFor(NOTICE_DATE_PASSED, locale), v.code);
    if (v.code === "body_too_long") return refuse(lineFor(NOTICE_TOO_LONG, locale), v.code);
    return refuse(v.error, v.code);
  }

  const school = (await schoolName(deps, ctx.user.schoolId!)) ?? lineFor(NOTICE_YOUR_SCHOOL, locale);
  const seenBy = noticeSeenBy(audience, school, locale);
  const cardTitle = lineFor(audience === "staff" ? NOTICE_CARD_TITLE_STAFF : NOTICE_CARD_TITLE_SCHOOL, locale);
  const params: Record<string, string | number | boolean | null> = {
    audience,
    title,
    body,
    starts_at: startsOn,
    school_label: school,
    seen_by: seenBy,
    // §9.2: a school-wide notice is never confirmed by voice (the card says so).
    click_only: true,
  };
  return {
    ok: true,
    // S5 gate finding 2026-10-29: the closing line in the leader's language too.
    summary: `${cardTitle}: "${title}" — "${body}" (${startsOn}). ${seenBy}. ${lineFor(NOTICE_NOT_UNTIL, locale)}`.slice(0, 600),
    facts: [{ kind: "notice.school", audience, title, body, starts_at: startsOn, seen_by: seenBy }],
    entities: [],
    confirm: { action: "notice.school", title: cardTitle, params },
  };
}

export const noticeSchoolAction: SkCapability = {
  meta: {
    name: "notice.school",
    description:
      "Post a notice to the WHOLE SCHOOL (every parent, student and teacher) or to ALL STAFF — the principal's or a coordinator's notice board. Returns a confirmation card showing the exact text; nothing is posted until the leader CLICKS Confirm (a spoken yes never posts it). Use for 'post a notice to the whole school: …', 'tell all staff …', 'send a school notice …', 'announce to everyone …', 'hantar notis kepada semua …', 'maklumkan kepada semua guru …', 'أرسل إشعارًا للمدرسة …', 'أخبر جميع المعلمين …'. " +
      "body = the leader's own words: you may fix grammar and spelling, never add facts, dates, times or names she did not say. title: only if she gave one; otherwise omit it (SK uses the first line). audience: 'staff' when she says staff / teachers / guru / المعلمين, else 'school'. startsAt: the day in her words (today, tomorrow, Friday, 2026-11-03); omit for today. One class or one learner is NOT this tool (that is diary.note).",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "The notice text: the leader's words (grammar may be tidied, no facts added)." },
        title: { type: "string", description: "A short title, only if the leader said one." },
        audience: { type: "string", description: "'school' (everyone, the default) or 'staff' (all staff) — or her words for it." },
        startsAt: { type: "string", description: "The day the notice is for, in her words; omit for today." },
      },
      required: ["body"],
      additionalProperties: false,
    },
    tier: "confirm",
    kind: "act",
    // A coordinator is a teacher with a scope grant: effectiveRoles adds
    // "coordinator". /api/sk/act re-checks this meta before the consume.
    roles: ["school_admin", "coordinator"],
    hats: ["principal", "coordinator"],
    // S5 slice B: ctx.flags.notices (noticesEnabledFor, slice A's loadContext);
    // FEATURE_NOTICES is read again in the handler and the executor.
    flags: ["notices"],
  },
  handler: resolveNoticeSchool,
};
