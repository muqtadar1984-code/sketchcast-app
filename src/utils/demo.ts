// Demo-account helpers for the staff console (staff-only, English-only surface).
//
// "Demo" here means profiles.is_demo = true (migration 0081): accounts seeded
// as sales props by scripts/seed-school.ts, not real users. The console splits
// them out of the roster and excludes them from every Overview metric.

// The shared password scripts/seed-school.ts provisions for EVERY account in a
// seeded demo tenant (its documented --password default) — deliberately stable
// because a salesperson logs in live during a pitch. The console is staff-only
// (@sketchcast.app), so surfacing it here is intentional, not a leak.
export const SHARED_DEMO_PASSWORD = "SketchDemo2026";

// Coverage was once decided by PROVENANCE (only seeder-provisioned accounts
// verifiably used the shared password; legacy/hand-made demo rows rendered
// "—"). On 2026-08-18 the founder had every is_demo account RESET to the
// shared password (verified in-DB: 53/53 bcrypt-match), so when the caller
// can say "this row is a demo account", that alone answers it. The pattern
// rules remain as the fallback for callers without the flag.
const SEEDED_TENANT_ADULT = /^[^@]+@(?!students\.)[^@.]+\.sketchcast\.app$/i;
const STUDENTS_DOMAIN = /@students\.sketchcast\.app$/i;

/**
 * The password staff can use to log into a demo account, or null when it is
 * not covered by the shared demo password — the console renders null as "—".
 */
export function demoAccountPassword(
  email: string | null | undefined,
  schoolId?: string | null,
  isDemo?: boolean | null,
): string | null {
  if (isDemo === true) return SHARED_DEMO_PASSWORD;
  const e = (email ?? "").trim();
  if (!e) return null;
  if (SEEDED_TENANT_ADULT.test(e)) return SHARED_DEMO_PASSWORD;
  if (STUDENTS_DOMAIN.test(e) && schoolId) return SHARED_DEMO_PASSWORD;
  return null;
}

/** Split a profile list into real users (is_demo false/null) and demo accounts. */
export function partitionByDemo<T extends { is_demo?: boolean | null }>(
  rows: T[],
): { real: T[]; demo: T[] } {
  const real: T[] = [];
  const demo: T[] = [];
  for (const r of rows) (r.is_demo === true ? demo : real).push(r);
  return { real, demo };
}

/**
 * Schools whose known members are ALL demo accounts (and that have at least one
 * member) — i.e. the seeded demo tenants. A school with no member profiles is
 * treated as real: we cannot tell, and losing a genuinely empty school from the
 * count would be the worse error.
 */
export function demoSchoolIds(
  profiles: { school_id?: string | null; is_demo?: boolean | null }[],
): Set<string> {
  const candidates = new Set<string>();
  const hasReal = new Set<string>();
  for (const p of profiles) {
    if (!p.school_id) continue;
    candidates.add(p.school_id);
    if (p.is_demo !== true) hasReal.add(p.school_id);
  }
  for (const id of hasReal) candidates.delete(id);
  return candidates;
}
