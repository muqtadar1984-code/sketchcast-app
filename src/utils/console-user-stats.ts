// Per-user roster aggregates for the staff console (staff-only, English-only
// surface — no i18n keys). Pure fold over the three batched selects the Users
// page already makes ONCE each — books, generations, platform_issues — so 500
// rows render with zero per-row queries (same no-N+1 doctrine as
// src/app/console/page.tsx).

export type UserStats = {
  /** Live books owned — rows soft-deleted by the Library (books.removed_at, 0015) excluded. */
  books: number;
  /** Distinct languages of those live books (books.language, 0056), sorted; nulls skipped. */
  bookLanguages: string[];
  /** Finished lessons: generations with kind='presentation' AND status='done'. */
  lessons: number;
  /**
   * platform_issues reported by the user, ANY status — the durable record of
   * user-facing errors. Generation rows are NOT a stable error count: a
   * requeue flips them back to done.
   */
  errors: number;
  /**
   * Of those issues, how many reached status='resolved'. The status state
   * machine (0014 check constraint) is authoritative; resolved_at is stamped
   * in lockstep by the console API but is derived bookkeeping.
   */
  resolved: number;
};

export const EMPTY_USER_STATS: UserStats = Object.freeze({
  books: 0,
  bookLanguages: [],
  lessons: 0,
  errors: 0,
  resolved: 0,
});

export type StatsBookRow = { owner_id: string; language: string | null; removed_at: string | null };
export type StatsGenRow = { owner_id: string; kind: string | null; status: string };
export type StatsIssueRow = { reporter_id: string | null; status: string };

/** Fold the batched selects into one per-user map. Missing users simply have no entry. */
export function aggregateUserStats(
  books: StatsBookRow[],
  generations: StatsGenRow[],
  issues: StatsIssueRow[],
): Map<string, UserStats> {
  const stats = new Map<string, UserStats>();
  const langSets = new Map<string, Set<string>>();
  const get = (id: string): UserStats => {
    let s = stats.get(id);
    if (!s) {
      s = { books: 0, bookLanguages: [], lessons: 0, errors: 0, resolved: 0 };
      stats.set(id, s);
    }
    return s;
  };

  for (const b of books) {
    if (b.removed_at !== null) continue; // Library soft-delete — not on the shelf
    const s = get(b.owner_id);
    s.books++;
    if (b.language) {
      let set = langSets.get(b.owner_id);
      if (!set) langSets.set(b.owner_id, (set = new Set()));
      set.add(b.language);
    }
  }

  for (const g of generations) {
    if (g.kind === "presentation" && g.status === "done") get(g.owner_id).lessons++;
  }

  for (const i of issues) {
    if (!i.reporter_id) continue; // reporter account deleted (on delete set null)
    const s = get(i.reporter_id);
    s.errors++;
    if (i.status === "resolved") s.resolved++;
  }

  for (const [id, set] of langSets) get(id).bookLanguages = [...set].sort();
  return stats;
}

/**
 * Compact Language cell: the profile's ui_locale (0069), plus the distinct
 * languages of the user's live books when they differ — "en", "en · ar books",
 * "en · ar, hi books". A missing ui_locale renders as "—" (NULL = never chosen)
 * but any book languages still show ("— · ar books"), since most users never
 * touch the picker and the book signal is the interesting half.
 */
export function languageSummary(
  uiLocale: string | null | undefined,
  bookLanguages: string[],
): string {
  const ui = (uiLocale ?? "").trim() || null;
  const others = bookLanguages.filter((l) => l !== ui);
  if (!ui) return others.length ? `— · ${others.join(", ")} books` : "—";
  return others.length ? `${ui} · ${others.join(", ")} books` : ui;
}
