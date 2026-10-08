import { createAdminClient } from "@/utils/supabase/admin";
import { selectAll } from "@/utils/supabase/select-all";
import { InkUnderline } from "@/components/ink-mark";
import { demoSchoolIds, metricsExcludedIds } from "@/utils/demo";
import { staffUserIds } from "@/utils/platform-admin";
import Link from "next/link";
import { isCustomerJob, monthlyFailureRate, monthStartUtc, sharedBooks, stalledAccounts, topCountries, topTeachersByKits } from "@/utils/console-insights";
import { overviewAudience } from "@/utils/console-audience";
import type { ChannelSnap } from "@/utils/youtube-stats";
import type { DailyRow } from "@/utils/cloudflare-stats";

// Platform overview — the founder's one-page answer to "how is SketchCast
// doing and what is it costing?". Server component, service role only; the
// layout has already verified staff access.

export const dynamic = "force-dynamic";

const DAY = 86400000;
// The failure chart's window: the current calendar month and the five before it.
const FAILURE_MONTHS = 6;

/** "Jun 2026" for a YYYY-MM month — the chart's row label. */
function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}

type Metric = { label: string; value: string | number; hint?: string };

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "—";
}

export default async function ConsoleOverviewPage() {
  const admin = createAdminClient();
  // (server component, rendered once per request — Date.now is fine here)
  // eslint-disable-next-line react-hooks/purity
  const failureWindowStart = new Date(monthStartUtc(new Date(Date.now()), FAILURE_MONTHS - 1)).toISOString();

  const [profilesQ, schoolsQ, booksQ, gensQ, feedbackQ, viewsQ, ytQ, cfQ, windowJobsQ, staffIds] = await Promise.all([
    admin.from("profiles").select("id, role, school_id, beta_tester, is_demo, metrics_excluded, created_at, full_name, username, country, country_source"),
    admin.from("schools").select("id, name"),
    admin.from("books").select("id, owner_id, status, created_at, title, pages, content_hash, language, removed_at"),
    // Whole tables, not the first 1000 rows: generations passed the PostgREST
    // cap on 2026-10-08 and every number below was built on a partial set.
    selectAll(() => admin.from("generations").select("id, owner_id, kind, status, created_at")),
    admin.from("beta_feedback").select("teacher_id"),
    admin.from("artifact_views").select("teacher_id"),
    // Audience cards — the YouTube tab's latest channel snapshot (0118) and
    // the Traffic tab's daily rows for the marketing site (0120). Either table
    // may be absent on a database behind those migrations; the cards then
    // show a dash instead of failing the page.
    admin.from("youtube_channel_stats").select("channel_id, captured_at, title, subscribers, views, videos")
      .order("captured_at", { ascending: false }).limit(1),
    admin.from("cloudflare_daily_stats").select("day, zone, requests, page_views, uniques, bytes, threats, countries, captured_at")
      .eq("zone", "sketchcast.app").order("day", { ascending: true }).limit(2_000),
    // Finished jobs of the last FAILURE_MONTHS months: the failure-rate tile
    // AND the monthly chart read this one set, so they agree by construction.
    // Its own select, because the spend panel below reads only the newest
    // 2000 rows and six months can hold more.
    selectAll(() =>
      admin.from("jobs").select("status, created_at, generation_id, book_id, type, params")
        .in("status", ["done", "error"]).gte("created_at", failureWindowStart),
    ),
    staffUserIds(admin),
  ]);

  // jobs.usage only exists once migration 0013 is applied — degrade to the
  // usage-less select rather than losing the whole jobs panel.
  // Newest 2000 — in pages, because .limit(2000) alone still returned 1000.
  let jobsQ = await selectAll(
    () =>
      admin
        .from("jobs")
        .select("id, generation_id, book_id, type, params, status, error, usage, created_at")
        .order("created_at", { ascending: false }),
    { max: 2000 },
  );
  if (jobsQ.error) {
    jobsQ = (await selectAll(
      () =>
        admin
          .from("jobs")
          .select("id, generation_id, book_id, type, params, status, error, created_at")
          .order("created_at", { ascending: false }),
      { max: 2000 },
    )) as typeof jobsQ;
  }

  const allProfiles = (profilesQ.data ?? []) as { id: string; role: string; school_id: string | null; beta_tester: boolean | null; is_demo: boolean | null; metrics_excluded: boolean | null; created_at: string; full_name: string | null; username: string | null; country: string | null; country_source: string | null }[];
  const allBooks = (booksQ.data ?? []) as { id: string; owner_id: string; status: string; created_at: string; title: string | null; pages: number | null; content_hash: string | null; language: string | null; removed_at: string | null }[];
  const allGens = (gensQ.data ?? []) as { id: string; owner_id: string; kind: string | null; status: string; created_at: string }[];
  const allJobs = (jobsQ.data ?? []) as { id: string; generation_id: string | null; book_id: string | null; type: string | null; params: unknown; status: string; error: string | null; usage: { cost_usd?: number } | null; created_at: string }[];

  // Every metric on this page counts REAL usage only. Three kinds of account
  // are not a customer: demo tenants (profiles.is_demo, migration 0081), whose
  // pre-canned books and generations would drown the actual numbers;
  // SketchCast's OWN accounts (platform_admins — the founder, Sara, the
  // catalogue system account), whose testing and whose catalogue kits are not
  // usage either (founder, 2026-09-07: "them being in the list of users skews
  // the results"); and real users' accounts a staff member has flagged
  // metrics_excluded (0124) — the personal logins staff also test with, which
  // stay users on the roster but out of these numbers (founder, 2026-10-08).
  const excludedIds = metricsExcludedIds(allProfiles, staffIds);
  const profiles = allProfiles.filter((p) => !excludedIds.has(p.id));
  const books = allBooks.filter((b) => !excludedIds.has(b.owner_id));
  const gens = allGens.filter((g) => !excludedIds.has(g.owner_id));
  // Jobs carry no owner — attribute through their generation/book. A CUSTOMER
  // job (isCustomerJob: not one of the worker's own lanes, not a catalogue
  // kit) whose row resolves to neither is kept (fail open, like the rest of
  // this page); the worker's own jobs never resolve to an owner, which is
  // exactly how catalogue, support and YouTube failures used to leak into the
  // failure rate (founder, 2026-10-08: development failures, not product).
  const genOwner = new Map(allGens.map((g) => [g.id, g.owner_id]));
  const bookOwner = new Map(allBooks.map((b) => [b.id, b.owner_id]));
  const jobIsReal = (j: { generation_id: string | null; book_id: string | null; type: string | null; params?: unknown }) => {
    if (!isCustomerJob(j)) return false;
    const owner =
      (j.generation_id ? genOwner.get(j.generation_id) : undefined) ??
      (j.book_id ? bookOwner.get(j.book_id) : undefined);
    return owner === undefined || !excludedIds.has(owner);
  };
  const jobs = allJobs.filter(jobIsReal);
  const windowJobs = ((windowJobsQ.data ?? []) as { status: string; created_at: string; generation_id: string | null; book_id: string | null; type: string | null; params: unknown }[])
    .filter(jobIsReal);
  // A school whose known members are ALL demo accounts is a seeded demo tenant.
  const demoSchools = demoSchoolIds(allProfiles);
  const schoolRows = (schoolsQ.data ?? []) as { id: string; name: string | null }[];
  const schoolCount = schoolRows.filter((s) => !demoSchools.has(s.id)).length;
  const schoolName = new Map(schoolRows.map((s) => [s.id, s.name || "School"]));

  // (server component, rendered once per request — Date.now is fine here)
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const roleCount = new Map<string, number>();
  // beta_tester is auto-set on EVERY signup (0012) and drives the trial caps —
  // it marks a trial account, not beta-programme membership.
  let trial = 0;
  let signups7 = 0;
  // Calendar horizons for the Signups card (local server time, like the 7d
  // window). Lifetime is just profiles.length — already demo-filtered.
  const nowDate = new Date(now);
  const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
  const yearStart = new Date(nowDate.getFullYear(), 0, 1).getTime();
  let signupsMtd = 0;
  let signupsYtd = 0;
  for (const p of profiles) {
    roleCount.set(p.role, (roleCount.get(p.role) ?? 0) + 1);
    if (p.beta_tester) trial++;
    const t = new Date(p.created_at).getTime();
    if (now - t <= 7 * DAY) signups7++;
    if (t >= monthStart) signupsMtd++;
    if (t >= yearStart) signupsYtd++;
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

  // Jobs: failure rate (the window set, shared with the monthly chart below)
  // + spend (jobs.usage from migration 0013, newest 2000)
  const finished = windowJobs.filter((j) => j.status === "done" || j.status === "error");
  const failed = finished.filter((j) => j.status === "error");
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

  // Activation funnel: signup → uploaded a book → has a finished generation → gave feedback
  const bookOwners = new Set(books.map((b) => b.owner_id));
  const doneOwners = new Set(gens.filter((g) => g.status === "done").map((g) => g.owner_id));
  const viewers = new Set(
    ((viewsQ.data ?? []) as { teacher_id: string }[]).map((v) => v.teacher_id).filter((id) => !excludedIds.has(id)),
  );
  const feedbackCount = ((feedbackQ.data ?? []) as { teacher_id: string }[]).filter((f) => !excludedIds.has(f.teacher_id)).length;

  // Who is using it — three top-5 panels folded from the same demo/staff-
  // filtered rows (src/utils/console-insights.ts): the teachers with the most
  // finished lessons (the roster's "Lessons" number, so the two pages agree),
  // where the accounts come from, and the books more than one person uploaded
  // (content_hash identity, the school repository's dedup key).
  const topTeachers = topTeachersByKits(profiles, gens);
  const countries = topCountries(profiles);
  const shared = sharedBooks(books);
  // ...and where the adults who signed up stopped: no upload yet, or an
  // upload that never became a kit (founder, 2026-10-08).
  const stalled = stalledAccounts(profiles, books, gens);
  // Failure rate per calendar month over the window — the same rows the
  // "Job failure rate" tile totals, so the tile is this chart's sum.
  const monthly = monthlyFailureRate(windowJobs, FAILURE_MONTHS, nowDate);
  const monthlyMaxPct = Math.max(1, ...monthly.map((m) => (m.rate === null ? 0 : Math.round(m.rate * 100))));

  const audience = overviewAudience((ytQ.data ?? []) as ChannelSnap[], (cfQ.data ?? []) as DailyRow[], nowDate);

  const metrics: Metric[] = [
    { label: "Schools", value: schoolCount },
    { label: "Teachers", value: (roleCount.get("teacher") ?? 0) + (roleCount.get("coordinator") ?? 0) },
    { label: "Students", value: roleCount.get("student") ?? 0 },
    // Parents included so the role cards SUM to the Users page's roster count
    // (36 teachers + 9 students + 6 parents = 51 — the founder reconciles them).
    { label: "Parents", value: roleCount.get("parent") ?? 0 },
    { label: "Admins", value: roleCount.get("school_admin") ?? 0 },
    { label: "Signups (7d)", value: signups7 },
    { label: "Books", value: books.length },
    {
      label: "Job failure rate",
      value: pct(failed.length, finished.length),
      hint: `${failed.length}/${finished.length} since ${monthLabel(monthly[0].month)} · customer jobs`,
    },
    {
      label: "Claude spend (30d)",
      value: trackedJobs ? `$${spend30.toFixed(2)}` : "—",
      hint: trackedJobs ? `$${spendAll.toFixed(2)} tracked total · ${trackedJobs} jobs` : "apply migration 0013 + new worker",
    },
  ];

  const funnel = [
    { label: "Trial accounts", n: trial },
    { label: "Uploaded a book", n: [...bookOwners].length },
    { label: "Finished a generation", n: [...doneOwners].length },
    { label: "Viewed artifacts", n: viewers.size },
    { label: "Gave feedback", n: feedbackCount },
  ];

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Overview</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-xs text-[#98A0A9] mb-7">Excludes demo accounts and SketchCast staff.</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
            <div className="text-xs text-[#5B6470]">{m.label}</div>
            <div className="text-2xl tabular mt-0.5">{m.value}</div>
            {m.hint && <div className="text-[11px] text-[#98A0A9] mt-0.5">{m.hint}</div>}
          </div>
        ))}
        {/* Signups beyond the 7-day window — one card, three horizons. */}
        <div className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
          <div className="text-xs text-[#5B6470]">Signups</div>
          <div className="mt-1 space-y-1">
            {[
              ["Month to date", signupsMtd],
              ["Year to date", signupsYtd],
              ["Life to date", profiles.length],
            ].map(([label, n]) => (
              <div key={String(label)} className="flex items-baseline justify-between">
                <span className="text-[11px] text-[#98A0A9]">{label}</span>
                <span className="tabular text-base">{n}</span>
              </div>
            ))}
          </div>
        </div>
        {/* Audience — the YouTube tab's headline pair and the Traffic tab's
            visitor counts, on the one page the founder reads first. Numbers
            come from the same snapshots those tabs read (console-audience.ts). */}
        {[
          {
            title: "YouTube",
            rows: [
              ["Subscribers", audience.subscribers],
              ["Channel views, life to date", audience.channelViews],
            ] as const,
          },
          {
            title: "Website traffic",
            rows: [
              ["Visitors, last 30 days", audience.visitors30],
              ["Visitors, life to date", audience.visitorsAll],
            ] as const,
          },
        ].map((card) => (
          <div key={card.title} className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
            <div className="text-xs text-[#5B6470]">{card.title}</div>
            <div className="mt-1 space-y-1">
              {card.rows.map(([label, n]) => (
                <div key={label} className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-[#98A0A9]">{label}</span>
                  <span className={`tabular text-base ${n === null ? "text-[#98A0A9]" : ""}`}>
                    {n === null ? "—" : n.toLocaleString("en")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-8 mb-10">
        <section>
          <h2 className="text-xl mb-3">Top teachers by kits</h2>
          <div className="card divide-y divide-[#EEF0EC]">
            <div className="grid grid-cols-[2fr_0.6fr_1fr] gap-2 px-5 py-2 text-xs text-[#5B6470] font-medium">
              <span>Teacher</span><span className="text-end">Kits</span><span className="text-end">Last kit</span>
            </div>
            {topTeachers.map((t) => (
              <Link
                key={t.id}
                href={`/console/users/${t.id}`}
                className="grid grid-cols-[2fr_0.6fr_1fr] gap-2 px-5 py-2.5 text-sm items-center hover:bg-[#FAFBF9]"
              >
                <span className="min-w-0">
                  <span className="block font-medium truncate">{t.name}</span>
                  {t.schoolId && (
                    <span className="block text-[11px] text-[#98A0A9] truncate">{schoolName.get(t.schoolId) ?? "School"}</span>
                  )}
                </span>
                <span className="tabular text-end">{t.kits}</span>
                <span className="tabular text-end text-xs text-[#5B6470]">{new Date(t.lastAt).toLocaleDateString()}</span>
              </Link>
            ))}
            {topTeachers.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No finished lessons yet.</div>}
          </div>
          <p className="text-xs text-[#98A0A9] mt-2">
            A kit is a finished lesson — the roster&apos;s Lessons column. Teachers and coordinators only.
          </p>
        </section>

        <section>
          <h2 className="text-xl mb-3">Top countries</h2>
          <div className="card divide-y divide-[#EEF0EC]">
            <div className="grid grid-cols-[2fr_0.6fr] gap-2 px-5 py-2 text-xs text-[#5B6470] font-medium">
              <span>Country</span><span className="text-end">Users</span>
            </div>
            {countries.top.map((c) => (
              <div key={c.code} className="grid grid-cols-[2fr_0.6fr] gap-2 px-5 py-2.5 text-sm items-center">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-[#98A0A9] ms-2">{c.code}</span>
                  {c.assumed > 0 && (
                    <span className="text-xs text-[#98A0A9] ms-2" title="Assumed at signup, not stated by the user">
                      ≈ {c.assumed}
                    </span>
                  )}
                </span>
                <span className="tabular text-end">{c.users}</span>
              </div>
            ))}
            {countries.top.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No country on any account yet.</div>}
          </div>
          <p className="text-xs text-[#98A0A9] mt-2">
            {countries.unknown} of {countries.total} accounts carry no country. ≈ n = assumed at signup, not stated.
          </p>
        </section>

        <section>
          <h2 className="text-xl mb-3">Books uploaded by several users</h2>
          <div className="card divide-y divide-[#EEF0EC]">
            <div className="grid grid-cols-[2fr_0.6fr_0.7fr] gap-2 px-5 py-2 text-xs text-[#5B6470] font-medium">
              <span>Book</span><span className="text-end">Users</span><span className="text-end">Uploads</span>
            </div>
            {shared.map((b, i) => (
              <div key={`${i}-${b.title}`} className="grid grid-cols-[2fr_0.6fr_0.7fr] gap-2 px-5 py-2.5 text-sm items-center">
                <span className="min-w-0">
                  <span className="block font-medium truncate" title={b.title}>{b.title}</span>
                  {b.languages.length > 0 && (
                    <span className="block text-[11px] text-[#98A0A9]">{b.languages.join(", ")}</span>
                  )}
                </span>
                <span className="tabular text-end">{b.owners}</span>
                <span className="tabular text-end text-[#5B6470]">{b.uploads}</span>
              </div>
            ))}
            {shared.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No book has been uploaded by more than one user yet.</div>}
          </div>
          <p className="text-xs text-[#98A0A9] mt-2">
            Same book = same file (content hash), or the same title and page count for older uploads. Deleted books excluded.
          </p>
        </section>

        <section>
          <h2 className="text-xl mb-3">Stalled after signup</h2>
          <div className="card divide-y divide-[#EEF0EC]">
            <div className="grid grid-cols-[2fr_0.6fr] gap-2 px-5 py-2 text-xs text-[#5B6470] font-medium">
              <span>Teachers and parents who…</span><span className="text-end">Accounts</span>
            </div>
            <div className="grid grid-cols-[2fr_0.6fr] gap-2 px-5 py-2.5 text-sm items-center">
              <span className="min-w-0">
                <span className="block font-medium">Registered, uploaded no textbook</span>
                <span className="block text-[11px] text-[#98A0A9]">
                  {stalled.noBook.teachers} teachers · {stalled.noBook.parents} parents
                </span>
              </span>
              <span className="tabular text-end">{stalled.noBook.total}</span>
            </div>
            <div className="grid grid-cols-[2fr_0.6fr] gap-2 px-5 py-2.5 text-sm items-center">
              <span className="min-w-0">
                <span className="block font-medium">Uploaded a textbook, generated nothing</span>
                <span className="block text-[11px] text-[#98A0A9]">
                  {stalled.bookNoGeneration.teachers} teachers · {stalled.bookNoGeneration.parents} parents
                  {stalled.bookNoGeneration.triedNothingFinished > 0 &&
                    ` · ${stalled.bookNoGeneration.triedNothingFinished} more tried, nothing finished`}
                </span>
              </span>
              <span className="tabular text-end">{stalled.bookNoGeneration.total}</span>
            </div>
          </div>
          <p className="text-xs text-[#98A0A9] mt-2">
            Teachers, coordinators and parents. Any upload counts, even one since deleted; &quot;generated nothing&quot; means no generation was ever started.
          </p>
        </section>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        <section>
          <h2 className="text-xl mb-3">Generations by kind</h2>
          <div className="card divide-y divide-[#EEF0EC]">
            <div className="grid grid-cols-[2fr_repeat(3,1fr)] gap-2 px-5 py-2 text-xs text-[#5B6470] font-medium">
              <span>Kind</span><span className="text-end">Done</span>
              <span className="text-end">Failed</span><span className="text-end">Running</span>
            </div>
            {[...byKind.entries()].sort((a, b) => (b[1].done + b[1].error) - (a[1].done + a[1].error)).map(([k, r]) => (
              <div key={k} className="grid grid-cols-[2fr_repeat(3,1fr)] gap-2 px-5 py-2.5 text-sm">
                <span className="font-medium">{k}</span>
                <span className="tabular text-end">{r.done}</span>
                <span className={`tabular text-end ${r.error ? "text-[#9A6400]" : ""}`}>{r.error}</span>
                <span className="tabular text-end">{r.other}</span>
              </div>
            ))}
            {byKind.size === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No generations yet.</div>}
          </div>

          <h2 className="text-xl mt-8 mb-3">Activation funnel</h2>
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
                <span className="tabular text-sm w-8 text-end">{f.n}</span>
              </div>
            ))}
          </div>

        </section>

        <section>
          <h2 className="text-xl mb-3">Job failure rate, monthly</h2>
          <div className="card px-5 py-4 space-y-2">
            {monthly.map((m) => {
              const p = m.rate === null ? null : Math.round(m.rate * 100);
              return (
                <div key={m.month} className="flex items-center gap-3">
                  <span className="w-20 text-sm text-[#5B6470] whitespace-nowrap">{monthLabel(m.month)}</span>
                  <div className="flex-1 h-4 rounded bg-[#EEF0EC] overflow-hidden">
                    {p !== null && p > 0 && (
                      <div className="h-full bg-[#9A6400]" style={{ width: `${Math.max(2, (p / monthlyMaxPct) * 100)}%` }} />
                    )}
                  </div>
                  <span className={`tabular text-sm w-10 text-end ${p === null ? "text-[#98A0A9]" : ""}`}>
                    {p === null ? "—" : `${p}%`}
                  </span>
                  <span className="tabular text-[11px] text-[#98A0A9] w-16 text-end whitespace-nowrap">
                    {m.finished ? `${m.failed}/${m.finished}` : "no jobs"}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-[#98A0A9] mt-2">
            Failed ÷ finished jobs per calendar month (UTC), last {FAILURE_MONTHS} months; the current month is to date. Customer jobs only — demo, staff and
            metrics-excluded owners, catalogue kits and the worker&apos;s own support, catalogue and YouTube jobs are left out. The Job failure rate tile
            is this same set in total. Bars scale to the worst month.
          </p>
        </section>
      </div>
    </main>
  );
}
