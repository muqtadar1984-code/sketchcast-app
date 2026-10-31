// SK gap tracker — the console's per-theme counts. Pure.
//
// A theme's weight is the number of DISTINCT turns that missed in it (one turn
// can carry several signals: SK's own note plus the phrase net, say), so a
// turn counts once. Dismissed misses are not counted.

export type GapCountRow = {
  theme_id: string | null;
  turn_id: string;
  role: string | null;
  signal: string;
  status: string;
  created_at: string;
};

export type ThemeStats = {
  d30: number;
  d7: number;
  total: number;
  roles: [string, number][];
  signals: [string, number][];
  lastSeen: string | null;
};

const DAY = 86_400_000;

const ranked = (m: Map<string, Set<string>>): [string, number][] =>
  [...m.entries()].map(([k, s]) => [k, s.size] as [string, number]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/** theme id → its counts (distinct turns), from the theme's miss rows. */
export function themeStats(rows: GapCountRow[], now: Date): Map<string, ThemeStats> {
  const acc = new Map<
    string,
    { all: Set<string>; d30: Set<string>; d7: Set<string>; roles: Map<string, Set<string>>; signals: Map<string, Set<string>>; last: string | null }
  >();
  const t = now.getTime();
  for (const r of rows) {
    if (!r.theme_id || r.status === "dismissed") continue;
    let a = acc.get(r.theme_id);
    if (!a) {
      a = { all: new Set(), d30: new Set(), d7: new Set(), roles: new Map(), signals: new Map(), last: null };
      acc.set(r.theme_id, a);
    }
    const age = t - Date.parse(r.created_at);
    a.all.add(r.turn_id);
    if (age <= 30 * DAY) a.d30.add(r.turn_id);
    if (age <= 7 * DAY) a.d7.add(r.turn_id);
    const role = r.role || "unknown";
    if (!a.roles.has(role)) a.roles.set(role, new Set());
    a.roles.get(role)!.add(r.turn_id);
    if (!a.signals.has(r.signal)) a.signals.set(r.signal, new Set());
    a.signals.get(r.signal)!.add(r.turn_id);
    if (!a.last || Date.parse(r.created_at) > Date.parse(a.last)) a.last = r.created_at;
  }
  const out = new Map<string, ThemeStats>();
  for (const [id, a] of acc) {
    out.set(id, { d30: a.d30.size, d7: a.d7.size, total: a.all.size, roles: ranked(a.roles), signals: ranked(a.signals), lastSeen: a.last });
  }
  return out;
}

export const EMPTY_STATS: ThemeStats = { d30: 0, d7: 0, total: 0, roles: [], signals: [], lastSeen: null };

/** Most-missed first: 30-day turns, then all-time turns, then most recent. */
export function byWeight<T extends { id: string; last_seen_at: string | null }>(themes: T[], stats: Map<string, ThemeStats>): T[] {
  const s = (t: T) => stats.get(t.id) ?? EMPTY_STATS;
  return themes.slice().sort(
    (a, b) =>
      s(b).d30 - s(a).d30 ||
      s(b).total - s(a).total ||
      Date.parse(b.last_seen_at ?? "1970-01-01") - Date.parse(a.last_seen_at ?? "1970-01-01"),
  );
}
