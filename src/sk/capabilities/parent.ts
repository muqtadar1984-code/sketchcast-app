// SK S4 — the PARENT reads (design 2026-10-29 slices A + B; Final Plan §4 parent
// column, §8.1). Six capabilities, role parent, immediate tier, kind read:
//
//   child.status    shared work (class + direct), done / overdue, scores,
//                   awaiting marking, the teacher's feedback (child-work.ts —
//                   the SAME assembly /dashboard/children renders)
//   child.diary     the last 14 days of diary notes: the child's own + the
//                   class notes of the child's classes
//   child.notices   the child's school's upcoming notices (school-linked
//                   children only; a home learner gets a fixed line)
//   child.risk      at-risk / did-well under the school-health rules, counting
//                   DIRECT shares too (computeLearnerHealth) so home learners
//                   are covered
//   child.progress  the child's SK mastery (sk_objective_mastery + mastery_state)
//                   grouped mastered / getting there / needs work — the ONE
//                   admin read, behind the verified-link gate (parent-mastery.ts)
//   child.week      the in-app digest from status + diary + progress, with
//                   "What to do about it" (parent-digest.ts). No model call.
//
// Scope: every capability takes an optional `child` (name or id) and runs it
// through resolveChild — ctx.children ONLY, VERIFIED links only; an id that is
// not there is refused. No child named + 2 children = one block per child.
// Every read but child.progress is the USER-SESSION client (RLS: the parent's
// own children), and every row is re-cut to the one child in code, so a read
// that returned too much can never put a sibling's or a stranger's row in the
// answer (parent-isolation.test.ts runs every capability against a leaky fake).

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkChild, SkContext } from "@/sk/shell/types";
import { lineFor } from "@/sk/shell/lines";
import { P_NO_CHILDREN, P_NOT_LINKED, P_READ_FAILED, P_UNVERIFIED, P_WHICH_CHILD } from "@/sk/shell/parent-lines";
import { childWorkItems, uniqueWork, type ChildWorkRows } from "@/utils/child-work";
import { computeLearnerHealth } from "@/utils/school-health";
import { noticesFor } from "@/utils/notices";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveChild, verifiedChildren } from "./child-scope";
import { memo } from "./shared";
import { childMastery, type ChildMasteryRow } from "@/sk/parent-mastery";
import { DIARY_DAYS, diaryBlock, noticesBlock, progressBlock, riskBlock, statusBlock, weekBlock, type Block, type ChildDiaryNote, type ChildNotice } from "@/sk/parent-digest";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => {
  const x = r as { data?: unknown; error?: { message?: string } | null } | null;
  if (x?.error) throw new Error(x.error.message || "read failed");
  return Array.isArray(x?.data) ? (x!.data as Row[]) : [];
};
const str = (v: unknown) => (typeof v === "string" ? v : null);

// ── The session reads (one per turn, for the parent's verified children) ────

export type ChildSlice = ChildWorkRows & { classNames: Record<string, string> };

