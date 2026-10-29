// `parents.remind` — "remind the parents of everyone who hasn't finished"
// (S2 slice A; Final Plan 2026-10-28 §2.5, §4, §8.2, §9.2).
//
// Input is ONE assignment (a class share): its id from `assignments.status`
// (the `share` entity), or the most recent `learners` entity
// `not-done:<shareId>` in the conversation memory ("remind their parents").
// The not-done learners are RE-READ here through the user-session client —
// the teacher's own class only — with the analytics page's own definition
// (src/utils/assignment-status.ts), never taken from the memory blob.
//
// The card carries the learner ids (flat, comma-joined), the count and the
// message each family will get. The default message names NO child: one note
// per student goes out with the same text, so it says "your child". A message
// the teacher dictates ("change the message to …" re-issues the card) is
// refused if it names a learner of that class, for the same reason.
//
// Cap: 40 families per action; above that SK refuses ("narrow it to one
// class"). Not click-only: a spoken yes may confirm (one class, one kit).
//
// The write happens only in /api/sk/act → act-diary.ts, AS THE TEACHER: one
// diary_notes row per learner still not done at execution time
// {student_id, note_type 'reminder', parents_only true, body, sk_action_id}.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "@/sk/shell/types";
import { assignmentStatus, shareTitle, type StatusEnrollmentRow, type StatusProgressRow, type StatusShareRow, type StatusSubmissionRow } from "@/utils/assignment-status";
import { classEnrollments, teacherClasses } from "./shared";
import { DIARY_BODY_MAX } from "./diary";
import { lineFor } from "@/sk/shell/lines";
import { REMIND_BODY, REMIND_BODY_NO_DUE, REMIND_CARD_TITLE, REMIND_CARD_TITLE_ONE, REMIND_TOO_MANY } from "@/sk/shell/act-lines";

/** Families per action (one diary note each). */
export const REMIND_MAX = 40;
const NOT_DONE_PREFIX = "not-done:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The share an instruction refers to: an explicit id (bare or `not-done:<id>`),
 *  else the most recent not-done learners entity in the conversation. */
export function shareIdFor(ctx: SkContext, args: Record<string, unknown>): string | null {
  for (const key of ["shareId", "learnersId"]) {
    const v = typeof args[key] === "string" ? (args[key] as string).trim() : "";
    const id = v.startsWith(NOT_DONE_PREFIX) ? v.slice(NOT_DONE_PREFIX.length) : v;
    if (UUID_RE.test(id)) return id;
  }
  const recent = ctx.recent.entities.find((e) => e.kind === "learners" && e.id.startsWith(NOT_DONE_PREFIX) && UUID_RE.test(e.id.slice(NOT_DONE_PREFIX.length)));
  return recent ? recent.id.slice(NOT_DONE_PREFIX.length) : null;
}

