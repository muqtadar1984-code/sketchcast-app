// The recommended plan — drafting and storing it (SK student Board plan
// 2026-10-31, phase 4). Server only, SERVICE ROLE: the practice route (after
// she finishes a kit's worksheet) and the weekly sweep draft plans here; the
// approver's decision is never written here — it goes through
// sk_learn_plan_decide() as the approver (/api/learn/plan, SK's plan.review).
//
//   draftPlan(deps, { studentId, kitId, trigger })
//     1. WHO APPROVES (resolveApprover): a student in a class is a SCHOOL
//        student — the teacher of the class the kit reached her through
//        (else her first class) approves; a student in no class is a HOME
//        student — her linked parent approves (the one who assigned the kit,
//        else a verified link, else any link). Nobody → no plan.
//     2. ONE OPEN PLAN per student per kit (0179's unique index): an open plan
//        for the kit → "exists", nothing written. A weekly plan supersedes the
//        open weekly plan before it.
//     3. her mastery (mastery-read.ts) → SK's items (plan.ts planSkeleton) —
//        no evidence and no next topic → no plan;
//     4. the row is CLAIMED as a draft first (the index makes a concurrent
//        second draft a 23505 → "exists"), worded (Haiku 5.5, or the plain
//        wording), then moved to pending_approval.

import type { DbRow, SkDb } from "@/sk/store-supabase";
import type { HelpModelCall } from "./help";
import { readPracticeMastery, kitTitleOf } from "./mastery-read";
import { masterySnapshot, planSkeleton, polishPlan, type ApproverRole, type NextKit, type PlanItem } from "./plan";

export type Approver = { role: ApproverRole; approverId: string; classId: string | null };

const rowsOf = (r: { data?: unknown }): DbRow[] => ((r?.data ?? []) as DbRow[]) || [];
const isDup = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === "23505" || /duplicate key|unique constraint/i.test(e.message ?? ""));

/** The plan's approver for this student and kit (service role reads). */
export async function resolveApprover(db: SkDb, studentId: string, kitId: string | null): Promise<Approver | null> {
  const enr = rowsOf(await db.from("enrollments").select("class_id").eq("student_id", studentId));
  const classIds = enr.map((r) => String(r.class_id)).filter(Boolean);
  if (classIds.length) {
    const classes = rowsOf(await db.from("classes").select("id, teacher_id, created_at").in("id", classIds));
    let via: string | null = null;
    if (kitId) {
      const shares = rowsOf(await db.from("generation_shares").select("class_id").eq("generation_id", kitId));
      via = shares.map((s) => String(s.class_id ?? "")).find((c) => classIds.includes(c)) ?? null;
    }
    const sorted = [...classes].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
    const cls = (via && classes.find((c) => String(c.id) === via)) || sorted[0];
    if (!cls || !cls.teacher_id) return null;
    return { role: "teacher", approverId: String(cls.teacher_id), classId: String(cls.id) };
  }
  const links = rowsOf(await db.from("parent_links").select("parent_id, verified_at, created_at").eq("child_id", studentId));
  if (!links.length) return null;
  let sharer: string | null = null;
  if (kitId) {
    const direct = rowsOf(await db.from("generation_shares").select("shared_by").eq("generation_id", kitId).eq("student_id", studentId));
    sharer = direct.map((d) => String(d.shared_by ?? "")).find((p) => links.some((l) => String(l.parent_id) === p)) ?? null;
  }
  const pick = sharer ?? String((links.find((l) => l.verified_at) ?? links[0]).parent_id);
  return { role: "parent", approverId: pick, classId: null };
}

/**
 * The next topic: an assigned kit she has not practised yet (soonest due),
 * else the approver's own next chapter of the same book. Null when neither.
 */
