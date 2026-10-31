import { after, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skShellEnabledFor } from "@/utils/flags";
import { LOCALE_COOKIE, isLocale } from "@/i18n/locales";
import { loadContext } from "@/sk/shell/context";
import { openMemory, sealMemory } from "@/sk/shell/memory";
import { auditSinkFor } from "@/sk/shell/audit";
import { ACT_LINES, executeAction } from "@/sk/shell/act";
import type { SkActRequest, SkActResponse, SkCollector } from "@/sk/shell/types";
// 2026-10-31: the SK gap tracker — a refused action is a miss (signal B).
import { recordGaps } from "@/sk/gaps/store";

export const runtime = "nodejs";

// POST /api/sk/act — execute a confirmed action (Final Plan §2.5, §8.2, §9.2).
//
// Same gate as /api/sk/shell/turn. The body is the token from a `confirm`
// card plus how it was given; the Context is rebuilt server-side so the
// token's captured context is compared with the LIVE one. Every outcome is
// answered 200 with one line for the UI to speak — a bad token is `refused`,
// never a 4xx that would tell a prober which part failed. The write happens
// only after the token is consumed: inside the per-action RPC (assign, 0164)
// or with THIS request's user-session client (S2 actions, act-core.ts).

type Gate =
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; user: { id: string; email?: string | null; email_confirmed_at?: string | null }; role: string | null; schoolId: string | null }
  | { ok: false; status: number; error: string };

async function gate(): Promise<Gate> {
  if (!skEnabled()) return { ok: false, status: 404, error: "Not available." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Not signed in." };
  const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!(await skShellEnabledFor(supabase, user, role, schoolId))) return { ok: false, status: 404, error: "Not available." };
  return { ok: true, supabase, user, role, schoolId };
}

function parseBody(raw: unknown): SkActRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Invalid body." };
  const b = raw as Record<string, unknown>;
  const token = typeof b.token === "string" ? b.token.trim().slice(0, 200) : "";
  if (!token) return { error: "token is required." };
  const turnId = typeof b.turnId === "string" && b.turnId.trim() && b.turnId.length <= 80 ? b.turnId.trim() : "";
  if (!turnId) return { error: "turnId is required." };
  const via = b.via === "voice" ? "voice" : "click";
  const c = (b.collector && typeof b.collector === "object" ? b.collector : {}) as Record<string, unknown>;
  const clock = c.clock && typeof c.clock === "object" ? (c.clock as SkCollector["clock"]) : undefined;
  const collector: SkCollector = {
    path: typeof c.path === "string" ? c.path.slice(0, 300) : "/dashboard",
    params: c.params && typeof c.params === "object" ? (c.params as Record<string, string>) : undefined,
    selection: c.selection && typeof c.selection === "object" ? (c.selection as SkCollector["selection"]) : undefined,
    board: c.board && typeof c.board === "object" ? (c.board as SkCollector["board"]) : undefined,
    clock:
      clock && typeof clock.day === "number" && typeof clock.minutes === "number" && typeof clock.iso === "string"
        ? { day: clock.day, minutes: clock.minutes, iso: clock.iso.slice(0, 40) }
        : undefined,
    locale: typeof c.locale === "string" ? c.locale.slice(0, 10) : undefined,
  };
  const memory = typeof b.memory === "string" && b.memory.length <= 64_000 ? b.memory : undefined;
  return { turnId, token, via, collector, memory };
}

export async function POST(request: Request) {
  const g = await gate();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const body = parseBody(raw);
  if ("error" in body) return NextResponse.json({ error: body.error }, { status: 400 });

  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  const cookieStore = await cookies();
  const now = new Date();
  const localeCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  const ctx = await loadContext({
    session: g.supabase,
    admin,
    cookies: cookieStore,
    user: g.user,
    profile: { role: g.role, school_id: g.schoolId },
    collector: body.collector,
    locale: isLocale(body.collector.locale) ? body.collector.locale : isLocale(localeCookie) ? localeCookie : "en",
    now,
  });
  const memory = openMemory(body.memory, ctx, now).memory;

  if (!admin) {
    // Tokens live behind the service role; without it no action can run.
    const response: SkActResponse = { ok: false, outcome: "error", summary: ACT_LINES.error, memory: sealMemory(memory) };
    return NextResponse.json(response);
  }

  const out = await executeAction({
    ctx,
    token: body.token,
    via: body.via,
    turnId: body.turnId,
    now,
    clock: body.collector.clock,
    memory,
    admin,
    // S2: the action's write runs AS THE TEACHER through this request's session.
    session: g.supabase,
    sink: auditSinkFor(admin),
  });
  if (out.response.outcome === "refused") {
    // Gap tracker: a refused action (voice on a click-only card, not allowed
    // in this view, the database said no). Written after the reply.
    const db = admin;
    const gap = {
      turnId: body.turnId,
      userId: g.user.id,
      role: ctx.user.role,
      locale: ctx.user.locale,
      page: body.collector.path,
      modality: body.via === "voice" ? "voice" : "text",
      signal: "refusal" as const,
      reply: out.response.summary,
      route: "act",
      tools: out.action ? [out.action] : [],
      context: { items: [{ kind: "act_refused", action: out.action ?? null, via: body.via, reason: typeof out.response.result?.reason === "string" ? out.response.result.reason : null }] },
    };
    const task = () => recordGaps(db, [gap]);
    try {
      after(task);
    } catch {
      void task();
    }
  }
  const response: SkActResponse = { ...out.response, memory: sealMemory(out.memory) };
  return NextResponse.json(response);
}
