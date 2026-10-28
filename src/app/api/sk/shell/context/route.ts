import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skShellEnabledFor } from "@/utils/flags";
import { LOCALE_COOKIE, isLocale } from "@/i18n/locales";
import { loadContext } from "@/sk/shell/context";
import { freshMemory, sealMemory } from "@/sk/shell/memory";
import { allowedFor } from "@/sk/shell/registry";
import { SK_SHELL_PROMPT_VERSION, shellGreeting } from "@/sk/shell/prompt";

export const runtime = "nodejs";

// GET /api/sk/shell/context?path=… — the Shell's warm start (S0). Same gate as
// the turn route; returns readiness, one fixed localised greeting (the
// timetable-aware one comes with slice C), the capability names this user may
// use on this page, and a fresh signed memory blob to echo on the first turn.

export async function GET(request: Request) {
  if (!skEnabled()) return NextResponse.json({ ready: false, error: "Not available." }, { status: 404 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ready: false, error: "Not signed in." }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!(await skShellEnabledFor(supabase, user, role, schoolId))) {
    return NextResponse.json({ ready: false, error: "Not available." }, { status: 404 });
  }

  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  const url = new URL(request.url);
  const path = (url.searchParams.get("path") ?? "/dashboard").slice(0, 300);
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

  return NextResponse.json({
    ready: true,
    greeting: shellGreeting(ctx.user.locale),
    capabilities: allowedFor(ctx).map((c) => c.meta.name),
    memory: sealMemory(freshMemory(ctx, now)),
    role: ctx.user.role,
    hat: ctx.user.hat,
    page: ctx.place.page,
    locale: ctx.user.locale,
    promptVersion: SK_SHELL_PROMPT_VERSION,
  });
}
