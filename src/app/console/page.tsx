import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";

// Platform overview — the founder's one-page answer to "how is SketchCast
// doing and what is it costing?". Server component, service role only; the
// layout has already verified staff access.

export const dynamic = "force-dynamic";

const DAY = 86400000;

type Metric = { label: string; value: string | number; hint?: string };

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "—";
}

export default async function ConsoleOverviewPage() {
  const admin = createAdminClient();

  const [profilesQ, schoolsQ, booksQ, gensQ, feedbackQ, viewsQ] = await Promise.all([
    admin.from("profiles").select("id, role, beta_tester, created_at"),
    admin.from("schools").select("id", { count: "exact", head: true }),
    admin.from("books").select("id, owner_id, status, created_at"),
    admin.from("generations").select("id, owner_id, kind, status, created_at"),
    admin.from("beta_feedback").select("id", { count: "exact", head: true }),
    admin.from("artifact_views").select("teacher_id"),
  ]);

  // jobs.usage only exists once migration 0013 is applied — degrade to the
  // usage-less select rather than losing the whole jobs panel.
  let jobsQ = await admin
    .from("jobs")
    .select("id, type, status, error, usage, created_at")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (jobsQ.error) {
    jobsQ = (await admin
      .from("jobs")
      .select("id, type, status, error, created_at")
      .order("created_at", { ascending: false })
      .limit(2000)) as typeof jobsQ;
  }

  const profiles = (profilesQ.data ?? []) as { id: string; role: string; beta_tester: boolean | null; created_at: string }[];
  const books = (booksQ.data ?? []) as { id: string; owner_id: string; status: string; created_at: string }[];
  const gens = (gensQ.data ?? []) as { id: string; owner_id: string; kind: string | null; status: string; created_at: string }[];
  const jobs = (jobsQ.data ?? []) as { id: string; type: string | null; status: string; error: string | null; usage: { cost_usd?: number } | null; created_at: string }[];

  // (server component, rendered once per request — Date.now is fine here)
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const roleCount = new Map<string, number>();
  let beta = 0;
  let signups7 = 0;
  for (const p of profiles) {
    roleCount.set(p.role, (roleCount.get(p.role) ?? 0) + 1);
    if (p.beta_tester) beta++;
    if (now - new Date(p.created_at).getTime() <= 7 * DAY) signups7++;
  }

  // Generation volume by kind × status
  const byKind = new Map<string, { done: number; error: number; other: number }>();
  for (const g of gens) {
    const k = g.kind || "presentation";
    const row = byKind.get(k) ?? { done: 0, error: 0, other: 0 };
    if (g.status === "done") row.done++;
    else if (g.status === "error") row.error++;
    else row.other++;
    byKind.set(k, row);
  }

  // Jobs: failure rate + recent errors + spend (jobs.usage from migration 0013)
  const finished = jobs.filter((j) => j.status === "done" || j.status === "error");
  const failed = finished.filter((j) => j.status === "error");
  const recentErrors: { when: string; type: string; error: string }[] = [];
  const seenErr = new Set<string>();
  for (const j of failed) {
    const key = (j.error || "").slice(0, 60);
    if (!key || seenErr.has(key)) continue;
    seenErr.add(key);
    recentErrors.push({
      when: new Date(j.created_at).toLocaleString(),
      type: j.type || "generation",
      error: (j.error || "").slice(0, 160),
    });
    if (recentErrors.length >= 6) break;
  }
  let spendAll = 0;
  let spend30 = 0;
  let trackedJobs = 0;
  for (const j of jobs) {
    const c = j.usage?.cost_usd;
    if (typeof c !== "number") continue;
    trackedJobs++;
    spendAll += c;
    if (now - new Date(j.created_at).getTime() <= 30 * DAY) spend30 += c;
  }

  // Beta funnel: signup → uploaded a book → has a finished generation → gave feedback
  const bookOwners = new Set(books.map((b) => b.owner_id));
  const doneOwners = new Set(gens.filter((g) => g.status === "done").map((g) => g.owner_id));
  const viewers = new Set(((viewsQ.data ?? []) as { teacher_id: string }[]).map((v) => v.teacher_id));

  const metrics: Metric[] = [
    { label: "Schools", value: schoolsQ.count ?? 0 },
    { label: "Teachers", value: (roleCount.get("teacher") ?? 0) + (roleCount.get("coordinator") ?? 0) },
    { label: "Students", value: roleCount.get("student") ?? 0 },
    { label: "Admins", value: roleCount.get("school_admin") ?? 0 },
    { label: "Signups (7d)", value: signups7 },
    { label: "Books", value: books.length },
    {
      label: "Job failure rate",
      value: pct(failed.length, finished.length),
      hint: `${failed.length}/${finished.length} of last ${finished.length}`,
    },
    {
      label: "Claude spend (30d)",
      value: trackedJobs ? `$${spend30.toFixed(2)}` : "—",
      hint: trackedJobs ? `$${spendAll.toFixed(2)} tracked total · ${trackedJobs} jobs` : "apply migration 0013 + new worker",
    },
  ];

  const funnel = [
    { label: "Beta testers", n: beta },
    { label: "Uploaded a book", n: [...bookOwners].length },
    { label: "Finished a generation", n: [...doneOwners].length },
    { label: "Viewed artifacts", n: viewers.size },
    { label: "Gave feedback", n: feedbackQ.count ?? 0 },
  ];

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Overview</h1>
      <InkUnderline className="block h-3 w-28 mb-7" />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
            <div className="text-xs text-[#5B6470]">{m.label}</div>
            <div className="text-2xl tabular mt-0.5">{m.value}</div>
            {m.hint && <div className="text-[11px] text-[#98A0A9] mt-0.5">{m.hint}</div>}
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        <section>
          <h2 className="text-xl mb-3">Generations by kind</h2>
          <div className="card divide-y divide-[#EEF0EC]">
            <div className="grid grid-cols-[2fr_repeat(3,1fr)] gap-2 px-5 py-2 text-xs text-[#5B6470] font-medium">
              <span>Kind</span><span className="text-right">Done</span>
              <span className="text-right">Failed</span><span className="text-right">Running</span>
            </div>
            {[...byKind.entries()].sort((a, b) => (b[1].done + b[1].error) - (a[1].done + a[1].error)).map(([k, r]) => (
              <div key={k} className="grid grid-cols-[2fr_repeat(3,1fr)] gap-2 px-5 py-2.5 text-sm">
                <span className="font-medium">{k}</span>
                <span className="tabular text-right">{r.done}</span>
                <span className={`tabular text-right ${r.error ? "text-[#9A6400]" : ""}`}>{r.error}</span>
                <span className="tabular text-right">{r.other}</span>
              </div>
            ))}
            {byKind.size === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No generations yet.</div>}
          </div>

          <h2 className="text-xl mt-8 mb-3">Beta funnel</h2>
          <div className="card px-5 py-4 space-y-2">
            {funnel.map((f, i) => (
              <div key={f.label} className="flex items-center gap-3">
                <span className="w-44 text-sm text-[#5B6470]">{f.label}</span>
                <div className="flex-1 h-4 rounded bg-[#EEF0EC] overflow-hidden">
                  <div
                    className="h-full bg-[#1FB8A6]"
                    style={{ width: funnel[0].n ? `${Math.max(2, (f.n / funnel[0].n) * 100)}%` : "0%", opacity: 1 - i * 0.12 }}
                  />
                </div>
                <span className="tabular text-sm w-8 text-right">{f.n}</span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-xl mb-3">Recent job errors</h2>
          {recentErrors.length === 0 ? (
            <div className="card px-5 py-6 text-sm text-[#5B6470]">No failed jobs. 🎉</div>
          ) : (
            <div className="card divide-y divide-[#EEF0EC]">
              {recentErrors.map((e, i) => (
                <div key={i} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-3 text-xs text-[#5B6470] mb-1">
                    <span className="chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal">{e.type}</span>
                    <span className="tabular">{e.when}</span>
                  </div>
                  <p className="text-sm text-[#9A6400] break-words">{e.error}</p>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-[#98A0A9] mt-2">
            Deduplicated by message — the Issues tab tracks what users report; this is what the pipeline reports.
          </p>
        </section>
      </div>
    </main>
  );
}
