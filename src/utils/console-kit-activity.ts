// Per-user Ready-made kits activity for the staff console — the Users roster's
// Kit views / Kits columns and the account page's "Ready-made kits" card.
// Pure fold over catalogue_unlocks (one row per permanent unlock) and
// catalogue_events (view, unlock, download, watch, adopt, …), each selected
// ONCE by the page — the same no-N+1 doctrine as console-user-stats.ts.

export type KitActivity = {
  /** Kits page loads ('view' events, 2026-10-23 onward). */
  views: number;
  lastViewedAt: string | null;
  /** Kits unlocked — catalogue_unlocks rows, permanent, one per topic. */
  unlocks: number;
  /** Document files served ('download'). */
  downloads: number;
  /** Kit videos played from storage ('watch'). */
  watches: number;
  /** Pieces copied into the Library ('adopt'). */
  adopts: number;
  /** Times the weekly allowance said no ('weekly_limit'). */
  weeklyLimitHits: number;
};

export const EMPTY_KIT_ACTIVITY: KitActivity = Object.freeze({
  views: 0,
  lastViewedAt: null,
  unlocks: 0,
  downloads: 0,
  watches: 0,
  adopts: 0,
  weeklyLimitHits: 0,
});

export type KitUnlockRow = { user_id: string };
export type KitEventRow = { user_id: string | null; event: string; created_at: string };

/** Fold the two selects into one per-user map. Users with no activity have no entry. */
export function aggregateKitActivity(unlocks: readonly KitUnlockRow[], events: readonly KitEventRow[]): Map<string, KitActivity> {
  const out = new Map<string, KitActivity>();
  const get = (id: string): KitActivity => {
    let a = out.get(id);
    if (!a) {
      a = { ...EMPTY_KIT_ACTIVITY };
      out.set(id, a);
    }
    return a;
  };
  for (const u of unlocks) get(u.user_id).unlocks++;
  for (const e of events) {
    if (!e.user_id) continue;
    if (e.event === "view") {
      const a = get(e.user_id);
      a.views++;
      if (!a.lastViewedAt || e.created_at > a.lastViewedAt) a.lastViewedAt = e.created_at;
    } else if (e.event === "download") get(e.user_id).downloads++;
    else if (e.event === "watch") get(e.user_id).watches++;
    else if (e.event === "adopt") get(e.user_id).adopts++;
    else if (e.event === "weekly_limit") get(e.user_id).weeklyLimitHits++;
    // 'unlock' is counted from catalogue_unlocks, the permanent record; other
    // events (backfills, …) are not a person's activity.
  }
  return out;
}

export type KitTopicRow = { topic_id: string; unlocked_at: string | null; downloads: number; watches: number; adopts: number };

/** One account's kits, topic by topic: every unlocked topic (newest first),
 * then any topic touched without an unlock (a free video play). */
export function kitTopicsFor(
  unlocks: readonly { topic_id: string; unlocked_at: string }[],
  events: readonly { topic_id: string | null; event: string }[],
): KitTopicRow[] {
  const by = new Map<string, KitTopicRow>();
  const get = (id: string): KitTopicRow => {
    let r = by.get(id);
    if (!r) {
      r = { topic_id: id, unlocked_at: null, downloads: 0, watches: 0, adopts: 0 };
      by.set(id, r);
    }
    return r;
  };
  for (const u of unlocks) get(u.topic_id).unlocked_at = u.unlocked_at;
  for (const e of events) {
    if (!e.topic_id) continue;
    if (e.event === "download") get(e.topic_id).downloads++;
    else if (e.event === "watch") get(e.topic_id).watches++;
    else if (e.event === "adopt") get(e.topic_id).adopts++;
  }
  return [...by.values()].sort((a, b) => {
    if (a.unlocked_at && b.unlocked_at) return a.unlocked_at < b.unlocked_at ? 1 : -1;
    if (a.unlocked_at || b.unlocked_at) return a.unlocked_at ? -1 : 1;
    return a.topic_id.localeCompare(b.topic_id);
  });
}
