import { notFound } from "next/navigation";
import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import TriageForm from "./triage-form";
import AutofixPanel, { type AutofixRun } from "./autofix-panel";

// One issue: full context, reporter profile, and lifecycle controls.

export const dynamic = "force-dynamic";

type Issue = {
  id: string;
  reporter_id: string | null;
  reporter_role: string | null;
  school_id: string | null;
  category: string;
  severity: string;
  status: string;
  title: string;
  description: string | null;
  context: { url?: string; user_agent?: string; recent_job_errors?: string[]; error?: string } | null;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  // Support-agent columns (migration 0020; absent pre-migration).
  trigger_source?: string | null;
  generation_id?: string | null;
  book_id?: string | null;
  diagnosis?: {
    category?: string;
    confidence?: number;
    user_message?: string;
    recommended_action?: string;
  } | null;
  agent_action?: string | null;
};

export default async function ConsoleIssueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = createAdminClient();

  const { data: issueRaw } = await admin.from("platform_issues").select("*").eq("id", id).maybeSingle();
  if (!issueRaw) notFound();
  const issue = issueRaw as Issue;

  let reporter: { name: string; email: string; school: string | null } | null = null;
  if (issue.reporter_id) {
    const { data: p } = await admin
      .from("profiles")
      .select("full_name, username, school_id")
      .eq("id", issue.reporter_id)
      .maybeSingle();
    let email = "";
    try {
      const { data: u } = await admin.auth.admin.getUserById(issue.reporter_id);
      email = u?.user?.email ?? "";
    } catch {
      // profile-only
    }
    let school: string | null = null;
    if (p?.school_id) {
      const { data: s } = await admin.from("schools").select("name").eq("id", p.school_id).maybeSingle();
      school = (s?.name as string) ?? null;
    }
    reporter = { name: p?.full_name || p?.username || "User", email, school };
  }

  const ctx = issue.context ?? {};

  // Latest auto-fix run for this issue (drives the Auto-fix panel). Best-effort:
  // pre-0039 the table doesn't exist yet, so a failure just hides the panel.
  let autofixRun: AutofixRun = null;
  try {
    const { data: r } = await admin
      .from("autofix_runs")
      .select("status, pr_url, pr_number, ci_passed, sensitive, decided_via, created_at")
      .eq("issue_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    autofixRun = (r as AutofixRun) ?? null;
  } catch {
    // 0039 not applied yet
  }

  return (
    <main className="max-w-4xl mx-auto px-6 py-10">
      <p className="mb-4 text-sm">
        <Link href="/console/issues" className="text-[#0C8175] hover:underline">← Issues</Link>
      </p>
      <h1 className="text-3xl mb-2">{issue.title}</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-sm text-[#5B6470] mb-6">
        <span className="chip font-sans bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal mr-2">{issue.category}</span>
        reported <span className="tabular">{new Date(issue.created_at).toLocaleString()}</span>
        {reporter && (
          <>
            {" "}by <span className="font-medium text-[#14181F]">{reporter.name}</span>
            {reporter.email && <> ({reporter.email})</>} · {issue.reporter_role ?? "?"}
            {reporter.school && <> · {reporter.school}</>}
          </>
        )}
      </p>

      <div className="space-y-4 mb-6">
        {issue.description && (
          <div className="card p-5">
            <h2 className="font-display font-medium text-lg mb-2">Description</h2>
            <p className="text-sm whitespace-pre-wrap">{issue.description}</p>
          </div>
        )}
        <div className="card p-5 text-sm space-y-1.5">
          <h2 className="font-display font-medium text-lg mb-2">Captured context</h2>
          <p><span className="text-[#5B6470]">Page:</span> {ctx.url || "—"}</p>
          <p className="break-words"><span className="text-[#5B6470]">Browser:</span> {ctx.user_agent || "—"}</p>
          {(ctx.recent_job_errors ?? []).length > 0 && (
            <div>
              <span className="text-[#5B6470]">Recent job errors:</span>
              <ul className="mt-1 space-y-1">
                {ctx.recent_job_errors!.map((e, i) => (
                  <li key={i} className="text-[#9A6400] break-words">· {e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {issue.diagnosis && (
          <div className="card p-5 text-sm space-y-1.5 border-l-4 border-l-[#1FB8A6]">
            <h2 className="font-display font-medium text-lg mb-2">
              AI diagnosis
              {issue.trigger_source === "auto" && (
                <span className="chip font-sans bg-[#E2F4F1] text-[#0C8175] ml-2 align-middle">auto-triggered</span>
              )}
            </h2>
            <p>
              <span className="text-[#5B6470]">Root cause:</span>{" "}
              <span className="font-medium">{issue.diagnosis.category ?? "—"}</span>
              {typeof issue.diagnosis.confidence === "number" && (
                <span className="text-[#5B6470]"> · confidence {(issue.diagnosis.confidence * 100).toFixed(0)}%</span>
              )}
            </p>
            <p><span className="text-[#5B6470]">Action taken:</span> {issue.agent_action ?? "—"}</p>
            {issue.diagnosis.user_message && (
              <p><span className="text-[#5B6470]">Told the user:</span> {issue.diagnosis.user_message}</p>
            )}
            {issue.generation_id && (
              <p className="text-xs text-[#98A0A9]">generation {issue.generation_id}{issue.book_id ? ` · book ${issue.book_id}` : ""}</p>
            )}
            <p className="text-xs text-[#98A0A9]">
              Staff-only reasoning and gate signals are in the Audit tab (action prefix &quot;support_agent:&quot;).
            </p>
          </div>
        )}

        {issue.resolution_note && (
          <div className="card p-5 text-sm">
            <h2 className="font-display font-medium text-lg mb-2">Resolution</h2>
            <p>{issue.resolution_note}</p>
            {issue.resolved_at && (
              <p className="text-xs text-[#5B6470] mt-1 tabular">{new Date(issue.resolved_at).toLocaleString()}</p>
            )}
          </div>
        )}
      </div>

      <AutofixPanel issueId={issue.id} run={autofixRun} />

      <TriageForm
        id={issue.id}
        status={issue.status}
        severity={issue.severity}
        resolutionNote={issue.resolution_note}
      />
    </main>
  );
}
