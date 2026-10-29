import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skShellEnabledFor } from "@/utils/flags";
import { LOCALE_COOKIE, isLocale } from "@/i18n/locales";
import { loadContext } from "@/sk/shell/context";
import { trayKits } from "@/sk/shell/kit-tray";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sk/shell/tray?path=… — the Shell's job tray (S2): her SK-started
// kits of the last 7 days (generations with sk_action_id, owner = her, the
// presentation row per action), newest first, at most 3, each with its state
// (lesson.status's rule, prepare.ts kitState) and the Library link `navigate`
// builds. Same gate as the context route (skShellDecision via
// skShellEnabledFor); read through the USER-SESSION client only. The panel
// polls it every 15 s while a kit is still being made (client/tray.ts).

export async function GET(request: Request) {
  if (!skEnabled()) return NextResponse.json({ kits: [], error: "Not available." }, { status: 404 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ kits: [], error: "Not signed in." }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!(await skShellEnabledFor(supabase, user, role, schoolId))) {
    return NextResponse.json({ kits: [], error: "Not available." }, { status: 404 });
  }

  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  const path = (new URL(request.url).searchParams.get("path") ?? "/dashboard").slice(0, 300);
  const now = new Date();
  const ctx = await loadContext({
    session: supabase,
    admin,
    cookies: cookieStore,
    user,
    profile: { role, school_id: schoolId },
    collector: { path },
    locale: isLocale(localeCookie) ? localeCookie : "en",
    now,
  });
  try {
    const kits = await trayKits(ctx, { session: supabase, now });
    return NextResponse.json({ kits }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.warn("sk-shell.tray read failed", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ kits: [], error: "unavailable" }, { headers: { "Cache-Control": "no-store" } });
  }
}
