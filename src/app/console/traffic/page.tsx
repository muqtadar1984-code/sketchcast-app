import { InkUnderline } from "@/components/ink-mark";
import Sparkline from "@/components/sparkline";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  ago, compact, dailySeries, lifetime, sumPoints, topCountries, type DailyRow,
} from "@/utils/cloudflare-stats";

export const dynamic = "force-dynamic";

// The website-traffic tracker — sketchcast.app, the public website, and
// nothing else. Reads the daily rows the worker upserts from Cloudflare's
// zone analytics (migration 0120; sketchcast-ai catalogue/cloudflare_stats.py,
// hourly) and does the arithmetic in utils/cloudflare-stats.ts. Nothing
// here calls Cloudflare: the token lives in the worker.
//
// ONE SITE. The zone is the marketing site; the app, the console and the
// library are on other hosts and are not in these numbers (founder,
// 2026-09-21): the figure on this page is the one an advertiser asks for.

const ZONE = "sketchcast.app";
const WINDOWS = [7, 30, 90] as const;
type Window = (typeof WINDOWS)[number];

const th = "px-5 py-2 text-xs text-[#5B6470] font-medium";
const td = "px-5 py-2.5 text-sm";

export default async function ConsoleTrafficPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams;
  const days: Window = (WINDOWS as readonly number[]).includes(Number(sp.days)) ? (Number(sp.days) as Window) : 30;
  const admin = createAdminClient();
  const now = new Date();

  const q = await admin.from("cloudflare_daily_stats")
    .select("day, zone, requests, page_views, uniques, bytes, threats, countries, captured_at")
    .eq("zone", ZONE).order("day", { ascending: true }).limit(2_000);
  const missing = q.error?.code === "42P01";
  const rows = (q.data ?? []) as DailyRow[];
  const lastPolled = rows.reduce<string | null>((a, r) => (r.captured_at && (!a || r.captured_at > a) ? r.captured_at : a), null);

  const series90 = dailySeries(rows, 90, now);
  const today = series90[series90.length - 1];
  const yesterday = series90[series90.length - 2];
  const w7 = sumPoints(series90.slice(-7));
  const w30 = sumPoints(series90.slice(-30));
  const w90 = sumPoints(series90);
  const all = lifetime(rows);
  const window = days === 7 ? w7 : days === 30 ? w30 : w90;
  const windowDays = new Set(series90.slice(-days).map((p) => p.day));
  const countries = topCountries(rows.filter((r) => windowDays.has(r.day)), 12);
  const threats = rows.filter((r) => windowDays.has(r.day)).reduce((a, r) => a + (r.threats ?? 0), 0);

  // Days loaded from a dashboard export carry no page views; until the
  // poll has refreshed them the hints speak of requests instead.
  const hasPageViews = rows.some((r) => r.page_views != null);
  const sub = (p: { pageViews: number; requests: number }) => (hasPageViews ? `${compact(p.pageViews)} page views` : `${compact(p.requests)} requests`);
  const tiles: Array<{ label: string; value: string; hint?: string }> = [
    { label: "Today", value: compact(today.uniques), hint: `${sub(today)} · yesterday ${compact(yesterday.uniques)} visitors` },
    { label: "Last 7 days", value: compact(w7.uniques), hint: sub(w7) },
    { label: "Last 30 days", value: compact(w30.uniques), hint: sub(w30) },
    { label: "All time", value: compact(all.uniques), hint: all.firstDay ? `${sub(all)} · since ${all.firstDay}` : "nothing yet" },
  ];

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Traffic</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-xs text-[#98A0A9] mb-7">
        Visitors to sketchcast.app as Cloudflare counts them at the edge, one row per day, refreshed hourly by the worker (last asked {ago(lastPolled, now)}).
        Visitors are Cloudflare&apos;s per-day estimate, so a sum over days counts a returning visitor once per day. The app, the console and the library are not counted.
      </p>

      {missing && (
        <div className="card px-5 py-4 mb-8 text-sm text-[#8A6100]">
          The Cloudflare table is not in this database yet — apply migration 0120.
        </div>
      )}
      {!missing && rows.length === 0 && (
        <div className="card px-5 py-4 mb-8 text-sm text-[#8A6100]">
          Nothing from Cloudflare yet. The worker polls once CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID are set in its environment, and backfills as far back as Cloudflare keeps on its first poll.
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
          <div className="text-xs text-[#5B6470]">Visitors per day, last 30 days</div>
          <Sparkline values={series90.slice(-30).map((p) => p.uniques)} width={420} height={48} className="w-full h-12 mt-2" title="Visitors per day, last 30 days" />
        </div>
        <div className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
          <div className="text-xs text-[#5B6470]">Page views per day, last 30 days</div>
          <Sparkline values={series90.slice(-30).map((p) => p.pageViews)} width={420} height={48} className="w-full h-12 mt-2" title="Page views per day, last 30 days" />
        </div>
      </section>

      <section className="mb-10">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl">Where from</h2>
          <form method="get" className="flex items-center gap-2 text-xs">
            {WINDOWS.map((d) => (
              <button key={d} name="days" value={d} className={d === days ? "chip bg-[#14181F] text-white normal-case tracking-normal" : "chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal"}>
                {d} days
              </button>
            ))}
          </form>
        </div>
        <p className="text-xs text-[#98A0A9] mb-2">
          {compact(window.uniques)} visitors · {compact(window.pageViews)} page views · {compact(window.requests)} requests{threats > 0 ? ` · ${compact(threats)} blocked as threats` : ""} in the last {days} days.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <section>
            <h3 className="text-sm font-medium mt-4 mb-2">Top countries</h3>
            <div className="card divide-y divide-[#EEF0EC]">
              <div className={`grid grid-cols-[2fr_1fr_1fr] gap-2 ${th}`}>
                <span>Country</span><span className="text-end">Requests</span><span className="text-end">Share</span>
              </div>
              {countries.length === 0 && <div className="px-5 py-4 text-sm text-[#5B6470]">Nothing yet.</div>}
              {countries.map((c) => (
                <div key={c.code} className="grid grid-cols-[2fr_1fr_1fr] gap-2">
                  <span className={`${td} truncate`}>{c.label}</span>
                  <span className={`${td} tabular text-end`}>{compact(c.requests)}</span>
                  <span className={`${td} tabular text-end`}>{Math.round(c.share * 100)}%</span>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3 className="text-sm font-medium mt-4 mb-2">Day by day</h3>
            <div className="card divide-y divide-[#EEF0EC] max-h-[420px] overflow-y-auto">
              <div className={`grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-2 ${th}`}>
                <span>Day</span><span className="text-end">Visitors</span><span className="text-end">Page views</span><span className="text-end">Requests</span>
              </div>
              {[...series90.slice(-days)].reverse().map((p) => (
                <div key={p.day} className="grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-2">
                  <span className={`${td} tabular`}>{p.day}{p.day === today.day ? " (so far)" : ""}</span>
                  <span className={`${td} tabular text-end`}>{p.uniques}</span>
                  <span className={`${td} tabular text-end`}>{hasPageViews ? p.pageViews : "—"}</span>
                  <span className={`${td} tabular text-end`}>{p.requests}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
        <p className="text-[11px] text-[#98A0A9] mt-3">
          These are Cloudflare&apos;s own figures for the zone. Page views are HTML responses; requests include assets and crawlers, which Cloudflare does not separate out on this plan. Countries are by request. History reaches as far back as Cloudflare keeps for the plan.
        </p>
      </section>
    </main>
  );
}