/** "Fri, 30 Oct" in the teacher's language, in the diary's civil zone. */
export function formatDueDay(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const tag = locale === "ms-arab" ? "ms" : locale || "en";
  try {
    return new Intl.DateTimeFormat(tag, { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kuala_Lumpur" }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

const NAME_STOP = new Set(["bin", "binti", "bte", "bt", "al", "el", "a/l", "a/p", "s/o", "d/o", "van", "von", "de", "da", "la", "le", "mohd", "muhammad", "mohamed", "mohammad", "nur"]);

/** Does a dictated message name a learner of the class? Full names, and first
 *  names of 3+ letters that are not a common particle or prefix. */
export function namesALearner(body: string, names: string[]): string | null {
  const b = ` ${body.toLowerCase().replace(/[^\p{L}\p{N}/]+/gu, " ")} `;
  for (const raw of names) {
    const n = raw.toLowerCase().replace(/[^\p{L}\p{N}/]+/gu, " ").trim();
    if (!n) continue;
    if (n.length >= 3 && b.includes(` ${n} `)) return raw;
    const first = n.split(" ").find((t) => !NAME_STOP.has(t));
    if (first && first.length >= 3 && b.includes(` ${first} `)) return raw;
  }
  return null;
}

type Row = Record<string, unknown>;
const rows = <T>(res: unknown, what: string): T[] => {
  const r = res as { data?: unknown; error?: { message?: string } | null } | null;
  if (!r) return [];
  if (r.error) throw new Error(`${what}: ${r.error.message ?? "query failed"}`);
  return (Array.isArray(r.data) ? r.data : []) as T[];
};

export async function resolveParentsRemind(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const me = ctx.user.id;
  const shareId = shareIdFor(ctx, args);
  if (!shareId) {
    return { ok: false, summary: "Which assignment? Ask me how an assignment stands first (class and kit), then I can remind the parents.", error: "share required", facts: [] };
  }
  const custom = typeof args.body === "string" ? args.body.replace(/\r\n/g, "\n").trim() : "";
  if (custom.length > DIARY_BODY_MAX) return { ok: false, summary: `That message is too long — the diary takes up to ${DIARY_BODY_MAX} characters.`, error: "body_too_long", facts: [] };

  try {
    const classes = rows<Row>(await teacherClasses(deps, me), "classes").filter((c) => c.teacher_id === me);
    const classNames: Record<string, string> = {};
    for (const c of classes) classNames[c.id as string] = (c.name as string) || "Class";
    const share = rows<StatusShareRow>(
      await deps.session.from("generation_shares").select("id, generation_id, class_id, due_at, generations(kind, chapter_ref, title)").eq("id", shareId),
      "generation_shares",
    ).find((s) => s.id === shareId && !!s.class_id && s.class_id in classNames);
    if (!share || !share.class_id) return { ok: false, summary: "I can't find that assignment among your classes.", error: "share_not_found", facts: [] };
    const classId = share.class_id;

    const [enrQ, progQ, subsQ] = await Promise.all([
      classEnrollments(deps, me, [classId]),
      deps.session.from("student_progress").select("generation_id, student_id, status").eq("generation_id", share.generation_id),
      deps.session.from("submissions").select("generation_id, student_id, grade_status").eq("generation_id", share.generation_id),
    ]);
    const enrollments = rows<StatusEnrollmentRow>(enrQ, "enrollments").filter((e) => e.class_id === classId);
    const progress = rows<StatusProgressRow>(progQ, "student_progress").filter((p) => p.generation_id === share.generation_id);
    const submissions = rows<StatusSubmissionRow>(subsQ, "submissions").filter((s) => s.generation_id === share.generation_id);
    const s = assignmentStatus({ shares: [share], enrollments, progress, submissions, classNames, now: deps.now }).shares[0];
    const title = s?.title ?? shareTitle(share.generations);
    const className = classNames[classId];
    const ids = s?.notDoneIds ?? [];

    if (!ids.length) {
      return { ok: true, summary: `Everyone in ${className} has finished ${title} — no reminders needed.`, facts: [{ kind: "parents.remind", class_name: className, kit_title: title, count: 0 }], entities: [] };
    }
    if (ids.length > REMIND_MAX) {
      return { ok: false, summary: lineFor(REMIND_TOO_MANY, ctx.user.locale, { max: REMIND_MAX }), error: "too_many", facts: [] };
    }

    const roster = enrollments.map((e) => (e.profiles?.full_name || e.profiles?.username || "").trim()).filter(Boolean);
    if (custom) {
      const named = namesALearner(custom, roster);
      if (named) {
        return { ok: false, summary: "That message names a learner, and the same text goes to every family — say it without names.", error: "body_names_learner", facts: [] };
      }
    }
    const body = custom || (share.due_at ? lineFor(REMIND_BODY, ctx.user.locale, { title, due: formatDueDay(share.due_at, ctx.user.locale) }) : lineFor(REMIND_BODY_NO_DUE, ctx.user.locale, { title }));

    const cardTitle = ids.length === 1 ? lineFor(REMIND_CARD_TITLE_ONE, ctx.user.locale, { class: className }) : lineFor(REMIND_CARD_TITLE, ctx.user.locale, { n: ids.length, class: className });
    const entities: ResolvedEntity[] = [
      { kind: "share", id: share.id, label: `${title} → ${className}`, via: "parents.remind", ids: [share.generation_id, classId] },
      { kind: "learners", id: `${NOT_DONE_PREFIX}${share.id}`, label: `Not done — ${title} (${className})`, via: "parents.remind", ids },
    ];
    return {
      ok: true,
      summary: `${cardTitle}. Message: "${body}". Nothing is sent until the teacher confirms.`.slice(0, 700),
      facts: [{ kind: "parents.remind", class_name: className, kit_title: title, count: ids.length, learners: (s?.notDoneNames ?? []).join(", "), body }],
      entities,
      confirm: {
        action: "parents.remind",
        title: cardTitle,
        params: {
          share_id: share.id,
          generation_id: share.generation_id,
          class_id: classId,
          student_ids: ids.join(","),
          count: ids.length,
          body,
          class_name: className,
          kit_title: title,
        },
      },
    };
  } catch (e) {
    return { ok: false, summary: "I could not read that assignment right now.", error: e instanceof Error ? e.message : String(e), facts: [] };
  }
}

export const parentsRemindAction: SkCapability = {
  meta: {
    name: "parents.remind",
    description:
      "Remind the parents of the learners who have NOT finished one assignment, through the diary: one parents-only reminder note per learner. Returns a confirmation card with the count and the exact message — nothing is sent until the teacher confirms. Give the assignment as shareId (a `share` id from assignments.status, or the `not-done:<shareId>` learners id); with neither, the most recent not-done list in this conversation is used ('remind their parents'). If the teacher has not said which assignment, call assignments.status first. body: omit for the default message; pass the teacher's own words when she dictates or changes the message ('change the message to …' — call again with the new body). Never put a child's name in the body: the same text goes to every family.",
    parameters: {
      type: "object",
      properties: {
        shareId: { type: "string", description: "The assignment (class share) id, or 'not-done:<shareId>'." },
        body: { type: "string", description: "The message in the teacher's words; omit for the default reminder." },
      },
      additionalProperties: false,
    },
    tier: "confirm",
    kind: "act",
    roles: ["teacher"],
    hats: ["teacher"],
    flags: ["diary"],
  },
  handler: resolveParentsRemind,
};