/** Work rows for these children, RLS-scoped and then cut to them in code. */
export function readChildSlice(deps: SkCapabilityDeps, me: string, childIds: string[]): Promise<ChildSlice> {
  const ids = [...new Set(childIds)].sort();
  return memo(deps, `parentSlice:${me}:${ids.join(",")}`, async () => {
    const db = deps.session;
    const kids = new Set(ids);
    const enrollments = rowsOf(await db.from("enrollments").select("class_id, student_id").in("student_id", ids))
      .filter((e) => kids.has(e.student_id as string) && typeof e.class_id === "string")
      .map((e) => ({ class_id: e.class_id as string, student_id: e.student_id as string }));
    const classIds = [...new Set(enrollments.map((e) => e.class_id))];
    const classSet = new Set(classIds);
    const [classesQ, byClassQ, directQ, progQ, subsQ] = await Promise.all([
      classIds.length ? db.from("classes").select("id, name").in("id", classIds) : Promise.resolve({ data: [] }),
      classIds.length ? db.from("generation_shares").select("generation_id, class_id, student_id, due_at, shared_by, created_at").in("class_id", classIds) : Promise.resolve({ data: [] }),
      db.from("generation_shares").select("generation_id, class_id, student_id, due_at, shared_by, created_at").in("student_id", ids),
      db.from("student_progress").select("generation_id, student_id, status, completed_at, updated_at").in("student_id", ids),
      db.from("submissions").select("generation_id, student_id, auto_score, teacher_score, max_score, grade_status, feedback, submitted_at, graded_at").in("student_id", ids),
    ]);
    const shares = [...rowsOf(byClassQ), ...rowsOf(directQ)]
      .filter((s) => (typeof s.class_id === "string" && classSet.has(s.class_id)) || (typeof s.student_id === "string" && kids.has(s.student_id)))
      .map((s) => ({
        generation_id: s.generation_id as string,
        class_id: str(s.class_id),
        student_id: str(s.student_id),
        due_at: str(s.due_at),
        shared_by: str(s.shared_by),
        created_at: str(s.created_at),
      }));
    // The same share can come back from both reads (a class share to a class
    // with a direct student_id is not a thing, but the belt costs nothing).
    const seen = new Set<string>();
    const uniq = shares.filter((s) => {
      const k = `${s.generation_id}|${s.class_id}|${s.student_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const genIds = [...new Set(uniq.map((s) => s.generation_id))];
    const gens = genIds.length ? rowsOf(await db.from("generations").select("id, title, kind, chapter_ref").in("id", genIds)) : [];
    const genSet = new Set(genIds);
    return {
      enrollments,
      shares: uniq,
      generations: gens.filter((g) => genSet.has(g.id as string)).map((g) => ({ id: g.id as string, title: str(g.title), kind: str(g.kind), chapter_ref: str(g.chapter_ref) })),
      progress: rowsOf(progQ)
        .filter((p) => kids.has(p.student_id as string))
        .map((p) => ({ generation_id: p.generation_id as string, student_id: p.student_id as string, status: String(p.status ?? ""), completed_at: str(p.completed_at), updated_at: str(p.updated_at) })),
      submissions: rowsOf(subsQ)
        .filter((s) => kids.has(s.student_id as string))
        .map((s) => ({
          generation_id: s.generation_id as string,
          student_id: s.student_id as string,
          auto_score: typeof s.auto_score === "number" ? s.auto_score : null,
          teacher_score: typeof s.teacher_score === "number" ? s.teacher_score : null,
          max_score: typeof s.max_score === "number" ? s.max_score : null,
          grade_status: str(s.grade_status),
          feedback: str(s.feedback),
          submitted_at: str(s.submitted_at),
          graded_at: str(s.graded_at),
        })),
      classNames: Object.fromEntries(rowsOf(classesQ).filter((c) => classSet.has(c.id as string)).map((c) => [c.id as string, String(c.name ?? "")])),
    };
  });
}

/** The child's diary notes of the last DIARY_DAYS days: her own + her classes' class-wide notes. */
export async function readChildDiary(deps: SkCapabilityDeps, me: string, child: SkChild, slice: ChildSlice): Promise<ChildDiaryNote[]> {
  const classIds = [...new Set(slice.enrollments.filter((e) => e.student_id === child.id).map((e) => e.class_id))];
  const since = new Date(deps.now.getTime() - DIARY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const cols = "id, author_id, class_id, student_id, note_type, body, entry_date, created_at";
  const [ownQ, classQ] = await Promise.all([
    memo(deps, `parentDiary:${me}:child:${child.id}`, async () => await deps.session.from("diary_notes").select(cols).eq("student_id", child.id).gte("entry_date", since).order("created_at", { ascending: false }).limit(30)),
    classIds.length
      ? memo(deps, `parentDiary:${me}:classes:${classIds.sort().join(",")}`, async () => await deps.session.from("diary_notes").select(cols).in("class_id", classIds).is("student_id", null).gte("entry_date", since).order("created_at", { ascending: false }).limit(30))
      : Promise.resolve({ data: [] }),
  ]);
  const classSet = new Set(classIds);
  const seen = new Set<string>();
  const out: ChildDiaryNote[] = [];
  for (const n of [...rowsOf(ownQ), ...rowsOf(classQ)]) {
    const id = str(n.id);
    if (!id || seen.has(id)) continue;
    const own = n.student_id === child.id;
    const classWide = !n.student_id && typeof n.class_id === "string" && classSet.has(n.class_id);
    if (!own && !classWide) continue; // never a sibling's or a classmate's note
    if (typeof n.entry_date === "string" && n.entry_date < since) continue;
    seen.add(id);
    out.push({
      id,
      authorId: String(n.author_id ?? ""),
      classId: str(n.class_id),
      studentId: str(n.student_id),
      type: String(n.note_type ?? ""),
      body: String(n.body ?? ""),
      entryDate: String(n.entry_date ?? ""),
      createdAt: String(n.created_at ?? ""),
    });
  }
  return out;
}

/** The child's school's upcoming notices (school audience), or null when off. */
export async function readChildNotices(deps: SkCapabilityDeps, me: string, child: SkChild): Promise<ChildNotice[] | null> {
  if (child.source !== "school" || !child.schoolId) return null;
  const data = await noticesFor(deps.session as unknown as SupabaseClient, { userId: me, role: "parent", schoolId: null }, 5, { onlySchoolId: child.schoolId });
  if (!data) return null;
  return data.upcoming.filter((n) => n.audience === "school").map((n) => ({ title: n.title, when: n.when }));
}

// ── The capabilities ────────────────────────────────────────────────────────

type PerChild = (ctx: SkContext, child: SkChild, deps: SkCapabilityDeps, slice: () => Promise<ChildSlice>) => Promise<Block>;

const CHILD_PARAM = {
  type: "object" as const,
  properties: {
    child: {
      type: "string",
      description: "The child's name or id, as one of the parent's linked children. Omit to answer for every child (one block each).",
    },
  },
  additionalProperties: false,
};

/** Run one per-child answer for the children the request is about. */
async function forChildren(name: string, ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps, per: PerChild): Promise<SkCapabilityResult> {
  const locale = ctx.user.locale;
  const scope = resolveChild(ctx, args.child);
  if (scope.kind === "refused") {
    const summary = lineFor(scope.reason === "no_children" ? P_NO_CHILDREN : P_NOT_LINKED, locale);
    return { ok: false, summary, error: scope.reason, facts: [], entities: [] };
  }
  if (scope.kind === "unverified") return { ok: false, summary: lineFor(P_UNVERIFIED, locale, { name: scope.child.firstName }), error: "unverified", facts: [], entities: [] };
  if (scope.kind === "ask") {
    return { ok: true, summary: lineFor(P_WHICH_CHILD, locale, { names: scope.candidates.map((c) => c.firstName).join(", ") }), facts: [], entities: [] };
  }
  const me = ctx.user.id;
  // One slice for ALL the verified children (the turn's memo keys on the set),
  // read lazily: child.notices never needs it.
  const ids = verifiedChildren(ctx).map((c) => c.id);
  const slice = () => readChildSlice(deps, me, ids);
  const blocks: string[] = [];
  const facts: Array<Record<string, string | number | boolean | null>> = [];
  const entities: ResolvedEntity[] = [];
  for (const child of scope.children) {
    try {
      const b = await per(ctx, child, deps, slice);
      blocks.push(b.summary);
      facts.push(...b.facts);
    } catch {
      blocks.push(lineFor(P_READ_FAILED, locale, { name: child.firstName }));
    }
    entities.push({ kind: "learner", id: child.id, label: child.name, via: name });
  }
  return { ok: true, summary: blocks.join("\n"), facts, entities };
}

function parentRead(name: string, description: string, per: PerChild): SkCapability {
  return {
    meta: { name, description, parameters: CHILD_PARAM, tier: "immediate", kind: "read", roles: ["parent"] },
    handler: (ctx, args, deps) => forChildren(name, ctx, args, deps, per),
  };
}

const workOf = (slice: ChildSlice, child: SkChild, now: Date) => uniqueWork(childWorkItems(slice, child.id, now.getTime()));

export const childStatus = parentRead(
  "child.status",
  "A parent's child's shared work: how many pieces, done, overdue (with due dates), awaiting marking, the latest score and the teacher's latest feedback. One block per child when no child is named.",
  async (ctx, child, deps, slice) => statusBlock(child, workOf(await slice(), child, deps.now), ctx.user.locale),
);

export const childDiary = parentRead(
  "child.diary",
  "The latest diary (buku komunikasi) notes for a parent's child over the last 14 days: notes to the child and class-wide notes of the child's classes.",
  async (ctx, child, deps, slice) => diaryBlock(child, await readChildDiary(deps, ctx.user.id, child, await slice()), ctx.user.locale, ctx.user.id),
);

export const childNotices = parentRead(
  "child.notices",
  "Upcoming notices from a parent's child's school (school-linked children only; home learners have no school notices).",
  async (ctx, child, deps) => noticesBlock(child, await readChildNotices(deps, ctx.user.id, child), ctx.user.locale),
);

export const childRisk = parentRead(
  "child.risk",
  "Whether a parent's child is at risk or did well, by the school-health rules (low completion, inactive 14+ days, never started, low or declining scores, 2+ overdue), counting class and direct shares.",
  async (ctx, child, deps, slice) => {
    const s = await slice();
    // Only the child's real work: a lesson plan or a withdrawn generation is
    // not something the child was asked to do (child-work.ts's rule).
    const live = new Set(s.generations.filter((g) => g.kind !== "lesson_plan").map((g) => g.id));
    const health = computeLearnerHealth(
      {
        enrollments: s.enrollments.map((e) => ({ ...e, full_name: null, username: null, parent_email: null })),
        shares: s.shares.filter((x) => live.has(x.generation_id)).map((x) => ({ generation_id: x.generation_id, class_id: x.class_id, student_id: x.student_id, shared_by: x.shared_by ?? "", due_at: x.due_at })),
        progress: s.progress.map((p) => ({ generation_id: p.generation_id, student_id: p.student_id, status: p.status, updated_at: p.updated_at ?? p.completed_at ?? "" })),
        submissions: s.submissions.map((x) => ({
          generation_id: x.generation_id,
          student_id: x.student_id,
          auto_score: x.auto_score,
          max_score: x.max_score,
          teacher_score: x.teacher_score,
          submitted_at: x.submitted_at ?? "",
          graded_at: x.graded_at ?? null,
          grade_status: x.grade_status ?? "",
        })),
      },
      child.id,
      deps.now.getTime(),
    );
    return riskBlock(child, health, ctx.user.locale);
  },
);

export const childProgress = parentRead(
  "child.progress",
  "What a parent's child has mastered in SK practice, grouped mastered / getting there / needs work, with the ideas named.",
  async (ctx, child) => progressBlock(child, await childMastery(ctx, child.id), ctx.user.locale),
);

export const childWeek = parentRead(
  "child.week",
  "The weekly digest for a parent's child: done this week, overdue, awaiting marking, ideas mastered, new diary notes, and up to two concrete next steps (what to do about it).",
  async (ctx, child, deps, slice) => {
    const s = await slice();
    const [notes, mastery] = await Promise.all([readChildDiary(deps, ctx.user.id, child, s), childMastery(ctx, child.id)]);
    const input: { items: ReturnType<typeof workOf>; notes: ChildDiaryNote[]; mastery: ChildMasteryRow[] | null } = { items: workOf(s, child, deps.now), notes, mastery };
    return weekBlock(child, input, ctx.user.locale, deps.now.getTime());
  },
);

export const PARENT_CAPABILITIES: SkCapability[] = [childStatus, childDiary, childNotices, childRisk, childProgress, childWeek];
