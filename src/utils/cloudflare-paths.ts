// Page views per LESSON PAGE from Cloudflare's per-path rows (migration 0139,
// worker catalogue/cloudflare_stats.py) — the catalogue funnel's first step.
// Pure: rows in, a table out, so the console pages stay thin and this is tested.

export type PathRow = { day: string; path: string; requests: number; visits: number };

export type LessonPageRow = {
  slug: string;
  /** Cloudflare "visits": page views whose referrer was not our own site. */
  visits: number;
  /** HTML requests for the page, every locale together. */
  requests: number;
  /** Locale prefixes that saw traffic, e.g. ["", "ar", "hi"] ("" = English). */
  locales: string[];
};

/** `/topics/<slug>` or `/<locale>/topics/<slug>` → the slug and the locale
 * prefix; anything else (the index, the homepage, a card image) → null. */
export function lessonPageOf(path: string): { slug: string; locale: string } | null {
  const m = /^\/(?:([a-z]{2}(?:-[a-z]{2,4})?)\/)?topics\/([a-z0-9][a-z0-9-]{0,79})$/i.exec(path || "");
  if (!m) return null;
  return { slug: m[2].toLowerCase(), locale: (m[1] ?? "").toLowerCase() };
}

/** The lesson pages viewed in the last `days` days (today included), most
 * visited first. Days are compared as YYYY-MM-DD strings in UTC, the way the
 * worker writes them. */
export function lessonPageViews(rows: readonly PathRow[], days: number, now: Date = new Date()): LessonPageRow[] {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1))).toISOString().slice(0, 10);
  const by = new Map<string, LessonPageRow & { localeSet: Set<string> }>();
  for (const r of rows) {
    if (!r.day || r.day < since) continue;
    const page = lessonPageOf(r.path);
    if (!page) continue;
    let row = by.get(page.slug);
    if (!row) {
      row = { slug: page.slug, visits: 0, requests: 0, locales: [], localeSet: new Set() };
      by.set(page.slug, row);
    }
    row.visits += r.visits || 0;
    row.requests += r.requests || 0;
    row.localeSet.add(page.locale);
  }
  return [...by.values()]
    .map(({ localeSet, ...row }) => ({ ...row, locales: [...localeSet].sort() }))
    .sort((a, b) => b.visits - a.visits || b.requests - a.requests || a.slug.localeCompare(b.slug));
}

/** Totals over every lesson page in the window. */
export function lessonPageTotals(pages: readonly LessonPageRow[]): { visits: number; requests: number; pages: number } {
  return pages.reduce((t, p) => ({ visits: t.visits + p.visits, requests: t.requests + p.requests, pages: t.pages + 1 }), { visits: 0, requests: 0, pages: 0 });
}
