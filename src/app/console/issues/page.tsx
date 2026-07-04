import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";

// Triage queue: user-reported issues, open first, filterable by status.

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  open: "bg-[#FFE9E3] text-[#B3401F]",
  triaged: "bg-[#FFF1D6] text-[#9A6400]",
  in_progress: "bg-[#E2F4F1] text-[#0C8175]",
  resolved: "bg-[#EEF0EC] text-[#5B6470]",
};

type IssueRow = {
  id: string;
  reporter_id: string | null;
  reporter_role: string | null;
  school_id: string | null;
  category: string;
  severity: string;
  status: string;
  title: string;
  created_at: string;
};

export default async function ConsoleIssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const admin = createAdminClient();

  let query = admin
    .from("platform_issues")
    .select("id, reporter_id, reporter_role, school_id, category, severity, status, title, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (status && status !== "all") query = query.eq("status", status);
  const { data: rowsRaw } = await query;
  let rows = (rowsRaw ?? []) as IssueRow[];
  if (!status) rows = rows.filter((r) => r.status !== "resolved");

  const reporterIds = [...new Set(rows.map((r) => r.reporter_id).filter(Boolean))] as string[];
  const { data: profs } = reporterIds.length
    ? await admin.from("profiles").select("id, full_name, username").in("id", reporterIds)
    : { data: [] };
  const nameOf = new Map((profs ?? []).map((p) => [p.id, p.full_name || p.username || "User"] as const));

  const filters = [
    { key: undefined, label: "Active" },
    { key: "open", label: "Open" },
    { key: "in_progress", label: "In progress" },
    { key: "resolved", label: "Resolved" },
    { key: "all", label: "All" },
  ];

  return (
    <main className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Issues</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-5">
        Problems reported from inside the portal. {rows.length} shown.
      </p>

      <div className="flex flex-wrap gap-2 mb-5">
        {filters.map((f) => (
          <Link
            key={f.label}
            href={f.key ? `/console/issues?status=${f.key}` : "/console/issues"}
            className={`chip font-sans normal-case tracking-normal ${
              (status ?? undefined) === f.key ? "bg-[#14181F] text-white" : "bg-[#EEF0EC] text-[#5B6470]"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="card px-5 py-8 text-sm text-[#5B6470]">Nothing here. 🎉</div>
      ) : (
        <div className="card divide-y divide-[#EEF0EC]">
          {rows.map((r) => (
            <Link key={r.id} href={`/console/issues/${r.id}`} className="block px-5 py-3 hover:bg-[#FAFBF9]">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium truncate">{r.title}</span>
                <span className="flex items-center gap-2 shrink-0">
                  {(r.severity === "high" || r.severity === "critical") && (
                    <span className="chip font-sans bg-[#FFE9E3] text-[#B3401F]">{r.severity}</span>
                  )}
                  <span className={`chip font-sans normal-case tracking-normal ${STATUS_TONE[r.status] ?? ""}`}>
                    {r.status.replace("_", " ")}
                  </span>
                </span>
              </div>
              <div className="mt-1 text-xs text-[#5B6470]">
                {r.reporter_id ? nameOf.get(r.reporter_id) ?? "User" : "Unknown"} · {r.reporter_role ?? "?"} ·{" "}
                {r.category} · <span className="tabular">{new Date(r.created_at).toLocaleString()}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
