import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { platformConsoleEnabled } from "@/utils/flags";

// Platform staff = the founder allowlist (env, bootstrap superset) plus
// unrevoked platform_admins rows (migration 0014). Not a user_role: a staff
// member keeps their normal school-side identity, mirroring the grant model
// used for coordinators and parents-to-be.

export function founderEmails(): string[] {
  return (process.env.FOUNDER_EMAILS || "muqtadar.quraishi@sketchcast.app,muqtadar1984@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function platformAdminUser(): Promise<{ id: string; email: string } | null> {
  if (!platformConsoleEnabled()) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const email = (user.email ?? "").toLowerCase();
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

/** Page guard: non-staff are bounced to /dashboard (indistinguishable from a
 * page that doesn't exist). Layouts do NOT guard route handlers — every
 * /api/console/* route must call isPlatformAdminRequest() itself. */
export async function requirePlatformAdmin(): Promise<{ id: string; email: string }> {
  const admin = await platformAdminUser();
  if (!admin) redirect("/dashboard");
  return admin;
}

/** API-route guard: returns the staff user or null. Callers respond 404 (not
 * 403) on null so the console's existence isn't probeable. */
export async function isPlatformAdminRequest(): Promise<{ id: string; email: string } | null> {
  return platformAdminUser();
}
