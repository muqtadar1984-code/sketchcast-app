// Host-based routing for the SketchCast Library portal (topic catalogue).
//
// The portal lives on its OWN subdomain (library.sketchcast.app) with its own
// sign-in, separate from the teacher app (app.sketchcast.app) and from the staff
// console (console.sketchcast.app). All three are served by the SAME Next.js
// deployment; this module is the pure decision layer that the proxy (middleware)
// and the member guard share, so the rules are testable without a live request.
// Same shape as console-routing.ts on purpose — one pattern, three hosts.
//
// Who gets in is NOT decided here. Access is membership (library_members, 0110;
// platform admins are members implicitly) and the console grants it. There is no
// e-mail-domain gate: the founder wants to be able to add an outside subject
// reviewer without making them staff (topic-catalogue plan §7.1, 2026-09-06).
//
// Everything here is DORMANT unless NEXT_PUBLIC_LIBRARY_HOST is set — that single
// env var is the kill switch for the whole portal. Unset ⇒ the portal does not
// exist anywhere: /library and /library-login redirect to /dashboard on every
// host, indistinguishable from pages that do not exist.

import { bareHost } from "./console-routing";

export const LIBRARY_LOGIN_PATH = "/library-login";
export const LIBRARY_HOME = "/library";

/** The configured portal hostname (canonicalized), or null when the portal is
 * off. Reads NEXT_PUBLIC_LIBRARY_HOST so it resolves the same on the server and
 * in the middleware runtime. `localhost` works for local dev (the port is
 * stripped by bareHost). */
export function libraryHostname(): string | null {
  const h = bareHost(process.env.NEXT_PUBLIC_LIBRARY_HOST || "");
  return h ? h : null;
}

/** True when the portal exists at all (env set). */
export function libraryModeOn(): boolean {
  return libraryHostname() !== null;
}

export type LibraryDecision = { type: "pass" } | { type: "redirect"; path: string };

function isLibraryPath(path: string): boolean {
  return path === LIBRARY_HOME || path.startsWith(LIBRARY_HOME + "/");
}

/**
 * Decide what the proxy should do for one request.
 *
 * On the LIBRARY host: only the portal, the shared /auth handlers, /api, and the
 * portal login are served; everything else is bounced into the portal world;
 * unauthenticated portal hits go to the portal login (never the teacher /login,
 * never the staff login).
 *
 * On any OTHER host — and everywhere when the portal is off — /library and
 * /library-login redirect to /dashboard, so the portal is reachable ONLY on its
 * own subdomain. Everything else passes.
 */
export function libraryRoute(opts: {
  libraryHostname: string | null;
  host: string;
  path: string;
  hasUser: boolean;
}): LibraryDecision {
  const { libraryHostname: cfgHost, host, path, hasUser } = opts;
  const isLib = isLibraryPath(path);
  const isLogin = path === LIBRARY_LOGIN_PATH;

  if (!cfgHost) {
    // Portal off: its pages do not exist anywhere.
    return isLib || isLogin ? { type: "redirect", path: "/dashboard" } : { type: "pass" };
  }

  const onLibraryHost = bareHost(host) === cfgHost;
  const isAuth = path === "/auth" || path.startsWith("/auth/");
  const isApi = path === "/api" || path.startsWith("/api/");

  if (onLibraryHost) {
    if (isAuth || isApi || isLogin) return { type: "pass" };
    if (isLib) return hasUser ? { type: "pass" } : { type: "redirect", path: LIBRARY_LOGIN_PATH };
    return { type: "redirect", path: hasUser ? LIBRARY_HOME : LIBRARY_LOGIN_PATH };
  }

  // Another host while the portal is on: the portal does not exist here.
  if (isLib || isLogin) return { type: "redirect", path: "/dashboard" };
  return { type: "pass" };
}

// ── Roles ────────────────────────────────────────────────────────────────────
// Pure so the API routes and the pages can share one answer.
//
//   admin    — a platform admin (0014). Everything, including publishing.
//   editor   — curates the taxonomy, edits and approves articles, triggers
//              generation, reviews kits, composes worksheets.
//   reviewer — reviews: approve or reject articles, kits and items. Nothing else.
//
// Publishing to YouTube stays with admins (topic-catalogue plan §7.1).

export const LIBRARY_ROLES = ["admin", "editor", "reviewer"] as const;
export type LibraryRole = (typeof LIBRARY_ROLES)[number];

/** The roles the console may GRANT. `admin` is never granted here — it is what
 * a platform_admins row already means. */
export const GRANTABLE_LIBRARY_ROLES = ["editor", "reviewer"] as const;
export type GrantableLibraryRole = (typeof GRANTABLE_LIBRARY_ROLES)[number];

export function isGrantableLibraryRole(s: unknown): s is GrantableLibraryRole {
  return typeof s === "string" && (GRANTABLE_LIBRARY_ROLES as readonly string[]).includes(s);
}

export type LibraryAction =
  | "curate" // topics, aliases, mappings, candidates, harvest
  | "edit_article"
  | "approve" // articles, kits, translations, items
  | "generate" // trigger kit / translation jobs, compose worksheets
  | "publish"; // YouTube

const ALLOWED: Record<LibraryRole, ReadonlySet<LibraryAction>> = {
  admin: new Set<LibraryAction>(["curate", "edit_article", "approve", "generate", "publish"]),
  editor: new Set<LibraryAction>(["curate", "edit_article", "approve", "generate"]),
  reviewer: new Set<LibraryAction>(["approve"]),
};

export function libraryAllows(role: LibraryRole | null | undefined, action: LibraryAction): boolean {
  if (!role) return false;
  return ALLOWED[role]?.has(action) ?? false;
}
