// The website-traffic tracker — the pure half. The beacon endpoint
// (/api/public/visit) and the console page (/console/traffic) both import
// from here so what is COUNTED and what is SHOWN can never disagree, and
// the vitest suite pins both without a browser or a database.
//
// WHAT A VISIT IS. One page view sent by our own tiny beacon from either
// site (the marketing site's assets/visit.js, the app's VisitBeacon).
// Cookieless: nothing is set in the browser. No IP is stored: `visitor` is
// sha256(daily salt | address | user agent), which lets a day's unique
// visitors be counted and lets nobody follow one person across days.
// Crawlers are dropped by user agent before the row is written — a
// crawler visit is not a visit, and the console must not be cheered by one.

import { createHash } from "crypto";

export const HOST_LABELS: Record<string, string> = {
  "sketchcast.app": "Website",
  "www.sketchcast.app": "Website",
  "app.sketchcast.app": "App",
  "school.sketchcast.app": "School portal",
  "console.sketchcast.app": "Console",
  "library.sketchcast.app": "Library",
};

/** A friendly name for a host, else the host itself. */
export function hostLabel(host: string): string {
  return HOST_LABELS[host.toLowerCase()] ?? host;
}

/** Hosts that belong to STAFF, not visitors — the console shows them
 *  separately so a founder refreshing the console is not "traffic". */
export const STAFF_HOSTS = new Set(["console.sketchcast.app", "library.sketchcast.app"]);

const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|fetch|curl|wget|python-requests|httpclient|scrapy|facebookexternalhit|embedly|quora link|pinterest|vkshare|whatsapp|telegrambot|discordbot|twitterbot|linkedinbot|applebot|bingpreview|yandex|baiduspider|duckduckbot|semrush|ahrefs|mj12/i;

/** Is this user agent a crawler, a link-preview fetcher or a tool? A visit
 *  from one is not counted. An EMPTY user agent is treated as a bot too:
 *  every real browser sends one. */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  const s = (ua ?? "").trim();
  if (!s) return true;
  return BOT_RE.test(s);
}

/** "mobile" when the user agent says so, else "desktop". A coarse split —
 *  enough to know whether the site works on phones, which is the question. */
export function deviceOf(ua: string | null | undefined): "mobile" | "desktop" {
  return /mobile|android|iphone|ipad|ipod|windows phone/i.test(ua ?? "") ? "mobile" : "desktop";
}

/** The path as stored: no query string, no fragment, no trailing slash
 *  (except the root), at most 200 characters, always starting with "/". */
export function cleanPath(raw: string | null | undefined): string {
  let p = String(raw ?? "").trim();
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (p.length > 200) p = p.slice(0, 200);
  return p || "/";
}

/** The referrer's HOST, lower-cased, without a leading "www."; empty for
 *  our own hosts (a hop between our pages is navigation, not discovery)
 *  and for anything that is not http(s). Mirrors the marketing site's
 *  assets/handoff.js so both sides name a referrer the same way. */
export function refHost(referrer: string | null | undefined, ownHosts: Iterable<string> = Object.keys(HOST_LABELS)): string | null {
  const s = (referrer ?? "").trim();
  if (!s) return null;
  let host: string;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // the beacon may already send a bare host
    host = s.toLowerCase().replace(/^www\./, "");
    if (!/^[a-z0-9.-]+$/.test(host)) return null;
  }
  for (const own of ownHosts) {
    const o = own.toLowerCase().replace(/^www\./, "");
    if (host === o || host.endsWith("." + o)) return null;
  }
  return host.slice(0, 120) || null;
}

/** The visitor token: sha256 of a salt that changes every UTC day, the
 *  address and the user agent — 32 hex characters. Deterministic within a
 *  day (so a returning tab is one visitor), useless across days. */
export function visitorHash(secret: string, ip: string | null, ua: string | null, day: string): string {
  return createHash("sha256").update(`${secret}|${day}|${ip ?? ""}|${ua ?? ""}`).digest("hex").slice(0, 32);
}

/** Today as YYYY-MM-DD in UTC — the salt's rotation key. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ── shaping for the console ─────────────────────────────────────────────────

export type DailyRow = { day: string; host: string; visits: number; visitors: number };
export type MinuteRow = { minute: string; visits: number; visitors: number };
export type DayPoint = { day: string; visits: number; visitors: number };

/** The last `days` UTC days as YYYY-MM-DD, oldest first, ending today. */
export function lastDays(days: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = days - 1; i >= 0; i--) out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** A gap-free daily series (oldest first) summed over the hosts given, or
 *  over every non-staff host when none are. `visitors` across hosts is a
 *  SUM of per-host uniques — a person who visited both sites counts twice,
 *  which is stated on the page rather than hidden. */
export function dailySeries(rows: DailyRow[], days: number, hosts?: Set<string>, now: Date = new Date()): DayPoint[] {
  const keep = (h: string) => (hosts ? hosts.has(h) : !STAFF_HOSTS.has(h));
  const by = new Map<string, DayPoint>();
  for (const d of lastDays(days, now)) by.set(d, { day: d, visits: 0, visitors: 0 });
  for (const r of rows) {
    if (!keep(r.host)) continue;
    const p = by.get(String(r.day).slice(0, 10));
    if (!p) continue;
    p.visits += Number(r.visits) || 0;
    p.visitors += Number(r.visitors) || 0;
  }
  return [...by.values()];
}

/** Totals over the series. */
export function sumSeries(points: DayPoint[]): { visits: number; visitors: number } {
  return points.reduce((a, p) => ({ visits: a.visits + p.visits, visitors: a.visitors + p.visitors }), { visits: 0, visitors: 0 });
}

/** Per-host totals over the rows (all days present), non-staff first,
 *  busiest first. */
export function hostTotals(rows: DailyRow[]): Array<{ host: string; label: string; visits: number; visitors: number; staff: boolean }> {
  const by = new Map<string, { visits: number; visitors: number }>();
  for (const r of rows) {
    const cur = by.get(r.host) ?? { visits: 0, visitors: 0 };
    cur.visits += Number(r.visits) || 0;
    cur.visitors += Number(r.visitors) || 0;
    by.set(r.host, cur);
  }
  return [...by.entries()]
    .map(([host, t]) => ({ host, label: hostLabel(host), staff: STAFF_HOSTS.has(host), ...t }))
    .sort((a, b) => Number(a.staff) - Number(b.staff) || b.visits - a.visits || a.host.localeCompare(b.host));
}

/** A gap-free per-minute series for the last `minutes` minutes, oldest
 *  first — the live ticker's strip. */
export function minuteSeries(rows: MinuteRow[], minutes: number, now: Date = new Date()): Array<{ minute: string; visits: number }> {
  const end = Math.floor(now.getTime() / 60_000) * 60_000;
  const by = new Map<number, number>();
  for (let i = minutes - 1; i >= 0; i--) by.set(end - i * 60_000, 0);
  for (const r of rows) {
    const t = Math.floor(new Date(r.minute).getTime() / 60_000) * 60_000;
    if (by.has(t)) by.set(t, (by.get(t) ?? 0) + (Number(r.visits) || 0));
  }
  return [...by.entries()].map(([t, visits]) => ({ minute: new Date(t).toISOString(), visits }));
}

/** Compact number for a tile: 1234 → "1.2k", 1234567 → "1.2m". */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
