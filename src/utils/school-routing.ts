// Host-based routing for the per-school portal.
//
// Each school gets a public address on ONE shared host:
//   school.sketchcast.app/{slug}            → the school's landing / role picker
//   school.sketchcast.app/{slug}/{role}     → role-scoped login (principal |
//                                             teacher | student | parent)
// Served by the SAME Next.js deployment as the main app: the proxy REWRITES
// /{slug}/… on the school host to the internal /school/{slug}/… route group, so
// the app code is shared across every tenant and only the DATA (school_id + RLS)
// and per-tenant schools.config/branding differ. This module is the pure decision
// layer (same pattern as console-routing.ts) so the rules are testable without a
// live request.
//
// Everything here is DORMANT unless NEXT_PUBLIC_SCHOOL_HOST is set — that single
// env var is the kill switch. Unset ⇒ no host rules; the internal /school/…
// pages remain reachable by path (useful in local dev) but nothing is rewritten.
//
// Security note: the slug only picks WHICH login page renders. Data access is
// never trusted to the slug — the server resolves slug → school_id via
// school_by_slug() (0042) and the verify endpoint denies a signed-in user whose
// school doesn't match; RLS on school_id remains the real guard throughout.

import { bareHost } from "./console-routing";

export const PORTAL_ROLES = ["principal", "teacher", "student", "parent"] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number];

export function isPortalRole(s: string): s is PortalRole {
  return (PORTAL_ROLES as readonly string[]).includes(s);
}

/** Slug shape (must match the schools_slug_chk DB constraint in 0042). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Top-level app segments that can never be tenant slugs — they route as-is on
 * the school host (auth handlers, APIs, the shared dashboards after login…). */
export const RESERVED_SEGMENTS = new Set([
  "api",
  "auth",
  "console",
  "dashboard",
  "invite",
  "login",
  "signup",
  "schoolsignup",
  "onboarding",
  "staff-login",
  "school",
  "favicon.ico",
  "_next",
]);

/** The configured school-portal hostname (canonicalized), or null when off. */
export function schoolHostname(): string | null {
  const h = bareHost(process.env.NEXT_PUBLIC_SCHOOL_HOST || "");
  return h ? h : null;
}

/** True when the portal host feature is enabled at all (env set). */
export function schoolModeOn(): boolean {
  return schoolHostname() !== null;
}

export type SchoolDecision = { type: "pass" } | { type: "rewrite"; path: string };

/**
 * Decide what the proxy should do for one request.
 *
 * On the SCHOOL host:
 *   "/"                → rewrite to /school (the find-your-school page)
 *   "/{slug}[/…]"      → rewrite to /school/{slug}[/…] (tenant landing / logins)
 *   reserved segments  → pass (auth, api, and — after login — /dashboard, which
 *                        works on this host because it's the same deployment and
 *                        the Supabase session cookie was set on this origin)
 * Anywhere else (main host, or feature off): always pass.
 */
export function schoolRoute(opts: { schoolHostname: string | null; host: string; path: string }): SchoolDecision {
  const { schoolHostname: cfgHost, host, path } = opts;
  if (!cfgHost || bareHost(host) !== cfgHost) return { type: "pass" };

  if (path === "/") return { type: "rewrite", path: "/school" };

  const seg = path.split("/")[1] ?? "";
  if (RESERVED_SEGMENTS.has(seg)) return { type: "pass" };
  if (!SLUG_RE.test(seg)) return { type: "pass" }; // not a possible slug → 404 naturally

  return { type: "rewrite", path: `/school${path}` };
}
