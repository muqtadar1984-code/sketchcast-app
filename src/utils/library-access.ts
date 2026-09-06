import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { founderEmails } from "@/utils/platform-admin";
import { bareHost } from "@/utils/console-routing";
import {
  LIBRARY_LOGIN_PATH,
  libraryHostname,
  libraryModeOn,
  libraryAllows,
  type LibraryAction,
  type LibraryRole,
} from "@/utils/library-routing";

// Who may enter the Library portal (library.sketchcast.app), and as what.
//
// Membership, never the e-mail domain (topic-catalogue plan §7.1). The database
// answers with ONE string — library_role(uid), migration 0110 — which is 'admin'
// for an unrevoked platform_admins row, else the library_members role, else
// null. The founder allow-list (FOUNDER_EMAILS) is honoured as 'admin' too, as
// the console does, so a fresh database with the migration applied and no rows
// still lets the founder in.
//
// Mirrors platform-admin.ts: a page guard that redirects, an API guard that
// returns null (callers answer 404 so the portal is not probeable), and the
// whole surface is dark while NEXT_PUBLIC_LIBRARY_HOST is unset.

export type LibraryMember = { id: string; email: string; role: LibraryRole };

async function libraryMemberUser(): Promise<LibraryMember | null> {
  if (!libraryModeOn()) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const email = (user.email ?? "").toLowerCase();
  if (founderEmails().includes(email)) return { id: user.id, email, role: "admin" };
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("library_role", { uid: user.id });
    if (error) return null; // 0110 not applied → nobody but the founder allow-list
    if (data === "admin" || data === "editor" || data === "reviewer") {
      return { id: user.id, email, role: data };
    }
  } catch {
    // service key missing → allow-list only
  }
  return null;
}

// Where to send a non-member. On the portal host that's the portal login with a
// reason (never the teacher /login — it isn't served there); everywhere else
// /dashboard, indistinguishable from a page that doesn't exist.
async function notMemberRedirect(): Promise<string> {
  const cfgHost = libraryHostname();
  if (!cfgHost) return "/dashboard";
  try {
    const h = await headers();
    if (bareHost(h.get("host")) === cfgHost) return `${LIBRARY_LOGIN_PATH}?error=not-member`;
  } catch {
    // headers() unavailable → fall through
  }
  return "/dashboard";
}

/** Page guard: non-members are bounced away. Layouts do NOT guard route
 * handlers — every /api/library/* route must call isLibraryMemberRequest()
 * itself. */
export async function requireLibraryMember(): Promise<LibraryMember> {
  const m = await libraryMemberUser();
  if (!m) redirect(await notMemberRedirect());
  return m;
}

/** API-route guard: the member or null. Callers respond 404 (not 403) on null
 * so the portal's existence isn't probeable. Pass `action` to also require the
 * role to allow it (a reviewer POSTing to a curate route gets the same 404). */
export async function isLibraryMemberRequest(action?: LibraryAction): Promise<LibraryMember | null> {
  const m = await libraryMemberUser();
  if (!m) return null;
  if (action && !libraryAllows(m.role, action)) return null;
  return m;
}
