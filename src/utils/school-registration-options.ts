// The vocabulary of the school registration form (0100, Phase 3) — PURE, so the
// client form and the server route import the same sets. (Exporting these from
// the "use client" form would hand the route client-reference proxies, not
// values — the boundary src/__tests__/server-client-boundary.test.ts guards.)
//
// These are stable machine keys: stored in schools.meta / school_registrations
// and read back by the console. The LABELS live in the dictionary under
// app.schoolSignup.finish.{types,sizes,roles,curriculumOptions}. Adding an
// option means adding it here AND a label in en.json (then the nine
// translations) — the route refuses anything it does not know.

import { RESERVED_SEGMENTS } from "./school-routing";

export const SCHOOL_TYPES = ["primary", "secondary", "k12", "international", "tuition", "university", "other"] as const;
export const SIZE_BANDS = ["under100", "s100_500", "s500_1500", "over1500"] as const;
export const REGISTRANT_ROLES = ["principal", "administrator", "coordinator", "teacher", "it"] as const;
export const CURRICULA = ["malaysia", "cbse", "cambridge", "ib", "other"] as const;

export type SchoolType = (typeof SCHOOL_TYPES)[number];
export type SizeBand = (typeof SIZE_BANDS)[number];
export type RegistrantRole = (typeof REGISTRANT_ROLES)[number];
export type Curriculum = (typeof CURRICULA)[number];

/** The value when it is one of `allowed`, else null — the route's second gate. */
export function pickOption<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** The slug the DB will mint for a school name — 0042's school_slugify plus
 * 0100's reserved-slug rule — for the address preview on the form. The "-2"
 * uniquifier for a taken slug cannot be previewed. */
export function previewSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "school";
  return RESERVED_SEGMENTS.has(base) ? `${base}-school` : base;
}
