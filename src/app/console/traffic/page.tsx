import AutoRefresh from "@/components/auto-refresh";
import { InkUnderline } from "@/components/ink-mark";
import Sparkline from "@/components/sparkline";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  compact, dailySeries, hostTotals, minuteSeries, sumSeries,
  type DailyRow, type MinuteRow,
} from "@/utils/traffic";

export const dynamic = "force-dynamic";

// The website-traffic ticker — sketchcast.app, the marketing site. Reads the
// visit rows our own beacon writes (/api/public/visit, migration 0118)
// through three SQL functions, so a month of visits is three round trips.
// Refreshes itself every 30 seconds; the live strip is the last hour, minute
// by minute.
//
// THE HEADLINE IS THE WEBSITE. Every tile and both sparklines count
// sketchcast.app (and www) only — "is anyone visiting the site?" is the
// question. The app's own pages are counted too and listed in the per-site
// table underneath, so signups can be read against site visits; staff
// hosts (console, library) sit apart in that table and in nothing else.

const WEBSITE_HOSTS = new Set(["sketchcast.app", "www.sketchcast.app"]);
const LIVE_MINUTES = 60;
const WINDOWS = [7, 30, 90] as const;
type Window = (typeof WINDOWS)[number];

type Breakdown = { key: string; visits: number; visitors: number };

const th = "px-5 py-2 text-xs text-[#5B6470] font-medium";
const td = "px-5 py-2.5 text-sm";

