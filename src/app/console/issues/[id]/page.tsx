import { notFound } from "next/navigation";
import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import TriageForm from "./triage-form";

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
  context: { url?: string; user_agent?: string; recent_job_errors?: string[] } | null;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
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

      <TriageForm
        id={issue.id}
        status={issue.status}
        severity={issue.severity}
        resolutionNote={issue.resolution_note}
      />
    </main>
  );
}