export async function resolveNext(db: SkDb, studentId: string, kitId: string | null, approver: Approver, practisedKits: ReadonlySet<string>): Promise<NextKit | null> {
  const enr = rowsOf(await db.from("enrollments").select("class_id").eq("student_id", studentId)).map((r) => String(r.class_id));
  const direct = rowsOf(await db.from("generation_shares").select("generation_id, due_at").eq("student_id", studentId));
  const viaClass = enr.length ? rowsOf(await db.from("generation_shares").select("generation_id, due_at, class_id").in("class_id", enr)) : [];
  const shared = [...direct, ...viaClass];
  const ids = [...new Set(shared.map((s) => String(s.generation_id)))].filter((g) => g !== kitId && !practisedKits.has(g));
  if (ids.length) {
    const gens = rowsOf(await db.from("generations").select("id, title, kind, status, withdrawn_at").in("id", ids)).filter(
      (g) => g.kind === "presentation" && (g.status == null || g.status === "done") && !g.withdrawn_at,
    );
    const due = (id: string) => {
      const ds = shared.filter((s) => String(s.generation_id) === id).map((s) => (typeof s.due_at === "string" ? Date.parse(s.due_at) : Infinity));
      return Math.min(...ds, Infinity);
    };
    const best = gens.sort((a, b) => due(String(a.id)) - due(String(b.id)))[0];
    if (best) return { generationId: String(best.id), title: kitTitleOf(best), assigned: true };
  }
  if (!kitId) return null;
  const { data: kit } = await db.from("generations").select("id, book_id, chapter_ref").eq("id", kitId).maybeSingle();
  const bookId = kit?.book_id;
  const ch = kit?.chapter_ref;
  if (!bookId || ch === null || ch === undefined || !Number.isFinite(Number(ch))) return null;
  const next = rowsOf(
    await db.from("generations").select("id, title, kind, status, withdrawn_at, created_at").eq("owner_id", approver.approverId).eq("book_id", String(bookId)).eq("chapter_ref", String(Number(ch) + 1)),
  )
    .filter((g) => g.kind === "presentation" && (g.status == null || g.status === "done") && !g.withdrawn_at)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
  return next ? { generationId: String(next.id), title: kitTitleOf(next), assigned: false } : null;
}

/** kit → a worksheet she practised in it (newest), from her practice sessions. */
async function practisedWorksheets(db: SkDb, studentId: string): Promise<{ byKit: Map<string, { id: string; title: string }>; kits: Set<string> }> {
  const sessions = rowsOf(await db.from("sk_practice_sessions").select("id, kit_id").eq("student_id", studentId));
  const kitOf = new Map(sessions.map((s) => [String(s.id), String(s.kit_id)] as const));
  const kits = new Set(kitOf.values());
  const byKit = new Map<string, { id: string; title: string }>();
  if (!sessions.length) return { byKit, kits };
  const att = rowsOf(await db.from("sk_practice_attempts").select("session_id, generation_id, created_at").eq("student_id", studentId).order("created_at", { ascending: false }).limit(2000));
  const wsIds = new Set<string>();
  for (const a of att) {
    const k = kitOf.get(String(a.session_id));
    if (k && !byKit.has(k)) {
      byKit.set(k, { id: String(a.generation_id), title: "" });
      wsIds.add(String(a.generation_id));
    }
  }
  if (wsIds.size) {
    const gens = rowsOf(await db.from("generations").select("id, title").in("id", [...wsIds]));
    for (const [k, v] of byKit) byKit.set(k, { id: v.id, title: kitTitleOf(gens.find((g) => String(g.id) === v.id)) });
  }
  return { byKit, kits };
}

export type DraftOutcome = { outcome: "drafted"; planId: string; items: PlanItem[] } | { outcome: "exists" | "no_approver" | "no_evidence" | "error"; planId?: string };

export type DraftDeps = { db: SkDb; call: HelpModelCall | null; now?: () => number; log?: (m: string) => void; language?: string };

