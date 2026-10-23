import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { decisionPatch, isDecision, retryPatch, type FixAgentSettings, type FixCase } from "@/utils/fixes/fix-cases";
import { audit, bad, conflict, dbError, notFound, readJson, uuid, uuidList } from "../lib";

export const runtime = "nodejs";

// The Fix Agent's buttons on Library → Fixes (migration 0151, Phase 1:
// failed translations). Admins only (`publish`): approving a case lets the
// worker spend money on a retry.
//
//   {action: 'approve' | 'reject', id, note?}  the founder's decision on ONE
//       case: a single guarded update (status = 'proposed' → approved |
//       rejected) read back, so a second click — or a decision landing after
//       the worker moved the case on — is a 409, never an overwrite. The
//       WORKER queues the retry from 'approved' (fix_case_enqueue); this route
//       never touches `jobs`.
//   {action: 'retry', id} | {action: 'retry_all'}  a case the agent gave up
//       on (needs_founder) goes back to 'approved' with its last proposal,
//       once its cause is fixed; the round it ended in is kept in history.
//       The worker queues each one, one translation at a time.
//   {action: 'approve_many' | 'reject_many' | 'retry_many', ids, note?}  the
//       board's bulk buttons (Approve all N, the selection bar): 1–100 ids,
//       every one a uuid (one bad id → 400, nothing written). Each id is the
//       single action's own guarded update — approve / reject on 'proposed'
//       through decisionPatch, retry read-then-update on 'needs_founder'
//       through retryPatch — so a case that moved on is SKIPPED, never
//       overwritten. Answers {done, skipped}; ONE audit row per press
//       (library_fix_case_<action> with {ids, count}).
//   {action: 'on' | 'off'}  merges {enabled} into platform_settings
//       'fix_agent' (read-merge-update, like the Auto Translate Agent's
//       controls); the worker reads it every tick.
//
// One platform_audit_log row per press (library_fix_case_* / library_fix_agent_*).

type Body = { action?: unknown; id?: unknown; ids?: unknown; note?: unknown };

const BULK_MAX = 100;
type BulkAction = "approve_many" | "reject_many" | "retry_many";
const isBulk = (v: unknown): v is BulkAction => v === "approve_many" || v === "reject_many" || v === "retry_many";

const MIGRATION = "0151_fix_agent.sql";
const NEEDS_MIGRATION = "The Fix Agent needs migration 0151 — apply it first.";

