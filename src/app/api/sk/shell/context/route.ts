import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skShellEnabledFor } from "@/utils/flags";
import { LOCALE_COOKIE, isLocale } from "@/i18n/locales";
import { loadContext } from "@/sk/shell/context";
import { openAnnounced, openMemory, rememberAnnounced, sealAnnounced, sealMemory, verifyMemory } from "@/sk/shell/memory";
import { allowedFor } from "@/sk/shell/registry";
import { SK_SHELL_PROMPT_VERSION, shellGreeting } from "@/sk/shell/prompt";
import { kitNotices } from "@/sk/shell/kit-tray";

export const runtime = "nodejs";

// /api/sk/shell/context — the Shell's warm start (S0). Same gate as the turn
// route; returns readiness, the localised greeting, the capability names this
// user may use on this page, and the signed memory blob to echo on the first
// turn.
//
// S2 (job tray, "the next greeting"): POST {path, memory?, announced?} — the
// panel sends the conversation it carries and the signed note of kits already
// announced. When an SK-started kit has finished or failed since, the greeting
// LEADS with one line per kit (at most 2, kit-tray.ts kitNotices — time-boxed,
// skipped silently on error), the kit ids are recorded in the memory blob and
// the note, and the first ready kit becomes the blob's one-turn `offer` so
// "yes" / "open it" opens it. The memory returned is the conversation's own
// when it still applies (openMemory's rules), else a fresh one. GET (no body)
// still works: no carried conversation, nothing announced yet.

type ContextInput = { path: string; memory?: string; announced?: string };

async function warmStart(input: ContextInput) {
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
  const now = new Date();
  const ctx = await loadContext({
    session: supabase,
    admin,
    cookies: cookieStore,
    user,
    profile: { role, school_id: schoolId },
    collector: { path: input.path },
    locale: isLocale(localeCookie) ? localeCookie : "en",
    now,
  });

  // What was announced before: the carried conversation's list (any blob WE
  // signed — even one too old to continue) and the long-lived note.
  const prior = [...new Set([...(verifyMemory(input.memory)?.announced ?? []), ...openAnnounced(input.announced, ctx.user.id)])];
  const notices = await kitNotices(ctx, { session: supabase, now }, prior);
  const memory = rememberAnnounced(openMemory(input.memory, ctx, now).memory, { ids: notices.ids, prior, entities: notices.entities, offer: notices.offer });

  return NextResponse.json({
    ready: true,
    greeting: [...notices.lines, shellGreeting(ctx.user.locale)].join("\n"),
    capabilities: allowedFor(ctx).map((c) => c.meta.name),
    memory: sealMemory(memory),
    sessionId: memory.sessionId,
    announced: sealAnnounced(ctx.user.id, memory.announced ?? []),
    role: ctx.user.role,
    hat: ctx.user.hat,
    page: ctx.place.page,
    locale: ctx.user.locale,
    promptVersion: SK_SHELL_PROMPT_VERSION,
  });
}

const pathOf = (v: unknown): string => (typeof v === "string" && v ? v : "/dashboard").slice(0, 300);
const blobOf = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

export async function GET(request: Request) {
  return warmStart({ path: pathOf(new URL(request.url).searchParams.get("path")) });
}

export async function POST(request: Request) {
  let raw: unknown = null;
  try {
    raw = await request.json();
  } catch {
    raw = null;
  }
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return warmStart({ path: pathOf(b.path), memory: blobOf(b.memory, 64_000), announced: blobOf(b.announced, 4_000) });
}
