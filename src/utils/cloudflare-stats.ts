// The website-traffic tracker — the pure half. The console page
// (/console/traffic) reads the rows the worker upserts from Cloudflare's
// zone analytics (migration 0120; sketchcast-ai catalogue/cloudflare_stats.py)
// and shapes them here, where vitest can pin the arithmetic without a
// database.
//
// THE UNITS ARE CLOUDFLARE'S. `uniques` is Cloudflare's per-day estimate of
// distinct visitors by address; there is no cross-day identity, so a sum
// over days counts a returning visitor once per day they came — the page
// says so. `page_views` are HTML responses; `requests` include assets and
// crawlers. Today's row is partial until the day ends. A day seeded from a
// dashboard export has no page views (null) until the poll refreshes it.

export type DailyRow = {
  day: string;               // YYYY-MM-DD (UTC)
  zone: string;
  requests: number;
  page_views: number | null;   // null when unknown (seeded from a dashboard export)
  uniques: number;
  bytes?: number | null;
  threats?: number | null;
  countries?: Array<{ country: string; requests: number }> | null;
  captured_at?: string;
};

export type DayPoint = { day: string; pageViews: number; uniques: number; requests: number };

/** The UTC day of a moment as YYYY-MM-DD. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The last `days` UTC days ending today, oldest first. */
export function lastDays(days: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = days - 1; i >= 0; i--) out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** One point per day for the last `days` days, zero where Cloudflare had
 *  no row — a sparkline must not skip quiet days. */
export function dailySeries(rows: DailyRow[], days: number, now: Date = new Date()): DayPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return lastDays(days, now).map((day) => {
    const r = byDay.get(day);
    return { day, pageViews: r?.page_views ?? 0, uniques: r?.uniques ?? 0, requests: r?.requests ?? 0 };
  });
}

export function sumPoints(points: DayPoint[]): { pageViews: number; uniques: number; requests: number } {
  return points.reduce((a, p) => ({ pageViews: a.pageViews + p.pageViews, uniques: a.uniques + p.uniques, requests: a.requests + p.requests }),
    { pageViews: 0, uniques: 0, requests: 0 });
}

/** Everything Cloudflare kept: the first day on record and the totals. */
export function lifetime(rows: DailyRow[]): { firstDay: string | null; days: number; pageViews: number; uniques: number; requests: number } {
  let firstDay: string | null = null;
  let pageViews = 0, uniques = 0, requests = 0;
  for (const r of rows) {
    if (!firstDay || r.day < firstDay) firstDay = r.day;
    pageViews += r.page_views ?? 0; uniques += r.uniques; requests += r.requests;
  }
  return { firstDay, days: rows.length, pageViews, uniques, requests };
}

/** Requests per country over `rows`, largest first. Cloudflare gives
 *  ISO 3166-1 alpha-2 codes; `label` names them where the runtime can. */
export function topCountries(rows: DailyRow[], limit = 12): Array<{ code: string; label: string; requests: number; share: number }> {
  const totals = new Map<string, number>();
  for (const r of rows) for (const c of r.countries ?? []) {
    const code = (c.country ?? "").toUpperCase();
    if (!code) continue;
    totals.set(code, (totals.get(code) ?? 0) + (c.requests ?? 0));
  }
  const all = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([code, requests]) => ({ code, label: countryLabel(code), requests, share: all ? requests / all : 0 }));
}

let names: Intl.DisplayNames | null | undefined;
export function countryLabel(code: string): string {
  if (names === undefined) {
    try { names = new Intl.DisplayNames(["en"], { type: "region" }); } catch { names = null; }
  }
  if (!/^[A-Z]{2}$/.test(code)) return code || "Unknown";
  try { return names?.of(code) ?? code; } catch { return code; }
}

/** "1.2k", "3.4M" — a tile has no room for thousands separators. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "3 h ago" for the captured_at of the newest row — the page shows when
 *  Cloudflare was last asked. */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
