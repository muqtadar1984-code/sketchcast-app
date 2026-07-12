import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPlatformAdminRequest } from "@/utils/platform-admin";
import { autofixEnabled } from "@/utils/flags";
import { repositoryDispatch, autofixRepoConfigured } from "@/utils/autofix/github";

export const runtime = "nodejs";

// Staff-only: fire an auto-fix attempt at a reported issue. Creates the ledger row,
// then kicks the GitHub Action (repository_dispatch) with a SANITISED brief — never
// raw PII, since the repo (and its Action logs) are public. The Action writes a fix
// on a branch, opens a PR, and calls back /api/autofix/pr-opened. Non-staff → 404.

const DAILY_CAP = 20; // backstop against runaway dispatch

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

  // One active run per issue.
  const { data: existing } = await admin
    .from("autofix_runs")
    .select("id, status")
    .eq("issue_id", issueId)
    .in("status", ["dispatched", "pr_open", "approved"])
    .maybeSingle();
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
  if (iErr || !run) return NextResponse.json({ error: iErr?.message ?? "Could not start." }, { status: 500 });

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
