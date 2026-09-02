// Visual Knowledge Library — shared types and pure query helpers for the
// staff gallery at /console/visual-library.
//
// The table (public.visual_assets) and the private storage bucket
// ("visual-assets") are defined by the WORKER repo, in
// database/visual_asset_library.sql on feature/visual-knowledge-library
// (PR #15). The console deliberately does NOT redeclare that schema: two
// definitions of one table is how they drift. It reads what the worker owns,
// and degrades to an explanatory banner when the migration has not been
// applied yet.
//
// Everything here is pure so it can be tested without a database.

/** One row of public.visual_assets, as the console consumes it. */
export type VisualAsset = {
  id: string;
  asset_key: string;
  canonical_key: string;
  asset_type: "visual" | "avatar";
  role: string | null;
  description: string;
  curriculum: string;
  subject: string;
  grade: string;
  age_band: string | null;
  topic: string;
  concepts: string[];
  status: "candidate" | "approved" | "rejected" | "retired";
  provenance: string;
  source: string | null;
  storage_path: string | null;
  content_hash: string | null;
  quality: string | null;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A row plus the short-lived signed URL for its binary (null when the asset
 *  has no storage_path, or signing failed — the card renders a missing state
 *  rather than a broken image). */
export type GalleryItem = { asset: VisualAsset; url: string | null };

/** Columns the grid and detail view actually read. Selecting explicitly keeps
 *  a schema addition from silently widening every page's payload. */
export const ASSET_COLUMNS =
  "id, asset_key, canonical_key, asset_type, role, description, curriculum, " +
  "subject, grade, age_band, topic, concepts, status, provenance, source, " +
  "storage_path, content_hash, quality, usage_count, last_used_at, " +
  "created_at, updated_at";

/** 24 fills a desktop grid without pulling a library's worth of binaries into
 *  one page. The brief is explicit that thousands of assets must not all
 *  load. */
export const PAGE_SIZE = 24;

/** How long a grid's signed URLs stay valid. Long enough to browse and open a
 *  few detail views; a reload re-signs. */
export const SIGN_TTL_SECONDS = 3600;

/** Ceiling on the rows scanned to build the filter dropdowns. The option
 *  lists are derived from the DATA, never hard-coded — the brief is explicit
 *  that unknown subjects must appear — but a full-table scan per page view
 *  would not survive tens of thousands of rows. See facetsFrom(). */
export const FACET_SCAN_LIMIT = 2000;

export type SortKey = "newest" | "oldest" | "key" | "used" | "recent";

export const SORTS: Record<SortKey, { label: string; column: string; ascending: boolean }> = {
  newest: { label: "Newest", column: "created_at", ascending: false },
  oldest: { label: "Oldest", column: "created_at", ascending: true },
  key: { label: "A–Z", column: "canonical_key", ascending: true },
  // usage_count and last_used_at are real columns maintained by the worker's
  // library, so these two are not invented usage data.
  used: { label: "Most used", column: "usage_count", ascending: false },
  recent: { label: "Recently used", column: "last_used_at", ascending: false },
};

export const STATUSES = ["candidate", "approved", "rejected", "retired"] as const;

export type Filters = {
  type: "all" | "visual" | "avatar";
  subject: string;
  grade: string;
  curriculum: string;
  topic: string;
  status: string;
  concept: string;
  q: string;
  sort: SortKey;
  page: number;
};

const asText = (v: string | undefined): string => (v ?? "").trim();

/** Normalise raw searchParams into filters. Unknown values fall back rather
 *  than throwing: a hand-edited URL should not 500 an internal tool. */
export function parseFilters(sp: Record<string, string | undefined>): Filters {
  const type = sp.type === "visual" || sp.type === "avatar" ? sp.type : "all";
  const sort = (sp.sort && sp.sort in SORTS ? sp.sort : "newest") as SortKey;
  const rawPage = Number.parseInt(sp.page ?? "1", 10);
  return {
    type,
    subject: asText(sp.subject),
    grade: asText(sp.grade),
    curriculum: asText(sp.curriculum),
    topic: asText(sp.topic),
    status: STATUSES.includes((sp.status ?? "") as (typeof STATUSES)[number]) ? sp.status! : "",
    concept: asText(sp.concept),
    q: asText(sp.q),
    sort,
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

/** True when any filter is narrowing the view — drives the "clear filters"
 *  affordance and the empty-state wording (an empty library and an
 *  over-filtered one are different problems). */
export function hasActiveFilters(f: Filters): boolean {
  return (
    f.type !== "all" ||
    !!f.subject ||
    !!f.grade ||
    !!f.curriculum ||
    !!f.topic ||
    !!f.status ||
    !!f.concept ||
    !!f.q
  );
}

/** PostgREST `or=` expression for the free-text box.
 *
 *  A GIN tsvector index exists on the table, but it is an EXPRESSION index,
 *  which PostgREST cannot target without a stored/generated column — so this
 *  is ILIKE across the identity and description columns. Adequate at library
 *  scale; replacing it with a generated tsvector column and .textSearch() is
 *  the documented upgrade path.
 *
 *  Commas and parentheses are stripped because they are the separators in
 *  PostgREST's own or() grammar: leaving them in lets a search string change
 *  the shape of the filter rather than its value. */
export function searchExpression(q: string): string | null {
  const safe = q.replace(/[(),*]/g, " ").trim();
  if (!safe) return null;
  const cols = ["asset_key", "canonical_key", "topic", "description", "subject", "curriculum"];
  return cols.map((c) => `${c}.ilike.%${safe}%`).join(",");
}

/** Zero-based [from, to] for a page, as Supabase .range() wants it. */
export function pageRange(page: number, size: number = PAGE_SIZE): [number, number] {
  const from = (Math.max(1, page) - 1) * size;
  return [from, from + size - 1];
}

export function pageCount(total: number, size: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

type FacetRow = Pick<VisualAsset, "subject" | "grade" | "curriculum" | "topic">;

/** Distinct filter options, derived from the rows themselves.
 *
 *  Deliberately not a hard-coded subject list: the brief calls that out, and a
 *  fixed list would hide any subject the library actually contains. Blank and
 *  placeholder values are dropped so the dropdowns stay useful. */
export function facetsFrom(rows: FacetRow[]): {
  subjects: string[];
  grades: string[];
  curricula: string[];
  topics: string[];
} {
  const pick = (key: keyof FacetRow) => {
    const seen = new Set<string>();
    for (const r of rows) {
      const v = (r?.[key] ?? "").toString().trim();
      if (v) seen.add(v);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  };
  return {
    subjects: pick("subject"),
    grades: pick("grade"),
    curricula: pick("curriculum"),
    topics: pick("topic"),
  };
}

/** Postgres "relation does not exist" (42P01) and PostgREST's schema-cache
 *  equivalents. The library migration lives in the worker repo and may not be
 *  applied yet, which must read as an explained banner, not a crash. */
export function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "PGRST205" || err.code === "PGRST106") return true;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("could not find the table");
}

/** Build the querystring for a filter change, preserving everything else and
 *  resetting to page 1 — changing a filter while on page 7 of the old result
 *  set otherwise lands on an empty page. */
export function withFilter(f: Filters, patch: Partial<Filters>): string {
  const next: Filters = { ...f, ...patch };
  const p = new URLSearchParams();
  if (next.type !== "all") p.set("type", next.type);
  if (next.subject) p.set("subject", next.subject);
  if (next.grade) p.set("grade", next.grade);
  if (next.curriculum) p.set("curriculum", next.curriculum);
  if (next.topic) p.set("topic", next.topic);
  if (next.status) p.set("status", next.status);
  if (next.concept) p.set("concept", next.concept);
  if (next.q) p.set("q", next.q);
  if (next.sort !== "newest") p.set("sort", next.sort);
  const page = patch.page ?? 1;
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Rows whose canonical_key appears more than once in the current page.
 *
 *  content_hash carries a unique index (where not null), so byte-identical
 *  duplicates cannot exist. Rows sharing a canonical_key CAN, and the brief
 *  asks for that to be visible in metadata rather than auto-cleaned. */
export function duplicateKeys(rows: { canonical_key: string }[]): Set<string> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.canonical_key, (counts.get(r.canonical_key) ?? 0) + 1);
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k));
}
