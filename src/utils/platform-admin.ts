import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { platformConsoleEnabled } from "@/utils/flags";
import { consoleHostname, consoleModeOn, isStaffDomain, bareHost, STAFF_LOGIN_PATH } from "@/utils/console-routing";

// Platform staff = the founder allowlist (env, bootstrap superset) plus
// unrevoked platform_admins rows (migration 0014). Not a user_role: a staff
// member keeps their normal school-side identity, mirroring the grant model
// used for coordinators and parents-to-be.
//
// When the console subdomain is enabled (NEXT_PUBLIC_CONSOLE_HOST set), access is
// ADDITIONALLY hard-restricted to @sketchcast.app accounts — so a non-company
// email can never be staff, even if it slips into the founder allowlist.

export function founderEmails(): string[] {
  return (process.env.FOUNDER_EMAILS || "muqtadar.quraishi@sketchcast.app")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function platformAdminUser(): Promise<{ id: string; email: string } | null> {
  // The console is "on" if EITHER switch says so. Configuring the subdomain
  // (NEXT_PUBLIC_CONSOLE_HOST) implies the console is enabled, so the two env
  // vars can't disagree and lock staff out with a misleading "not staff" bounce.
  if (!platformConsoleEnabled() && !consoleModeOn()) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const email = (user.email ?? "").toLowerCase();
  // Company-domain gate: console is @sketchcast.app-only once the subdomain is on.
  if (consoleModeOn() && !isStaffDomain(email)) return null;
  if (founderEmails().includes(email)) return { id: user.id, email };
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .maybeSingle();
    if (data) return { id: user.id, email };
  } catch {
    // service key or table missing → allowlist only
  }
  return null;
}

// Where to send a non-staff visitor. On the console host that's the staff login
// (never the teacher /login — it doesn't exist there); everywhere else /dashboard,
// which is indistinguishable from a page that doesn't exist.
async function notStaffRedirect(): Promise<string> {
  const cfgHost = consoleHostname();
  if (!cfgHost) return "/dashboard";
  try {
    const h = await headers();
    if (bareHost(h.get("host")) === cfgHost) return `${STAFF_LOGIN_PATH}?error=not-staff`;
  } catch {
    // headers() unavailable → fall through
  }
  return "/dashboard";
}

/** Page guard: non-staff are bounced away (staff login on the console host,
 * /dashboard otherwise). Layouts do NOT guard route handlers — every
 * /api/console/* route must call isPlatformAdminRequest() itself. */
export async function requirePlatformAdmin(): Promise<{ id: string; email: string }> {
  const admin = await platformAdminUser();
  if (!admin) redirect(await notStaffRedirect());
  return admin;
}

/** API-route guard: returns the staff user or null. Callers respond 404 (not
 * 403) on null so the console's existence isn't probeable. */
export async function isPlatformAdminRequest(): Promise<{ id: string; email: string } | null> {
  return platformAdminUser();
}
