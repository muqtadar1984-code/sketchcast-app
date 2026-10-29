// SK S5 slice B — the 60/day cap and the DPDP audit of a LEADER school read
// (design 2026-10-29, decision 1; acceptance 1: "the 60/day cap and
// analytics_access_log are preserved").
//
// A turn that runs a leader school read — any `school.*` capability, or an S0
// read (learners.risk, assignments.status, timetable.now_next) in its school
// or scope mode — is metered ONCE, before the read runs:
//
//   1. INSERT FIRST: one analytics_access_log row (scope 'sk_school',
//      target_kind 'sk_capability', detail {capability, mode, grades?, turnId};
//      no learner names), under the USER-SESSION client — aal_insert_self
//      (actor_id = auth.uid()) allows it. If the write fails, the read is
//      REFUSED (fail closed): the School Briefing panel's version only warned,
//      so its cap leaked whenever the log write failed.
//   2. THEN COUNT: today's rows (UTC midnight, as the briefing) for this actor
//      with scope IN ('sk_school', 'school_briefing') — one shared counter for
//      SK and the panel — up to and including this row. Over 60 → refused; the
//      row stays, as the audit of the refused attempt.
//
// One row per turn: the turn route's gate (schoolReadGate) memoises the
// outcome, so a turn that runs two leader reads writes one row; a replayed
// turn id (the client's resend) finds its row and writes none.
//
// target_id is a uuid column (0009), so the capability name lives in
// detail.capability, not target_id.
//
// Own-class teacher reads (leaderScope mode "own") are never metered.

import type { SkCapabilityResult, SkContext, SkSessionDb } from "./types";
import { leaderScope } from "@/sk/capabilities/leader-scope";
import { lineFor } from "./lines";
import { SM_ANALYTICS_OFF, SM_AUDIT_FAILED, SM_CAP_REACHED } from "./school-meter-lines";

export const SK_SCHOOL_SCOPE = "sk_school";
/** The School Briefing panel's scope (api/school-assistant): the same counter. */
export const SCHOOL_BRIEFING_SCOPE = "school_briefing";
export const SCHOOL_READ_DAILY_CAP = 60;
export const SK_SCHOOL_TARGET_KIND = "sk_capability";

/** The S0 reads with a leader (school / scope) mode — slice A. */
export const SK_LEADER_S0_READS: readonly string[] = ["learners.risk", "assignments.status", "timetable.now_next"];

/** The refusal errors a gated read returns (the turn route surfaces their line). */
export const SCHOOL_READ_REFUSALS: ReadonlySet<string> = new Set(["analytics_off", "school_cap", "school_audit_failed"]);

export type SchoolRead = { capability: string; mode: "school" | "scope"; grades?: string[] };

/** Is running `name` now a leader school read? Pure. null = not metered (an
 *  own-class teacher read, a parent's, a student's, anything else). */
export function schoolReadOf(ctx: SkContext, name: string, args: Record<string, unknown> = {}): SchoolRead | null {
  let ls;
  if (name.startsWith("school.")) ls = leaderScope(ctx, { hatless: "leader" });
  else if (SK_LEADER_S0_READS.includes(name)) ls = leaderScope(ctx);
  else return null;
  if (ls.mode === "own") return null;
  const asked = typeof args.grade === "string" && args.grade.trim() ? [args.grade.trim().slice(0, 20)] : undefined;
  const grades = asked ?? (ls.mode === "scope" ? (ls.grades ?? []).slice(0, 20) : undefined);
  return { capability: name, mode: ls.mode, ...(grades && grades.length ? { grades } : {}) };
}

/** UTC midnight of `now` — the briefing's day boundary. */
export function utcDayStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export type SchoolMeterDetail = SchoolRead & { turnId: string };

export type SchoolMeterOutcome =
  | { ok: true; count: number; inserted: boolean }
  | { ok: false; reason: "audit_failed" | "cap"; count?: number; inserted: boolean; summary: string };

type Res<T> = { data: T | null; error: { message?: string } | null; count?: number | null };

/**
 * THE meter. Insert the audit row (unless this turn id already has one), then
 * count today's shared school-read rows up to it. Fail closed on any error.
 */
