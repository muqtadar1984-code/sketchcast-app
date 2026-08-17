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

// The shared password is only known for accounts scripts/seed-school.ts (or
// add-subject-teachers.ts) actually provisioned, so coverage is decided by
// PROVENANCE, not by is_demo alone:
//   - tenant adults live at @{slug}.sketchcast.app (a SUBDOMAIN — never the
//     bare @sketchcast.app of staff/founder-made accounts like
//     principal.test@sketchcast.app, and never the synthetic students domain);
//   - tenant students share the synthetic @students.sketchcast.app domain with
//     REAL students, so a students-domain email counts only when the account
//     belongs to a school (the seeder always attaches its students; the 6/29
//     standalone seed batch predates the seeder and its password is unknown).
// Everything else — legacy supabase/seed_demo.mjs accounts, hand-made test
// accounts, the standalone batch — renders as "—" in the console.
const SEEDED_TENANT_ADULT = /^[^@]+@(?!students\.)[^@.]+\.sketchcast\.app$/i;
const STUDENTS_DOMAIN = /@students\.sketchcast\.app$/i;

/**
 * The password staff can use to log into a demo account, or null when it is
 * not covered by the shared demo password — the console renders null as "—".
 */
export function demoAccountPassword(
  email: string | null | undefined,
  schoolId?: string | null,
): string | null {
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
