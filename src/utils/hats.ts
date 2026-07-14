// "One hat at a time" — the active-role model for multi-role adults.
//
// An account can hold several capabilities at once (a principal is also a
// teacher; a teacher may hold a coordinator grant and be a parent). Instead of
// showing the UNION of everything (the old "admin & teacher" header), the user
// wears exactly ONE hat at a time: only that hat's tabs and surfaces render,
// and a top-right dropdown (or re-entering through a portal role door) switches
// it. The hat is PRESENTATION state — a cookie — never a permission: RLS and
// every server-side check are untouched, so switching hats can only ever narrow
// what's on screen, not widen what's reachable.
//
// This module is pure (no server imports) so the derivation rules are
// unit-testable and safe to import from client components.

export type Hat = "principal" | "coordinator" | "teacher" | "parent";

export const HAT_COOKIE = "sc_hat";

export const HAT_LABEL: Record<Hat, string> = {
  principal: "Principal",
  coordinator: "Coordinator",
  teacher: "Teacher",
  parent: "Parent",
};

export function isHat(s: string | null | undefined): s is Hat {
  return s === "principal" || s === "coordinator" || s === "teacher" || s === "parent";
}

/**
 * The hats an account holds, in seniority order (the first is the default).
 * - principal: the school_admin role
 * - coordinator: holds coordinator_scope rows AND the tenant's analytics suite
 *   is on (a coordinator hat with no School pages would be an empty room)
 * - teacher: every adult (adults implicitly teach — ownership-based access)
 * - parent: has parent_links (caller passes false when the portal flag is off)
 * Students hold no hats: their view never changes and no switcher renders.
 */
export function hatsFor(opts: {
  role: string | null;
  hasScope: boolean;
  hasChildren: boolean;
  analyticsOn: boolean;
}): Hat[] {
  if (!opts.role || opts.role === "student") return [];
  const hats: Hat[] = [];
  if (opts.role === "school_admin") hats.push("principal");
  if (opts.hasScope && opts.analyticsOn) hats.push("coordinator");
  hats.push("teacher");
  if (opts.hasChildren) hats.push("parent");
  return hats;
}

/** The active hat: the cookie when it's a hat the user holds, else the most
 * senior held hat. Null for students / users with no hats. */
export function resolveHat(cookie: string | null | undefined, hats: Hat[]): Hat | null {
  if (!hats.length) return null;
  if (isHat(cookie) && hats.includes(cookie)) return cookie;
  return hats[0];
}

// NOTE: where a hat "lands" lives in hats-server.ts (hatHome) — it depends on
// the tenant's analytics flag, so it can't be pure. Keep exactly one source of
// truth for it.