export default async function ConsoleTrafficPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams;
  const days: Window = (WINDOWS as readonly number[]).includes(Number(sp.days)) ? (Number(sp.days) as Window) : 7;
  const admin = createAdminClient();
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();

  const [dailyQ, liveQ, pathsQ, refsQ, countriesQ] = await Promise.all([
    admin.rpc("site_visits_daily", { p_days: 90 }),
    admin.rpc("site_visits_live", { p_minutes: LIVE_MINUTES, p_hosts: [...WEBSITE_HOSTS] }),
    admin.rpc("site_visits_breakdown", { p_since: since, p_dimension: "path", p_limit: 12, p_hosts: [...WEBSITE_HOSTS] }),
    admin.rpc("site_visits_breakdown", { p_since: since, p_dimension: "ref_host", p_limit: 12, p_hosts: [...WEBSITE_HOSTS] }),
    admin.rpc("site_visits_breakdown", { p_since: since, p_dimension: "country", p_limit: 12, p_hosts: [...WEBSITE_HOSTS] }),
  ]);
  const missing = [dailyQ, liveQ, pathsQ, refsQ, countriesQ].some((q) => q.error?.code === "42883" || q.error?.code === "42P01");

  const daily = (dailyQ.data ?? []) as DailyRow[];
  const live = minuteSeries((liveQ.data ?? []) as MinuteRow[], LIVE_MINUTES, now);
  const last5 = live.slice(-5).reduce((a, p) => a + p.visits, 0);
  const lastHour = live.reduce((a, p) => a + p.visits, 0);

  const series90 = dailySeries(daily, 90, WEBSITE_HOSTS, now);
  const today = series90[series90.length - 1] ?? { visits: 0, visitors: 0 };
  const yesterday = series90[series90.length - 2] ?? { visits: 0, visitors: 0 };
  const w7 = sumSeries(series90.slice(-7));
  const w30 = sumSeries(series90.slice(-30));
  const w90 = sumSeries(series90);
  const window = days === 7 ? w7 : days === 30 ? w30 : w90;
  const hosts = hostTotals(daily.filter((r) => String(r.day) >= since.slice(0, 10)));

  const tiles: Array<{ label: string; value: string; hint?: string }> = [
    { label: "Live", value: String(last5), hint: `visits in the last 5 min · ${lastHour} in the last hour` },
    { label: "Today", value: compact(today.visitors), hint: `${today.visits} visits · yesterday ${yesterday.visitors} visitors` },
    { label: "Last 7 days", value: compact(w7.visitors), hint: `${compact(w7.visits)} visits` },
    { label: "Last 30 days", value: compact(w30.visitors), hint: `${compact(w30.visits)} visits` },
  ];

  const table = (title: string, rows: Breakdown[], keyLabel: string, render?: (k: string) => string) => (
    <section>
      <h3 className="text-sm font-medium mt-4 mb-2">{title}</h3>
      <div className="card divide-y divide-[#EEF0EC]">
        <div className={`grid grid-cols-[2fr_1fr_1fr] gap-2 ${th}`}>
          <span>{keyLabel}</span><span className="text-end">Visitors</span><span className="text-end">Visits</span>
        </div>
        {rows.length === 0 && <div className="px-5 py-4 text-sm text-[#5B6470]">Nothing yet.</div>}
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[2fr_1fr_1fr] gap-2">
            <span className={`${td} truncate`}>{render ? render(r.key) : r.key}</span>
            <span className={`${td} tabular text-end`}>{r.visitors}</span>
            <span className={`${td} tabular text-end`}>{r.visits}</span>
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <AutoRefresh active seconds={30} />
      <h1 className="text-4xl mb-2">Traffic</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-xs text-[#98A0A9] mb-7">
        sketchcast.app, counted by our own cookieless beacon. Visitors are unique per day. The app and the staff hosts are listed under Sites, and nowhere else. Refreshes every 30 seconds.
      </p>

      {missing && (
        <div className="card px-5 py-4 mb-8 text-sm text-[#8A6100]">
          The visit tables are not in this database yet — apply migration 0118.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {tiles.map((m) => (
          <div key={m.label} className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
            <div className="text-xs text-[#5B6470]">{m.label}</div>
            <div className="text-2xl tabular mt-0.5">{m.value}</div>
            {m.hint && <div className="text-[11px] text-[#98A0A9] mt-0.5">{m.hint}</div>}
          </div>
        ))}
      </div>

      <section className="mb-10 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
          <div className="text-xs text-[#5B6470]">sketchcast.app — last hour, per minute</div>
          <Sparkline values={live.map((p) => p.visits)} width={420} height={48} className="w-full h-12 mt-2" title="Visits per minute, last hour" />
        </div>
        <div className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
          <div className="text-xs text-[#5B6470]">sketchcast.app — visitors per day, last 30 days</div>
          <Sparkline values={series90.slice(-30).map((p) => p.visitors)} width={420} height={48} className="w-full h-12 mt-2" title="Visitors per day, last 30 days" />
        </div>
      </section>

      <section className="mb-10">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl">Where and what</h2>
          <form method="get" className="flex items-center gap-2 text-xs">
            {WINDOWS.map((d) => (
              <button key={d} name="days" value={d} className={d === days ? "chip bg-[#14181F] text-white normal-case tracking-normal" : "chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal"}>
                {d} days
              </button>
            ))}
          </form>
        </div>
        <p className="text-xs text-[#98A0A9] mb-2">sketchcast.app: {compact(window.visitors)} visitors · {compact(window.visits)} visits in the last {days} days.</p>

        <div className="card divide-y divide-[#EEF0EC]">
          <div className={`grid grid-cols-[2fr_1fr_1fr] gap-2 ${th}`}>
            <span>Site</span><span className="text-end">Visitors</span><span className="text-end">Visits</span>
          </div>
          {hosts.length === 0 && <div className="px-5 py-4 text-sm text-[#5B6470]">Nothing yet.</div>}
          {hosts.map((h) => (
            <div key={h.host} className="grid grid-cols-[2fr_1fr_1fr] gap-2">
              <span className={td}>{h.label}{h.staff ? <span className="ms-2 chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal">staff</span> : null}<span className="block text-[11px] text-[#98A0A9]">{h.host}</span></span>
              <span className={`${td} tabular text-end`}>{h.visitors}</span>
              <span className={`${td} tabular text-end`}>{h.visits}</span>
            </div>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {table("Top pages", (pathsQ.data ?? []) as Breakdown[], "Path")}
          {table("Top referrers", (refsQ.data ?? []) as Breakdown[], "Referring site", (k) => (k === "(none)" ? "Direct or unknown" : k))}
          {table("Top countries", (countriesQ.data ?? []) as Breakdown[], "Country")}
        </div>
        <p className="text-[11px] text-[#98A0A9] mt-3">
          Top pages, referrers and countries are sketchcast.app only. A visitor is a hash of address, browser and a salt that changes every UTC day, so nobody is followed across days. Paths are stored without query strings; referrers as their host only. Crawlers are dropped by user agent. Visitors who block scripts are not counted.
        </p>
      </section>
    </main>
  );
}
