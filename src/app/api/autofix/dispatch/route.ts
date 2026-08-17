import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPlatformAdminRequest } from "@/utils/platform-admin";
import { autofixEnabled } from "@/utils/flags";
import { repositoryDispatch, autofixRepoConfigured } from "@/utils/autofix/github";
import { workerScopeRefusal } from "@/utils/autofix/scope";

export const runtime = "nodejs";

// Staff-only: fire an auto-fix attempt at a reported issue. Creates the ledger row,
// then kicks the GitHub Action (repository_dispatch) with a SANITISED brief — never
// raw PII, since the repo (and its Action logs) are public. The Action writes a fix
// on a branch, opens a PR, and calls back /api/autofix/pr-opened. Non-staff → 404.

const DAILY_CAP = 20; // backstop against runaway dispatch

// The autofix_runs table ships in migration 0039. Before it runs, PostgREST reports
// the table as missing from its schema cache (PGRST205) — surface that as a friendly
// "not provisioned" 503 instead of leaking raw PostgREST internals.
function dbErrorResponse(err: { code?: string; message?: string }) {
  if (err.code === "PGRST205" || /schema cache/i.test(err.message ?? "")) {
    return NextResponse.json(
      { error: "Auto-fix isn't provisioned yet — migration 0039 hasn't been run. See docs/AUTOFIX.md." },
      { status: 503 },
    );
  }
  return NextResponse.json({ error: "Database error — try again." }, { status: 500 });
}

// Scrub obvious PII before anything leaves for a public GitHub Action log.
function sanitize(s: string | null | undefined, max = 1500): string {
  return (s ?? "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b\d{10,}\b/g, "[number]")
    .slice(0, max);
}

export async function POST(request: Request) {
  if (!autofixEnabled()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const staff = await isPlatformAdminRequest();
  if (!staff) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: { issueId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const issueId = (body.issueId ?? "").trim();
  if (!issueId) return NextResponse.json({ error: "issueId is required." }, { status: 400 });

  const admin = createAdminClient();

  const { data: issue } = await admin
    .from("platform_issues")
    .select("id, title, description, category, severity, diagnosis")
    .eq("id", issueId)
    .maybeSingle();
  if (!issue) return NextResponse.json({ error: "Issue not found." }, { status: 404 });

  // App-repo scope: the Action can only change THIS repo. Worker-pipeline
  // categories (generation failures, content quality, chapter detection) can't
  // be fixed from here — refuse before any run row exists instead of writing a
  // doomed PR (live run ee0fb99628f13098: a generation_failed issue produced
  // junk app PR #24). Worker autofix is Phase 2 — docs/AUTOFIX.md.
  const refusal = workerScopeRefusal(issue.category);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });

  // One active run per issue. limit(1): two concurrent dispatches can both
  // pass this check-then-insert, and a bare maybeSingle() would then error
  // (PGRST116, multiple rows) on every LATER attempt — bricking the issue.
  const { data: existing, error: eErr } = await admin
    .from("autofix_runs")
    .select("id, status")
    .eq("issue_id", issueId)
    .in("status", ["dispatched", "pr_open", "approved"])
    .limit(1)
    .maybeSingle();
  if (eErr) return dbErrorResponse(eErr);
  if (existing) {
    return NextResponse.json({ error: "An auto-fix is already in progress for this issue." }, { status: 409 });
  }

  // Daily cap.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("autofix_runs")
    .select("id", { count: "exact", head: true })
    .gte("created_at", dayAgo);
  if ((count ?? 0) >= DAILY_CAP) {
    return NextResponse.json({ error: "Daily auto-fix limit reached." }, { status: 429 });
  }

  const runKey = crypto.randomBytes(8).toString("hex");
  const branch = `autofix/${runKey}`;
  const diagnosis = (issue.diagnosis ?? {}) as { user_message?: string; recommended_action?: string };
  const brief = [
    `Reported issue (category: ${issue.category || "other"}, severity: ${issue.severity || "normal"}).`,
    `Title: ${sanitize(issue.title, 200)}`,
    issue.description ? `Report: ${sanitize(issue.description)}` : "",
    diagnosis.user_message ? `Diagnosis: ${sanitize(diagnosis.user_message)}` : "",
    diagnosis.recommended_action ? `Suggested direction: ${sanitize(diagnosis.recommended_action)}` : "",
  ].filter(Boolean).join("\n");

  const { data: run, error: iErr } = await admin
    .from("autofix_runs")
    .insert({ issue_id: issueId, run_key: runKey, branch, status: "dispatched", repo: "sketchcast-app" })
    .select("id")
    .single();
  if (iErr) return dbErrorResponse(iErr);
  if (!run) return NextResponse.json({ error: "Database error — try again." }, { status: 500 });

  const dispatch = await repositoryDispatch("autofix", {
    run_key: runKey,
    branch,
    issue_id: issueId,
    title: sanitize(issue.title, 120),
    brief,
  });

  if (!dispatch.ok && !dispatch.unconfigured) {
    await admin.from("autofix_runs").update({ status: "error", error: dispatch.error ?? `HTTP ${dispatch.status}` }).eq("id", run.id);
    return NextResponse.json({ error: "GitHub dispatch failed.", detail: dispatch.error }, { status: 502 });
  }

  await admin.from("platform_issues").update({ status: "in_progress" }).eq("id", issueId);
  await admin.from("platform_audit_log").insert({
    actor_id: staff.id,
    action: "autofix_dispatch",
    target_kind: "issue",
    target_id: issueId,
    detail: { run_id: run.id, run_key: runKey, branch, dispatched: dispatch.ok },
  });

  return NextResponse.json({
    ok: true,
    runId: run.id,
    dispatched: dispatch.ok,
    note: dispatch.unconfigured || !autofixRepoConfigured()
      ? "Run recorded, but GITHUB_AUTOFIX_TOKEN isn't set — the fix workflow won't start until it is."
      : "Fix workflow started; you'll get an email when the PR is ready.",
  });
}
