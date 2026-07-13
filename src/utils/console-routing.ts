// Host-based routing for the SketchCast staff console.
//
// The console lives on its OWN subdomain (console.sketchcast.app) with its own
// sign-in, separate from the teacher app (app.sketchcast.app). Both are served by
// the SAME Next.js deployment; this module is the pure decision layer that the
// proxy (middleware) and the staff guard share, so the rules are testable without
// a live request.
//
// Everything here is DORMANT unless NEXT_PUBLIC_CONSOLE_HOST is set — that single
// env var is the kill switch for the whole subdomain feature. Unset ⇒ legacy
// behavior (console served at /console on the main host, no host rules, no domain
// gate), so deploying this code changes nothing in prod until you opt in.

export const STAFF_LOGIN_PATH = "/staff-login";
export const STAFF_DOMAIN = "@sketchcast.app";

/** Console access is restricted to the company domain. */
export function isStaffDomain(email: string | null | undefined): boolean {
  return typeof email === "string" && email.trim().toLowerCase().endsWith(STAFF_DOMAIN);
}

/** Canonicalize a hostname: trim, lowercase, drop the port, and strip a trailing
 * dot. The trailing-dot FQDN form ("console.sketchcast.app.") is DNS/TLS-equivalent
 * to the bare host, so it must normalize identically — otherwise an exact-equality
 * host check would misroute it. */
function canonicalHost(h: string): string {
  return h.trim().toLowerCase().split(":")[0].replace(/\.+$/, "");
}

/** The configured console hostname (canonicalized), or null when the subdomain
 * feature is off. Reads NEXT_PUBLIC_CONSOLE_HOST so it resolves the same on the
 * server and in the middleware runtime. */
export function consoleHostname(): string | null {
  const h = canonicalHost(process.env.NEXT_PUBLIC_CONSOLE_HOST || "");
  return h ? h : null;
}

/** True when the subdomain feature is enabled at all (env set). */
export function consoleModeOn(): boolean {
  return consoleHostname() !== null;
}

/** Normalize a Host header to a bare, canonical hostname. */
export function bareHost(host: string | null | undefined): string {
  return canonicalHost(host || "");
}

export type ConsoleDecision = { type: "pass" } | { type: "redirect"; path: string };

/**
 * Decide what the proxy should do for one request.
 *
 * On the CONSOLE host: only the console, the shared /auth handlers, /api, and the
 * staff-login page are served; everything teacher-facing is bounced into the
 * console world; unauthenticated console hits go to the staff login (never the
 * teacher /login).
 *
 * On the MAIN host (while console mode is on): the console and staff-login are
 * removed entirely (redirect to /dashboard — indistinguishable from a page that
 * doesn't exist), so the console is reachable ONLY on its subdomain.
 *
 * When console mode is off: always "pass" (legacy behavior, handled elsewhere).
 */
export function consoleRoute(opts: {
  consoleHostname: string | null;
  host: string;
  path: string;
  hasUser: boolean;
}): ConsoleDecision {
  const { consoleHostname: cfgHost, host, path, hasUser } = opts;
  if (!cfgHost) return { type: "pass" };

  const onConsoleHost = bareHost(host) === cfgHost;
  const isAuth = path === "/auth" || path.startsWith("/auth/");
  const isApi = path === "/api" || path.startsWith("/api/");
  const isConsole = path === "/console" || path.startsWith("/console/");
  const isStaffLogin = path === STAFF_LOGIN_PATH;

  if (onConsoleHost) {
    // Shared auth handlers + APIs always pass (sign-in, confirm, sign-out, the
    // console's own /api/console + /api/autofix callbacks).
    if (isAuth || isApi || isStaffLogin) return { type: "pass" };
    if (isConsole) return hasUser ? { type: "pass" } : { type: "redirect", path: STAFF_LOGIN_PATH };
    // Any other path on the console host (/, /dashboard, /login, /signup, …) is
    // not part of the console → send it into the console world.
    return { type: "redirect", path: hasUser ? "/console" : STAFF_LOGIN_PATH };
  }

  // Main host, console mode on: the console does not exist here.
  if (isConsole || isStaffLogin) return { type: "redirect", path: "/dashboard" };
  return { type: "pass" };
}
