// Overview "who is using it" panels (staff console, English-only surface).
// Pure folds over the whole-table selects src/app/console/page.tsx already
// makes once — profiles, generations, books — so nothing here queries. The
// caller passes rows ALREADY stripped of demo and staff accounts
// (metricsExcludedIds); these functions do not know what a demo account is.

export type InsightProfile = {
  id: string;
  role: string;
  full_name: string | null;
  username: string | null;
  country: string | null;
  country_source: string | null;
  school_id: string | null;
};

export type InsightGeneration = {
  owner_id: string;
  kind: string | null;
  status: string;
  created_at: string;
};

export type InsightBook = {
  owner_id: string;
  title: string | null;
  pages: number | null;
  content_hash: string | null;
  language: string | null;
  removed_at: string | null;
};

export type TopTeacher = {
  id: string;
  /** full_name, else username, else a dash — the roster's own fallback order. */
  name: string;
  schoolId: string | null;
  /** Finished lessons: generations with kind='presentation' AND status='done'
   * — the same number the Users page shows under "Lessons", so the two pages
   * can never disagree about who generated what. */
  kits: number;
  /** ISO timestamp of the most recent finished lesson. */
  lastAt: string;
};

/** The adult roles that teach — the Overview's "Teachers" card counts the same two. */
const TEACHING_ROLES = new Set(["teacher", "coordinator"]);

export function topTeachersByKits(
  profiles: InsightProfile[],
  generations: InsightGeneration[],
  limit = 5,
): TopTeacher[] {
  const byId = new Map(profiles.filter((p) => TEACHING_ROLES.has(p.role)).map((p) => [p.id, p]));
  const tally = new Map<string, { kits: number; lastAt: string }>();
  for (const g of generations) {
    if (g.status !== "done") continue;
    // kind NULL is the legacy presentation row (the Overview's byKind fold
    // reads it the same way).
    if ((g.kind ?? "presentation") !== "presentation") continue;
    if (!byId.has(g.owner_id)) continue;
    const t = tally.get(g.owner_id) ?? { kits: 0, lastAt: g.created_at };
    t.kits++;
    if (g.created_at > t.lastAt) t.lastAt = g.created_at;
    tally.set(g.owner_id, t);
  }
  return [...tally.entries()]
    .map(([id, t]) => {
      const p = byId.get(id)!;
      return { id, name: p.full_name || p.username || "—", schoolId: p.school_id, kits: t.kits, lastAt: t.lastAt };
    })
    // most kits first; ties go to the more recent teacher, then by name so the
    // order is stable across renders
    .sort((a, b) => b.kits - a.kits || b.lastAt.localeCompare(a.lastAt) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export type TopCountry = {
  /** ISO 3166-1 alpha-2 as stored in profiles.country. */
  code: string;
  /** English display name, or the code itself when the runtime cannot name it. */
  name: string;
  users: number;
  /** How many of those were ASSUMED (profiles.country_source) rather than
   * stated by the user — the roster's "≈" rule, carried into the count. */
  assumed: number;
};

export type CountryBreakdown = { top: TopCountry[]; unknown: number; total: number };

export function topCountries(profiles: InsightProfile[], limit = 5): CountryBreakdown {
  const tally = new Map<string, { users: number; assumed: number }>();
  let unknown = 0;
  for (const p of profiles) {
    const code = (p.country ?? "").trim().toUpperCase();
    if (!code) {
      unknown++;
      continue;
    }
    const t = tally.get(code) ?? { users: 0, assumed: 0 };
    t.users++;
    if (p.country_source === "assumed") t.assumed++;
    tally.set(code, t);
  }
  const top = [...tally.entries()]
    .map(([code, t]) => ({ code, name: countryName(code), ...t }))
    .sort((a, b) => b.users - a.users || a.code.localeCompare(b.code))
    .slice(0, limit);
  return { top, unknown, total: profiles.length };
}

let displayNames: Intl.DisplayNames | null | undefined;

/** "SA" → "Saudi Arabia". Falls back to the code when ICU is unavailable or the code is unknown. */
export function countryName(code: string): string {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      displayNames = null;
    }
  }
  if (!displayNames) return code;
  try {
    const name = displayNames.of(code);
    // ICU names the reserved code ZZ "Unknown Region"; a stored ZZ should
    // read as the code it is, not as a country called Unknown Region.
    return name && name !== "Unknown Region" ? name : code;
  } catch {
    return code; // not a valid region subtag (e.g. "Q9")
  }
}

export type SharedBook = {
  /** The title of the first upload in the group. */
  title: string;
  /** Live uploads of this book, across everyone. */
  uploads: number;
  /** DISTINCT users who uploaded it — the number that makes it "shared". */
  owners: number;
  /** Distinct book languages seen across the uploads, sorted. */
  languages: string[];
};

/**
 * Books that MORE THAN ONE user uploaded, most widely shared first. Identity
 * is books.content_hash when the upload carries one (the school repository's
 * dedup key); older rows without a hash fall back to title + page count, the
 * same fallback the catalogue harvest uses. Soft-deleted books (removed_at)
 * are not on anyone's shelf and are skipped.
 */
