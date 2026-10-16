// The catalogue funnel (plan §5.5, Phase E): what the Ready-made kits did,
// from the tables that already record it — catalogue_unlocks (one row per
// permanent unlock) and catalogue_events (unlock, weekly_limit, download,
// adopt, written only by server routes and the database). No event pipeline,
// no new table. Pure: rows in, numbers out, so the console page is a thin
// render and the arithmetic is tested.

export type UnlockRow = { user_id: string; topic_id: string; source: string; week_start: string; unlocked_at: string };
export type EventRow = { user_id: string | null; topic_id: string | null; event: string; meta: Record<string, unknown> | null; created_at: string };

export type Totals = {
  unlockers: number;
  unlocks: number;
  downloads: number;
  adopts: number;
  /** Teachers who copied at least one kit into their Library. */
  adopters: number;
  weeklyLimitHits: number;
  /** Library copies that were assigned to a class or a child (the end of the funnel). */
  assignedCopies: number;
};

export type WeekRow = { week: string; unlockers: number; unlocks: number; downloads: number; adopts: number; weeklyLimitHits: number };
export type TopicRow = { topic_id: string; unlocks: number; downloads: number; adopts: number };
export type TierRow = { tier: string; unlocks: number; weeklyLimitHits: number };

/** Monday 00:00 UTC of the ISO week an instant falls in, as YYYY-MM-DD — the
 * same week the database's catalogue_week_start() uses for the allowance. */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

const inc = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

export function buildCatalogueFunnel(
  unlocks: readonly UnlockRow[],
  events: readonly EventRow[],
  /** generation ids of catalogue copies (params.catalogue_ref) that carry at least one share. */
  assignedCopyIds: readonly string[],
): { totals: Totals; weeks: WeekRow[]; topics: TopicRow[]; tiers: TierRow[] } {
  const unlockers = new Set(unlocks.map((u) => u.user_id));
  const adopters = new Set<string>();
  let downloads = 0;
  let adopts = 0;
  let limits = 0;

  const weeks = new Map<string, WeekRow>();
  const week = (iso: string): WeekRow => {
    const w = weekOf(iso);
    let row = weeks.get(w);
    if (!row) {
      row = { week: w, unlockers: 0, unlocks: 0, downloads: 0, adopts: 0, weeklyLimitHits: 0 };
      weeks.set(w, row);
    }
    return row;
  };
  const weekUnlockers = new Map<string, Set<string>>();
  const topics = new Map<string, TopicRow>();
  const topic = (id: string): TopicRow => {
    let row = topics.get(id);
    if (!row) {
      row = { topic_id: id, unlocks: 0, downloads: 0, adopts: 0 };
      topics.set(id, row);
    }
    return row;
  };
  const tierUnlocks = new Map<string, number>();
  const tierLimits = new Map<string, number>();

  for (const u of unlocks) {
    const w = week(u.unlocked_at);
    w.unlocks++;
    (weekUnlockers.get(w.week) ?? weekUnlockers.set(w.week, new Set()).get(w.week)!).add(u.user_id);
    topic(u.topic_id).unlocks++;
  }
  for (const e of events) {
    const tier = typeof e.meta?.tier === "string" ? (e.meta.tier as string) : "unknown";
    if (e.event === "download") {
      downloads++;
      week(e.created_at).downloads++;
      if (e.topic_id) topic(e.topic_id).downloads++;
    } else if (e.event === "adopt") {
      adopts++;
      if (e.user_id) adopters.add(e.user_id);
      week(e.created_at).adopts++;
      if (e.topic_id) topic(e.topic_id).adopts++;
    } else if (e.event === "weekly_limit") {
      limits++;
      week(e.created_at).weeklyLimitHits++;
      inc(tierLimits, tier);
    } else if (e.event === "unlock") {
      inc(tierUnlocks, tier);
    }
  }
  for (const [w, set] of weekUnlockers) week(w + "T00:00:00Z").unlockers = set.size;

  const tiers = [...new Set([...tierUnlocks.keys(), ...tierLimits.keys()])]
    .map((t) => ({ tier: t, unlocks: tierUnlocks.get(t) ?? 0, weeklyLimitHits: tierLimits.get(t) ?? 0 }))
    .sort((a, b) => b.unlocks - a.unlocks || a.tier.localeCompare(b.tier));

  return {
    totals: {
      unlockers: unlockers.size,
      unlocks: unlocks.length,
      downloads,
      adopts,
      adopters: adopters.size,
      weeklyLimitHits: limits,
      assignedCopies: new Set(assignedCopyIds).size,
    },
    weeks: [...weeks.values()].sort((a, b) => (a.week < b.week ? 1 : -1)),
    topics: [...topics.values()].sort((a, b) => b.unlocks - a.unlocks || b.downloads - a.downloads).slice(0, 15),
    tiers,
  };
}