export async function meterSchoolRead(ctx: SkContext, session: SkSessionDb, detail: SchoolMeterDetail, now: Date = new Date()): Promise<SchoolMeterOutcome> {
  const me = ctx.user.id;
  const locale = ctx.user.locale;
  const auditFailed = (inserted: boolean): SchoolMeterOutcome => ({ ok: false, reason: "audit_failed", inserted, summary: lineFor(SM_AUDIT_FAILED, locale) });
  const turnId = (detail.turnId ?? "").trim().slice(0, 80);
  if (!turnId) return auditFailed(false);
  try {
    // A replayed turn id finds its own row: no second insert.
    const prior = (await session
      .from("analytics_access_log")
      .select("id, created_at")
      .eq("actor_id", me)
      .eq("scope", SK_SCHOOL_SCOPE)
      .eq("detail->>turnId", turnId)
      .order("created_at", { ascending: true })
      .limit(1)) as Res<Array<{ id: string; created_at: string }>>;
    if (prior.error) return auditFailed(false);
    let at = prior.data?.[0]?.created_at ?? null;
    let inserted = false;
    if (!at) {
      const ins = (await session
        .from("analytics_access_log")
        .insert({
          actor_id: me,
          actor_role: ctx.user.role,
          school_id: ctx.user.schoolId,
          scope: SK_SCHOOL_SCOPE,
          target_kind: SK_SCHOOL_TARGET_KIND,
          target_id: null,
          detail: { capability: detail.capability, mode: detail.mode, ...(detail.grades?.length ? { grades: detail.grades } : {}), turnId },
        })
        .select("id, created_at")
        .single()) as Res<{ id: string; created_at: string }>;
      if (ins.error || !ins.data?.created_at) return auditFailed(false);
      at = ins.data.created_at;
      inserted = true;
    }
    const counted = (await session
      .from("analytics_access_log")
      .select("id", { count: "exact", head: true })
      .eq("actor_id", me)
      .in("scope", [SK_SCHOOL_SCOPE, SCHOOL_BRIEFING_SCOPE])
      .gte("created_at", utcDayStart(now).toISOString())
      .lte("created_at", at)) as Res<unknown>;
    if (counted.error || typeof counted.count !== "number") return auditFailed(inserted);
    const count = counted.count;
    if (count > SCHOOL_READ_DAILY_CAP) return { ok: false, reason: "cap", count, inserted, summary: lineFor(SM_CAP_REACHED, locale, { cap: SCHOOL_READ_DAILY_CAP }) };
    return { ok: true, count, inserted };
  } catch {
    return auditFailed(false);
  }
}

/** The runner's pre-read hook (RunnerDeps.schoolRead): null = run the read. */
export type SchoolReadHook = (name: string, args: Record<string, unknown>) => Promise<SkCapabilityResult | null>;

/**
 * The turn route's gate: one per turn. For a leader school read it applies
 * the analytics gate (off → the fixed line; nothing metered), then meters the
 * turn ONCE (memoised: a second leader read in the same turn reuses the
 * outcome). Anything else passes straight through.
 */
export function schoolReadGate(ctx: SkContext, session: SkSessionDb, turnId: string | null, now: Date = new Date()): SchoolReadHook {
  let metered: Promise<SchoolMeterOutcome> | null = null;
  return async (name, args) => {
    const read = schoolReadOf(ctx, name, args ?? {});
    if (!read) return null;
    if (ctx.flags.analytics !== true) return { ok: false, summary: lineFor(SM_ANALYTICS_OFF, ctx.user.locale), error: "analytics_off", facts: [], entities: [] };
    metered ??= meterSchoolRead(ctx, session, { ...read, turnId: turnId ?? "" }, now);
    const o = await metered;
    if (o.ok) return null;
    return { ok: false, summary: o.summary, error: o.reason === "cap" ? "school_cap" : "school_audit_failed", facts: [], entities: [] };
  };
}

/** The analytics-off answer a leader-mode handler gives on its own (no gate). */
export function analyticsOffResult(ctx: SkContext): SkCapabilityResult {
  return { ok: false, summary: lineFor(SM_ANALYTICS_OFF, ctx.user.locale), error: "analytics_off", facts: [], entities: [] };
}
