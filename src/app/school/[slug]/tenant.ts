import { headers } from "next/headers";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { SLUG_RE, schoolHostname } from "@/utils/school-routing";
import { bareHost } from "@/utils/console-routing";

export type Tenant = { id: string; slug: string; displayName: string; branding: Record<string, unknown> | null };

// Resolve a tenant SERVER-SIDE from the slug (never trust the client for data
// access — this only picks which school's landing/login renders; RLS on
// school_id stays the real guard). Archived/unknown slugs resolve to null → 404.
export async function resolveTenant(rawSlug: string): Promise<Tenant | null> {
  const slug = rawSlug.toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  try {
    // Service role: the landing page renders pre-auth, and schools_read RLS
    // only lets signed-in members read their own school row.
    const admin = createAdminClient();
    const { data } = await admin
      .from("schools")
      .select("id, slug, name, display_name, branding")
      .eq("slug", slug)
      .eq("status", "active")
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.id as string,
      slug,
      displayName: (data.display_name as string | null) || (data.name as string),
      branding: (data.branding as Record<string, unknown> | null) ?? null,
    };
  } catch {
    // No service key (e.g. bare local dev): fall back to the SECURITY DEFINER
    // resolver — id only, display name degrades to the slug.
    const supabase = await createClient();
    const { data } = await supabase.rpc("school_by_slug", { p_slug: slug });
    if (!data) return null;
    return { id: data as string, slug, displayName: slug, branding: null };
  }
}

/** Public base path for tenant links: /{slug} on the portal host, /school/{slug}
 * when the internal path is used directly (local dev, feature off). */
export async function tenantBasePath(slug: string): Promise<string> {
  const h = await headers();
  const onPortalHost = schoolHostname() !== null && bareHost(h.get("host")) === schoolHostname();
  return onPortalHost ? `/${slug}` : `/school/${slug}`;
}
