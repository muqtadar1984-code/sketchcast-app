// Host-based routing for the SketchCast book app (books.sketchcast.app).
//
// The book app lives on its OWN subdomain with its own sign-in, separate from
// the teacher app, the staff console and the Library portal. All of them are
// served by the SAME Next.js deployment; this module is the pure decision layer
// the proxy and the staff guard share, so the rules are testable without a live
// request. Same shape as library-routing.ts on purpose — one pattern, four hosts.
//
// Who gets in is NOT decided here (books-access.ts does): @sketchcast.app staff
// only, the founder by default, everyone else by a grant (founder 2026-10-27).
//
// Everything here is DORMANT unless NEXT_PUBLIC_BOOKS_HOST is set — that single
// env var is the kill switch. Unset ⇒ the book app does not exist anywhere:
// /books and /books-login redirect to /dashboard on every host.

import { bareHost } from "./console-routing";

export const BOOKS_LOGIN_PATH = "/books-login";
export const BOOKS_HOME = "/books";

/** The configured book-app hostname (canonicalized), or null when it is off.
 * `localhost` works for local dev (the port is stripped by bareHost). */
export function booksHostname(): string | null {
  const h = bareHost(process.env.NEXT_PUBLIC_BOOKS_HOST || "");
  return h ? h : null;
}

export function booksModeOn(): boolean {
  return booksHostname() !== null;
}

export type BooksDecision = { type: "pass" } | { type: "redirect"; path: string };

function isBooksPath(path: string): boolean {
  return path === BOOKS_HOME || path.startsWith(BOOKS_HOME + "/");
}

/**
 * Decide what the proxy should do for one request.
 *
 * On the BOOKS host: only the book app, the shared /auth handlers, /api, and the
 * book-app login are served; everything else is bounced into the book app;
 * unauthenticated hits go to the book-app login.
 *
 * On any OTHER host — and everywhere when the app is off — /books and
 * /books-login redirect to /dashboard. Everything else passes.
 */
export function booksRoute(opts: {
  booksHostname: string | null;
  host: string;
  path: string;
  hasUser: boolean;
}): BooksDecision {
  const { booksHostname: cfgHost, host, path, hasUser } = opts;
  const isBooks = isBooksPath(path);
  const isLogin = path === BOOKS_LOGIN_PATH;

  if (!cfgHost) {
    return isBooks || isLogin ? { type: "redirect", path: "/dashboard" } : { type: "pass" };
  }

  const onBooksHost = bareHost(host) === cfgHost;
  const isAuth = path === "/auth" || path.startsWith("/auth/");
  const isApi = path === "/api" || path.startsWith("/api/");

  if (onBooksHost) {
    if (isAuth || isApi || isLogin) return { type: "pass" };
    if (isBooks) return hasUser ? { type: "pass" } : { type: "redirect", path: BOOKS_LOGIN_PATH };
    return { type: "redirect", path: hasUser ? BOOKS_HOME : BOOKS_LOGIN_PATH };
  }

  if (isBooks || isLogin) return { type: "redirect", path: "/dashboard" };
  return { type: "pass" };
}

// ── Roles ────────────────────────────────────────────────────────────────────
//   owner    — the founder and platform admins with a staff address: every
//              right, on every book, by default.
//   approver — may approve (Gate D, book, print) on the books granted.
//   editor   — may edit and run steps on unapproved content (later slices).
//   reviewer — may read, comment and run reports.
// Slice 1 is read-only: every role may read; the rights matter from R1 on.

export const BOOK_ROLES = ["owner", "approver", "editor", "reviewer"] as const;
export type BookRole = (typeof BOOK_ROLES)[number];

export type BookAction = "read" | "run_report" | "run" | "edit" | "approve" | "grant";

const ALLOWED: Record<BookRole, ReadonlySet<BookAction>> = {
  owner: new Set<BookAction>(["read", "run_report", "run", "edit", "approve", "grant"]),
  approver: new Set<BookAction>(["read", "run_report", "run", "edit", "approve"]),
  editor: new Set<BookAction>(["read", "run_report", "run", "edit"]),
  reviewer: new Set<BookAction>(["read", "run_report"]),
};

export function booksAllows(role: BookRole | null | undefined, action: BookAction): boolean {
  if (!role) return false;
  return ALLOWED[role]?.has(action) ?? false;
}

/** The strongest of several grants (a member may hold one per book plus an all-books row). */
export function strongestRole(roles: readonly string[]): BookRole | null {
  for (const r of BOOK_ROLES) if (roles.includes(r)) return r;
  return null;
}