export function sharedBooks(books: InsightBook[], limit = 5): SharedBook[] {
  const groups = new Map<string, { title: string; uploads: number; owners: Set<string>; languages: Set<string> }>();
  for (const b of books) {
    if (b.removed_at !== null) continue;
    const title = (b.title ?? "").trim();
    const key = b.content_hash ? `h:${b.content_hash}` : `t:${title.toLowerCase()}|${b.pages ?? ""}`;
    if (key === "t:|") continue; // no hash, no title: nothing to group on
    const g = groups.get(key) ?? { title: title || "Untitled", uploads: 0, owners: new Set(), languages: new Set() };
    g.uploads++;
    g.owners.add(b.owner_id);
    if (b.language) g.languages.add(b.language);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.owners.size >= 2)
    .map((g) => ({ title: g.title, uploads: g.uploads, owners: g.owners.size, languages: [...g.languages].sort() }))
    .sort((a, b) => b.owners - a.owners || b.uploads - a.uploads || a.title.localeCompare(b.title))
    .slice(0, limit);
}

export type StalledAccounts = {
  /** Teachers, coordinators and parents who never uploaded a book. */
  noBook: { total: number; teachers: number; parents: number };
  /** ...who uploaded at least one book and never started a generation. */
  bookNoGeneration: {
    total: number;
    teachers: number;
    parents: number;
    /** Uploaded AND started a generation, but nothing has ever finished —
     * not in `total`, reported beside it: a different kind of stuck. */
    triedNothingFinished: number;
  };
};

const PARENT_ROLES = new Set(["parent"]);

/**
 * Where adults stop after signing up. Any upload counts, even one since
 * deleted (the person DID upload); "never started" means no generations row
 * of any kind or status. Rows arrive demo/staff/metrics-excluded-filtered,
 * like everything on the Overview.
 */
export function stalledAccounts(
  profiles: { id: string; role: string }[],
  books: { owner_id: string }[],
  generations: { owner_id: string; status: string }[],
): StalledAccounts {
  const uploaded = new Set(books.map((b) => b.owner_id));
  const started = new Set(generations.map((g) => g.owner_id));
  const finished = new Set(generations.filter((g) => g.status === "done").map((g) => g.owner_id));
  const noBook = { total: 0, teachers: 0, parents: 0 };
  const bookNoGeneration = { total: 0, teachers: 0, parents: 0, triedNothingFinished: 0 };
  for (const p of profiles) {
    const teacher = TEACHING_ROLES.has(p.role);
    const parent = PARENT_ROLES.has(p.role);
    if (!teacher && !parent) continue;
    if (!uploaded.has(p.id)) {
      noBook.total++;
      if (teacher) noBook.teachers++;
      else noBook.parents++;
    } else if (!started.has(p.id)) {
      bookNoGeneration.total++;
      if (teacher) bookNoGeneration.teachers++;
      else bookNoGeneration.parents++;
    } else if (!finished.has(p.id)) {
      bookNoGeneration.triedNothingFinished++;
    }
  }
  return { noBook, bookNoGeneration };
}

/**
 * The worker's own job types — the lanes it polls beside customer kits
 * (sketchcast-ai worker/run.py): support, catalogue, YouTube, mailings.
 * None of them is a customer asking for a kit, so none of their outcomes is
 * a customer-facing failure (founder, 2026-10-08: demo and staff failures
 * are development, not product). Kept here, not derived, because a new lane
 * should be added deliberately.
 */
export const SYSTEM_JOB_TYPES: ReadonlySet<string> = new Set([
  "support_diagnose", "issue_resolve",
  "topic_harvest", "topic_derive", "topic_article", "figure_render", "topic_questions",
  "topic_publish", "topic_supersede",
  "youtube_playlists", "youtube_enrich", "announcement_email",
]);

/**
 * Is this a CUSTOMER job — one whose outcome a teacher or parent waited for?
 * False for the worker's own lanes (above) and for catalogue kits
 * (params.catalogue, the Library portal's generations: their owner is the
 * catalogue system account, which the owner rule already excludes — this is
 * the belt to that brace). The owner rule (demo / staff / metrics-excluded)
 * is applied by the caller, which holds the owner maps.
 */
export function isCustomerJob(job: { type: string | null; params?: unknown }): boolean {
  if (job.type && SYSTEM_JOB_TYPES.has(job.type)) return false;
  const params = job.params;
  if (params && typeof params === "object" && (params as { catalogue?: unknown }).catalogue === true) return false;
  return true;
}

export type MonthlyFailure = {
  /** Calendar month, YYYY-MM (UTC). */
  month: string;
  /** Jobs that reached done or error in the month. */
  finished: number;
  failed: number;
  /** failed / finished, or null for a month with nothing finished. */
  rate: number | null;
};

/** 00:00 UTC on the first of the month `monthsBack` months before `at`'s month. */
export function monthStartUtc(at: Date, monthsBack = 0): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - monthsBack, 1);
}

/**
 * Failure rate per calendar month for the last `months` months ending with
 * the current one (to date), oldest first, every month present. Only
 * finished jobs count — done or error — the same rule as the Overview's
 * "Job failure rate" tile, which is this fold's total.
 */
export function monthlyFailureRate(
  jobs: { status: string; created_at: string }[],
  months: number,
  now: Date = new Date(),
): MonthlyFailure[] {
  const buckets = Array.from({ length: months }, (_, i) => ({
    month: new Date(monthStartUtc(now, months - 1 - i)).toISOString().slice(0, 7),
    finished: 0,
    failed: 0,
  }));
  const index = new Map(buckets.map((b, i) => [b.month, i]));
  for (const j of jobs) {
    if (j.status !== "done" && j.status !== "error") continue;
    const t = Date.parse(j.created_at);
    if (Number.isNaN(t)) continue;
    const i = index.get(new Date(t).toISOString().slice(0, 7));
    if (i === undefined) continue;
    buckets[i].finished++;
    if (j.status === "error") buckets[i].failed++;
  }
  return buckets.map((b) => ({ ...b, rate: b.finished ? b.failed / b.finished : null }));
}