export async function draftPlan(deps: DraftDeps, input: { studentId: string; kitId: string | null; trigger: "kit_done" | "weekly" }): Promise<DraftOutcome> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  try {
    const approver = await resolveApprover(db, input.studentId, input.kitId);
    if (!approver) return { outcome: "no_approver" };

    // One open plan per student per kit; a weekly plan replaces the open weekly one.
    const open = rowsOf(await db.from("sk_learn_plans").select("id, kit_id, status, trigger").eq("student_id", input.studentId)).filter(
      (p) => (p.status === "draft" || p.status === "pending_approval") && (p.kit_id ?? null) === input.kitId,
    );
    if (open.length && input.trigger !== "weekly") return { outcome: "exists", planId: String(open[0].id) };

    const read = await readPracticeMastery(db, [input.studentId], { kitId: input.kitId, now: now() });
    const { byKit, kits } = await practisedWorksheets(db, input.studentId);
    const next = await resolveNext(db, input.studentId, input.kitId, approver, kits);
    const items = planSkeleton({ mastery: read.rows, worksheets: byKit, kitNames: read.kits, next });
    if (!read.rows.length || !items.length) return { outcome: "no_evidence" };

    const nowIso = new Date(now()).toISOString();
    for (const p of open) await db.from("sk_learn_plans").update({ status: "superseded", updated_at: nowIso }).eq("id", String(p.id)).eq("status", String(p.status));
    const claim = await db.from("sk_learn_plans").insert({
      student_id: input.studentId,
      kit_id: input.kitId,
      trigger: input.trigger,
      approver_role: approver.role,
      class_id: approver.classId,
      approver_id: approver.approverId,
      status: "draft",
      items,
      mastery: masterySnapshot(read.rows),
      created_at: nowIso,
      updated_at: nowIso,
    });
    if (claim.error) return isDup(claim.error) ? { outcome: "exists" } : { outcome: "error" };
    const { data: mine } = await db
      .from("sk_learn_plans")
      .select("id, status")
      .eq("student_id", input.studentId)
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const planId = mine?.id ? String(mine.id) : null;
    if (!planId) return { outcome: "error" };

    const worded = await polishPlan(deps.call, items, masterySnapshot(read.rows), deps.language ?? "English");
    const upd = await db
      .from("sk_learn_plans")
      .update({ status: "pending_approval", summary: worded.summary, items: worded.items, model: worded.model, cost_usd: worded.cost, updated_at: new Date(now()).toISOString() })
      .eq("id", planId)
      .eq("status", "draft");
    if (upd.error) return { outcome: "error", planId };
    return { outcome: "drafted", planId, items: worded.items };
  } catch (e) {
    deps.log?.(`sk-learn.plan draft failed: ${(e as Error).message}`);
    return { outcome: "error" };
  }
}

/**
 * Is the worksheet finished in this practice session (every question right,
 * sent for marking, or taken to the answer rung)? And was this the session's
 * first answer on it? Drives the plan trigger and the lazy concept tagging.
 */
export async function worksheetProgress(db: SkDb, sessionId: string, generationId: string, questionIds: readonly string[]): Promise<{ first: boolean; finished: boolean }> {
  const rows = rowsOf(await db.from("sk_practice_attempts").select("question_id, outcome, rung").eq("session_id", sessionId).eq("generation_id", generationId));
  const closed = new Set(rows.filter((r) => r.outcome === "correct" || r.outcome === "review" || r.rung === "answer").map((r) => String(r.question_id)));
  return { first: rows.length === 1, finished: questionIds.length > 0 && questionIds.every((q) => closed.has(q)) };
}

/** Plans as a SESSION reads them (RLS decides which): newest first, for these students. */
export async function readPlans(db: SkDb, studentIds: readonly string[], limit = 200): Promise<DbRow[]> {
  const ids = [...new Set(studentIds)].filter(Boolean);
  if (!ids.length) return [];
  const { data, error } = await db.from("sk_learn_plans").select("*").in("student_id", ids.slice(0, 500)).order("created_at", { ascending: false }).limit(limit);
  return error ? [] : ((data ?? []) as DbRow[]);
}

/** The weekly sweep's cap: students drafted per run. */
export const WEEKLY_MAX_STUDENTS = 100;

/**
 * The weekly plan (Sundays, from the daily lifecycle cron — no new Vercel
 * cron): every student who practised in the last 7 days gets a kit-less plan
 * over all her kits, unless one is already open. Off with SK_LEARN_PLANS=off.
 * `recent` lists the students (a gte read the caller makes on the real client).
 */
export async function runWeeklyPlans(deps: DraftDeps, recent: readonly string[]): Promise<{ drafted: number; skipped: number }> {
  let drafted = 0;
  let skipped = 0;
  for (const studentId of [...new Set(recent)].slice(0, WEEKLY_MAX_STUDENTS)) {
    const r = await draftPlan(deps, { studentId, kitId: null, trigger: "weekly" });
    if (r.outcome === "drafted") drafted += 1;
    else skipped += 1;
  }
  return { drafted, skipped };
}

export const learnPlansOn = (): boolean => (process.env.SK_LEARN_PLANS ?? "").trim().toLowerCase() !== "off";
