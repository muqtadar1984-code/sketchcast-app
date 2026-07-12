import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createAdminClient } from "@/utils/supabase/admin";
import { autofixEnabled } from "@/utils/flags";
import { signDecisionToken } from "@/utils/autofix/token";
import { sendAutofixEmail } from "@/utils/autofix/email";

export const runtime = "nodejs";

// Called by the autofix GitHub Action once it has opened (or failed to open) a PR.
// Authenticated by a shared secret header (the Action holds AUTOFIX_CALLBACK_SECRET
// as a repo secret) — constant-time compared. Updates the run and emails the founder
// the signed Approve/Reject links. This is the ONLY thing that mints those links.

function secretOk(header: string | null): boolean {
  const want = process.env.AUTOFIX_CALLBACK_SECRET || "";
  if (!want || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!autofixEnabled()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!secretOk(request.headers.get("x-autofix-secret"))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let b: {
    run_key?: string; pr_number?: number; pr_url?: string;
    ci_passed?: boolean; sensitive?: boolean; summary?: string; files_changed?: string[];
  };
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const runKey = (b.run_key ?? "").trim();
  if (!runKey) return NextResponse.json({ error: "run_key required." }, { status: 400 });

  const admin = createAdminClient();
  const { data: run } = await admin
    .from("autofix_runs")
    .select("id, issue_id, decided_at, platform_issues(title)")
    .eq("run_key", runKey)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  if (run.decided_at) return NextResponse.json({ error: "Run already decided." }, { status: 409 });

  const ciPassed = b.ci_passed === true;
  const sensitive = b.sensitive === true;
  await admin.from("autofix_runs").update({
    status: ciPassed ? "pr_open" : "ci_failed",
    pr_number: typeof b.pr_number === "number" ? b.pr_number : null,
    pr_url: (b.pr_url ?? "").slice(0, 400) || null,
    ci_passed: ciPassed,
    sensitive,
    summary: (b.summary ?? "").slice(0, 4000) || null,
    files_changed: Array.isArray(b.files_changed) ? b.files_changed.slice(0, 100) : null,
  }).eq("id", run.id);

  const base = process.env.AUTOFIX_APP_URL || "https://app.sketchcast.app";
  let approveUrl: string | null = null;
  let rejectUrl = `${base}/api/autofix/decide`;
  try {
    if (ciPassed) approveUrl = `${base}/api/autofix/decide?token=${signDecisionToken(run.id, "approve")}`;
    rejectUrl = `${base}/api/autofix/decide?token=${signDecisionToken(run.id, "reject")}`;
  } catch (e) {
    console.error("autofix token signing failed (AUTOFIX_TOKEN_SECRET?):", e);
  }

  const issue = (run.platform_issues as unknown as { title: string } | null) ?? null;
  const emailed = await sendAutofixEmail({
    issueTitle: issue?.title ?? "Reported issue",
    issueId: run.issue_id,
    prNumber: typeof b.pr_number === "number" ? b.pr_number : null,
    prUrl: b.pr_url ?? null,
    ciPassed,
    sensitive,
    summary: b.summary ?? "",
    approveUrl,
    rejectUrl,
  });

  await admin.from("platform_audit_log").insert({
    actor_id: null,
    action: "autofix_pr_opened",
    target_kind: "issue",
    target_id: run.issue_id,
    detail: { run_id: run.id, pr_number: b.pr_number ?? null, ci_passed: ciPassed, sensitive, emailed },
  });

  return NextResponse.json({ ok: true, emailed });
}
