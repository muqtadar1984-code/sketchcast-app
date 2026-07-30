import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/utils/supabase/admin";

// Display names for note/reply authors (server-side only). The session query
// sees what profiles RLS grants (self, students they teach, own children); the
// SERVICE ROLE fills the rest — a diary message's byline is part of the
// message, but profiles RLS has no teacher→parent or student→teacher read
// path. Only ids RLS already delivered as note/reply authors are ever looked
// up. Best-effort: no service key (local dev) just means a generic byline.

export async function displayNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const want = [...new Set(ids)];
  if (!want.length) return names;
  type P = { id: string; full_name: string | null; username: string | null };
  const { data } = await supabase.from("profiles").select("id, full_name, username").in("id", want);
  for (const p of (data ?? []) as P[]) names.set(p.id, p.full_name || p.username || "");
  const missing = want.filter((i) => !names.get(i));
  if (missing.length) {
    try {
      const admin = createAdminClient();
      const { data: extra } = await admin.from("profiles").select("id, full_name, username").in("id", missing);
      for (const p of (extra ?? []) as P[]) names.set(p.id, p.full_name || p.username || "");
    } catch {
      /* no service key — generic byline */
    }
  }
  return names;
}
