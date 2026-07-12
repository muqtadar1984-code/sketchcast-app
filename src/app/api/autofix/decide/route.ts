import { createAdminClient } from "@/utils/supabase/admin";
import { autofixEnabled } from "@/utils/flags";
import { verifyDecisionToken } from "@/utils/autofix/token";
import { mergePr, closePr, deleteBranch } from "@/utils/autofix/github";

export const runtime = "nodejs";

// The founder taps ✅/✖ in the email. The signed token IS the authentication (no
// session — same shape as /invite/[token]/accept). To survive email-scanner PREFETCH
// (which would GET the link automatically), GET only shows a confirmation page; the
// real merge/close happens on the form POST. Single-use is enforced by the run's
// decided_at column. Approve merges (only if CI passed) → prod deploys; Reject closes.

function page(title: string, emoji: string, body: string, tone: "ok" | "bad" | "warn" = "ok", form?: { token: string; label: string }): Response {
  const color = tone === "ok" ? "#0C8175" : tone === "bad" ? "#B42318" : "#9A6400";
  const button = form
    ? `<form method="POST" action="/api/autofix/decide?token=${encodeURIComponent(form.token)}" style="margin-top:18px">
         <button type="submit" style="background:${color};color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer">${form.label}</button>
       </form>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex"/>
<title>${title} — SketchCast Auto-fix</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#FCFCFA;color:#14181F;margin:0;line-height:1.6}
.wrap{max-width:520px;margin:0 auto;padding:56px 24px}.card{background:#fff;border:1px solid #E6E8E4;border-radius:16px;padding:28px}
h1{font-size:22px;margin:8px 0 4px}.e{font-size:40px}.m{color:#5B6470;font-size:15px}a{color:#0C8175}.b{color:${color};font-weight:600}</style></head>
<body><div class="wrap"><div class="card"><div class="e">${emoji}</div><h1 class="b">${title}</h1>
<p class="m">${body}</p>${button}<p class="m" style="margin-top:16px"><a href="https://app.sketchcast.app/console/issues">Open the console →</a></p></div></div></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

type Run = { id: string; issue_id: string; status: string; ci_passed: boolean | null; pr_number: number | null; branch: string | null; decided_at: string | null };

async function loadRun(claims: { run: string }): Promise<Run | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("autofix_runs")
    .select("id, issue_id, status, ci_passed, pr_number, branch, decided_at")
    .eq("id", claims.run)
    .maybeSingle();
  return (data as Run) ?? null;
}

// GET = show a confirmation page (safe against prefetch). Never mutates.
export async function GET(request: Request) {
  if (!autofixEnabled()) return page("Not available", "🔒", "Auto-fix is turned off.", "warn");
  const token = new URL(request.url).searchParams.get("token") || "";
  const claims = verifyDecisionToken(token);
  if (!claims) return page("Invalid or expired link", "⚠️", "This approval link is invalid or has expired. Act on the issue from the console instead.", "bad");
  const run = await loadRun(claims);
  if (!run) return page("Not found", "⚠️", "That auto-fix run no longer exists.", "bad");
  if (run.decided_at) return page("Already decided", "✔️", `This fix was already ${run.status === "merged" ? "approved & released" : run.status}.`, "warn");

  if (claims.action === "reject") {
    return page("Reject this fix?", "✖", "Confirm to close the pull request and delete its branch. Nothing will be released.", "warn", { token, label: "Reject & close the PR" });
  }
  if (!run.ci_passed) return page("Can’t release", "❌", "CI hasn’t passed for this fix, so it can’t be released. Open the PR to review it.", "bad");
  if (!run.pr_number) return page("No pull request", "⚠️", "This run has no open pull request to merge.", "bad");
  return page("Approve & release?", "🚀", "Confirm to squash-merge this fix to <b>main</b> — production will deploy immediately.", "ok", { token, label: "✅ Approve & release to production" });
}

// POST = actually perform the decision (email scanners don't submit forms).
export async function POST(request: Request) {
  if (!autofixEnabled()) return page("Not available", "🔒", "Auto-fix is turned off.", "warn");
  const token = new URL(request.url).searchParams.get("token") || "";
  const claims = verifyDecisionToken(token);
  if (!claims) return page("Invalid or expired link", "⚠️", "This approval link is invalid or has expired.", "bad");

  const admin = createAdminClient();
  const run = await loadRun(claims);
  if (!run) return page("Not found", "⚠️", "That auto-fix run no longer exists.", "bad");
  if (run.decided_at) return page("Already decided", "✔️", `This fix was already ${run.status === "merged" ? "approved & released" : run.status}. Nothing changed.`, "warn");

  // Claim the decision atomically (only the first writer wins) — single-use guard.
  const claimed = await admin
    .from("autofix_runs")
    .update({ decided_at: new Date().toISOString(), decided_via: "email_link" })
    .eq("id", run.id)
    .is("decided_at", null)
    .select("id");
  if (!claimed.data || claimed.data.length === 0) {
    return page("Already decided", "✔️", "This link was just used. Nothing changed.", "warn");
  }
  const audit = (detail: Record<string, unknown>) =>
    admin.from("platform_audit_log").insert({ actor_id: null, action: `autofix_${claims.action}`, target_kind: "issue", target_id: run.issue_id, detail: { run_id: run.id, ...detail } });

  if (claims.action === "reject") {
    if (run.pr_number) await closePr(run.pr_number);
    if (run.branch) await deleteBranch(run.branch);
    await admin.from("autofix_runs").update({ status: "rejected" }).eq("id", run.id);
    await admin.from("platform_issues").update({ status: "triaged", resolution_note: "Auto-fix rejected by founder." }).eq("id", run.issue_id);
    await audit({ pr_number: run.pr_number });
    return page("Rejected", "🗑️", "The pull request has been closed and its branch deleted. Nothing was released.", "warn");
  }

  // Approve — CI + PR guards were shown on GET, re-check here (defense in depth).
  if (!run.ci_passed || !run.pr_number) {
    await admin.from("autofix_runs").update({ decided_at: null, decided_via: null }).eq("id", run.id); // un-claim: nothing happened
    return page("Can’t release", "❌", "CI hasn’t passed (or there is no PR), so this can’t be released.", "bad");
  }
  const merged = await mergePr(run.pr_number, `Auto-fix: resolve reported issue (run ${run.id.slice(0, 8)})`);
  if (merged.ok) {
    await admin.from("autofix_runs").update({ status: "merged" }).eq("id", run.id);
    await admin.from("platform_issues").update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Auto-fix approved & merged to production." }).eq("id", run.issue_id);
    await audit({ pr_number: run.pr_number, result: "merged" });
    return page("Approved & released", "🚀", "The fix has been merged to <b>main</b> — production is deploying now. The issue is marked resolved.", "ok");
  }
  if (merged.unconfigured) {
    await admin.from("autofix_runs").update({ status: "approved" }).eq("id", run.id);
    await audit({ pr_number: run.pr_number, result: "approved_unconfigured" });
    return page("Approved", "✅", "Recorded your approval, but the GitHub token isn’t configured — merge the PR manually.", "warn");
  }
  // Hard failure (e.g. merge conflict): un-claim so you can retry after resolving it.
  await admin.from("autofix_runs").update({ status: "error", error: merged.error ?? `HTTP ${merged.status}`, decided_at: null, decided_via: null }).eq("id", run.id);
  return page("Merge failed", "❌", `GitHub refused the merge (${merged.error ? merged.error.slice(0, 120) : "possibly a conflict"}). The PR is still open — merge it manually or re-request a fix.`, "bad");
}