/** fix_cases is not in this database (42P01 / PostgREST's schema-cache miss). */
function fixCasesMissing(err: { code?: string; message?: string }): boolean {
  return err.code === "42P01" || err.code === "PGRST205" || /fix_cases/.test(err.message ?? "");
}

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("publish");
  if (!m) return notFound();
  const body = await readJson<Body>(request);
  if (!body || typeof body !== "object") return bad("Invalid JSON.");
  const action = body.action;
  const now = new Date().toISOString();

  if (isDecision(action)) {
    const id = uuid(body.id);
    if (!id) return bad("A case id is needed.");
    const patch = decisionPatch(action, m.id, body.note, now);
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("fix_cases")
      .update(patch)
      .eq("id", id)
      .eq("status", "proposed")
      .select("id, round, status");
    if (error) return fixCasesMissing(error) ? conflict(NEEDS_MIGRATION, { migration: MIGRATION }) : dbError(error);
    const row = ((data ?? []) as { id: string; round?: number | null }[])[0];
    if (!row) return conflict("This case is no longer waiting for a decision.");
    await audit(admin, m.id, `fix_case_${action}`, "fix_case", id, { note: patch.decision_note, round: row.round ?? null });
    return NextResponse.json({ ok: true, action, id, status: patch.status });
  }

  if (action === "retry" || action === "retry_all") {
    const admin = createAdminClient();
    let q = admin.from("fix_cases").select("*").eq("status", "needs_founder");
    if (action === "retry") {
      const id = uuid(body.id);
      if (!id) return bad("A case id is needed.");
      q = q.eq("id", id);
    }
    const { data, error } = await q.limit(200);
    if (error) return fixCasesMissing(error) ? conflict(NEEDS_MIGRATION, { migration: MIGRATION }) : dbError(error);
    const rows = (data ?? []) as FixCase[];
    if (action === "retry" && rows.length === 0) return conflict("This case is not waiting for you any more.");
    const retried: string[] = [];
    for (const row of rows) {
      // guarded on the status the row was read in: a case the worker or a
      // second click moved since is left alone
      const up = await admin
        .from("fix_cases")
        .update(retryPatch(row, m.id, now))
        .eq("id", row.id)
        .eq("status", "needs_founder")
        .select("id");
      if (up.error) return dbError(up.error);
      if ((up.data ?? []).length) retried.push(row.id);
    }
    await audit(admin, m.id, "fix_case_retry", "fix_case", action === "retry" ? retried[0] ?? null : null, {
      count: retried.length,
      ids: retried,
    });
    return NextResponse.json({ ok: true, action, retried: retried.length });
  }

  if (isBulk(action)) {
    const list = uuidList(body.ids, BULK_MAX);
    if (!list || "invalid" in list || list.ids.length === 0) return bad(`Between 1 and ${BULK_MAX} case ids are needed.`);
    const ids = list.ids;
    const admin = createAdminClient();
    const done: string[] = [];
    let failure: { code?: string; message?: string } | null = null;
    const decision = action === "approve_many" ? "approve" : action === "reject_many" ? "reject" : null;
    const patch = decision ? decisionPatch(decision, m.id, body.note, now) : null;
    for (const id of ids) {
      if (patch) {
        const up = await admin.from("fix_cases").update(patch).eq("id", id).eq("status", "proposed").select("id");
        if (up.error) {
          failure = up.error;
          break;
        }
        if ((up.data ?? []).length) done.push(id);
        continue;
      }
      // retry: read the row in the status it is retried from, then the
      // guarded update (its history needs the row)
      const read = await admin.from("fix_cases").select("*").eq("id", id).eq("status", "needs_founder").limit(1);
      if (read.error) {
        failure = read.error;
        break;
      }
      const row = ((read.data ?? []) as FixCase[])[0];
      if (!row) continue;
      const up = await admin.from("fix_cases").update(retryPatch(row, m.id, now)).eq("id", id).eq("status", "needs_founder").select("id");
      if (up.error) {
        failure = up.error;
        break;
      }
      if ((up.data ?? []).length) done.push(id);
    }
    if (failure && !done.length) return fixCasesMissing(failure) ? conflict(NEEDS_MIGRATION, { migration: MIGRATION }) : dbError(failure);
    await audit(admin, m.id, `fix_case_${action}`, "fix_case", null, {
      ids: done,
      count: done.length,
      ...(action === "reject_many" ? { note: patch?.decision_note ?? null } : {}),
    });
    if (failure) return dbError(failure);
    return NextResponse.json({ ok: true, action, done: done.length, skipped: ids.length - done.length });
  }

  if (action === "on" || action === "off") {
    const admin = createAdminClient();
    const { data, error } = await admin.from("platform_settings").select("value").eq("key", "fix_agent").maybeSingle();
    if (error) return dbError(error);
    if (!data) return conflict(NEEDS_MIGRATION, { migration: MIGRATION });
    const patch = { enabled: action === "on" };
    const value: FixAgentSettings = { ...((data.value ?? {}) as FixAgentSettings), ...patch };
    const up = await admin.from("platform_settings").update({ value, updated_at: now }).eq("key", "fix_agent");
    if (up.error) return dbError(up.error);
    await audit(admin, m.id, `fix_agent_${action}`, "platform_setting", null, { key: "fix_agent", patch });
    return NextResponse.json({ ok: true, action, settings: value });
  }

  return bad("Unknown action.");
}
