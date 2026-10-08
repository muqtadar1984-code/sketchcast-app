// Per-column filters for the console Users roster. The roster is a server
// component rendered from URL search params (no client state), so a filter is
// a query-string key per column: text columns match case-insensitively by
// substring, the three categorical columns (role, school, country) match
// exactly because they are offered as <select>s, numeric columns take a
// MINIMUM, and Joined takes an ISO date PREFIX ("2026-10" = October 2026).
// Pure, so the Users page's filter semantics are unit-tested without Next.

export type RosterFilters = {
  name?: string;
  email?: string;
  role?: string;
  school?: string;
  country?: string;
  language?: string;
  books?: number;
  lessons?: number;
  artifacts?: number;
  errors?: number;
  resolved?: number;
  joined?: string;
};

/** The row shape the filters read — the roster builds one per profile from
 * the same values it renders, so what the staff member sees is what the
 * filter matches. */
export type RosterRow = {
  name: string;
  /** Email on the real/staff tabs, username on the demo tab — the cell's text. */
  identifier: string;
  role: string;
  /** Resolved school NAME (the cell shows the name, not the id); "" when none. */
  school: string;
  /** Alpha-2 code as stored; "" when unknown. */
  country: string;
  /** The rendered Language cell (languageSummary output). */
  language: string;
  books: number;
  lessons: number;
  artifacts: number;
  errors: number;
  resolved: number;
  /** ISO date (YYYY-MM-DD) of profiles.created_at, in UTC. */
  joined: string;
};

export const TEXT_KEYS = ["name", "email", "language", "joined"] as const;
export const EXACT_KEYS = ["role", "school", "country"] as const;
export const MIN_KEYS = ["books", "lessons", "artifacts", "errors", "resolved"] as const;

type Params = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
}

/** Read the filter keys out of a page's search params; blank and malformed
 * values are simply absent (an empty box filters nothing). */
export function parseRosterFilters(params: Params): RosterFilters {
  const f: RosterFilters = {};
  for (const k of TEXT_KEYS) {
    const v = one(params[k]);
    if (v) f[k] = v;
  }
  for (const k of EXACT_KEYS) {
    const v = one(params[k]);
    if (v) f[k] = v;
  }
  for (const k of MIN_KEYS) {
    const v = one(params[k]);
    if (!v) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) f[k] = Math.floor(n);
  }
  return f;
}

export function hasRosterFilters(f: RosterFilters): boolean {
  return Object.keys(f).length > 0;
}

/** True when the row passes EVERY set filter. */
export function matchesRosterFilters(row: RosterRow, f: RosterFilters): boolean {
  const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
  if (f.name !== undefined && !has(row.name, f.name)) return false;
  if (f.email !== undefined && !has(row.identifier, f.email)) return false;
  if (f.language !== undefined && !has(row.language, f.language)) return false;
  if (f.joined !== undefined && !row.joined.startsWith(f.joined)) return false;
  if (f.role !== undefined && row.role !== f.role) return false;
  if (f.school !== undefined && row.school !== f.school) return false;
  if (f.country !== undefined && row.country.toUpperCase() !== f.country.toUpperCase()) return false;
  for (const k of MIN_KEYS) {
    const min = f[k];
    if (min !== undefined && row[k] < min) return false;
  }
  return true;
}

export function applyRosterFilters<T>(items: T[], toRow: (item: T) => RosterRow, f: RosterFilters): T[] {
  if (!hasRosterFilters(f)) return items;
  return items.filter((item) => matchesRosterFilters(toRow(item), f));
}

/** profiles.created_at → the YYYY-MM-DD the Joined filter matches against (UTC). */
export function joinedDate(createdAt: string): string {
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
