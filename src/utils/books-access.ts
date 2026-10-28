import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { founderEmails } from "@/utils/platform-admin";
import { bareHost, isStaffDomain } from "@/utils/console-routing";
import { fixturePath } from "@/utils/books/store";
import {
  BOOKS_LOGIN_PATH,
  booksHostname,
  booksModeOn,
  booksAllows,
  strongestRole,
  type BookAction,
  type BookRole,
} from "@/utils/books-routing";

// Who may enter the book app (books.sketchcast.app), and as what.
//
// The founder's rule (2026-10-27): "only staff accounts with email IDs ending
// with @sketchcast.app can be given access to approve. i will grant the access
// as needed. i should have complete default access". So:
//   1. an @sketchcast.app address is ALWAYS required — nobody else, ever;
//   2. the founder allow-list (FOUNDER_EMAILS) is `owner` on every book;
//   3. anyone else holds exactly the grants in pub_members (0161) — being a
//      platform admin grants nothing here by itself.
//
// Mirrors library-access.ts: a page guard that redirects, an API guard that
// returns null (callers answer 404 so the app is not probeable), and the whole
// surface is dark while NEXT_PUBLIC_BOOKS_HOST is unset.

export type BookMember = {
  id: string;
  email: string;
  /** owner, or the strongest all-books grant; null when the member only holds per-book grants */
  globalRole: BookRole | null;
  /** per-book grants by work uid */
  books: Record<string, BookRole>;
};

async function bookMemberUser(): Promise<BookMember | null> {
  if (!booksModeOn()) return null;
  // Development fixture only (fixturePath() is null in production): the screens
  // read a local importer bundle, and the reader is a stand-in owner.
  if (fixturePath()) return { id: "fixture", email: "fixture@sketchcast.app", globalRole: "owner", books: {} };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const email = (user.email ?? "").toLowerCase();
  if (!isStaffDomain(email)) return null;
  if (founderEmails().includes(email)) return { id: user.id, email, globalRole: "owner", books: {} };
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("pub_members")
      .select("work_uid, role")
      .eq("user_id", user.id)
      .is("revoked_at", null);
    if (error || !data?.length) return null;
    const rows = data as { work_uid: string | null; role: string }[];
    const globalRole = strongestRole(rows.filter((r) => r.work_uid === null).map((r) => r.role));
    const books: Record<string, BookRole> = {};
    for (const r of rows) {
      if (!r.work_uid) continue;
      const best = strongestRole([r.role, books[r.work_uid] ?? ""].filter(Boolean));
      if (best) books[r.work_uid] = best;
    }
    return { id: user.id, email, globalRole, books };
  } catch {
    return null; // service key missing → founder allow-list only
  }
}

/** The member's role on one book: the stronger of the all-books grant and the book's own. */
export function roleOn(member: BookMember, workUid: string): BookRole | null {
  return strongestRole([member.globalRole ?? "", member.books[workUid] ?? ""].filter(Boolean));
}

export function canOn(member: BookMember, workUid: string, action: BookAction): boolean {
  return booksAllows(roleOn(member, workUid), action);
}

async function notMemberRedirect(): Promise<string> {
  const cfgHost = booksHostname();
  if (!cfgHost) return "/dashboard";
  try {
    const h = await headers();
    if (bareHost(h.get("host")) === cfgHost) return `${BOOKS_LOGIN_PATH}?error=not-member`;
  } catch {
    // headers() unavailable → fall through
  }
  return "/dashboard";
}

/** Page guard. Layouts do NOT guard route handlers — every /api/pub/* route calls isBookMemberRequest(). */
export async function requireBookMember(): Promise<BookMember> {
  const m = await bookMemberUser();
  if (!m) redirect(await notMemberRedirect());
  return m;
}

/** API guard: the member or null (callers answer 404). */
export async function isBookMemberRequest(): Promise<BookMember | null> {
  return bookMemberUser();
}
