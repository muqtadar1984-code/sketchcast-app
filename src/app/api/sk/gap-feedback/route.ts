import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skShellEnabledFor } from "@/utils/flags";
import { LOCALE_COOKIE, isLocale } from "@/i18n/locales";
import { recordGaps, type SkGapInput } from "@/sk/gaps/store";
import { THUMBS_PER_HOUR, parseGapFeedback } from "@/sk/gaps/feedback";

export const runtime = "nodejs";

// POST /api/sk/gap-feedback — the 👎 on one of SK's replies (SK gap tracker,
// signal E; founder 2026-10-31: "build it now").
//
// Same gate as /api/sk/shell/turn: a signed-in user for whom SK is on (every
// role, students included). Body:
//   { turnId, question, reply, note?, previous?: [{q, a}] (≤ 2), page? }
// One row, signal `thumbs_down`, `wanted` = her note. A second 👎 on the same
// turn is a no-op (0177's unique (turn_id, signal)). The question is stored
// AS ASKED (book codes not masked — founder decision). A user may send at
// most THUMBS_PER_HOUR in an hour (the rows are service-role writes of her
// own text; the cap keeps a script from filling the table).

type Gate =
  | { ok: true; user: { id: string }; role: string | null }
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
  return { ok: true, user: { id: user.id }, role };
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
  const body = parseGapFeedback(raw);
  if ("error" in body) return NextResponse.json({ error: body.error }, { status: 400 });

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Not available." }, { status: 503 });
  }

  // The hourly cap (a failed count does not block her: the write is best-effort anyway).
  try {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from("sk_gaps").select("id", { count: "exact", head: true }).eq("user_id", g.user.id).eq("signal", "thumbs_down").gte("created_at", since);
    if ((count ?? 0) >= THUMBS_PER_HOUR) return NextResponse.json({ error: "Thanks — that's plenty for now." }, { status: 429 });
  } catch {
    /* count unavailable: carry on */
  }

  const cookieStore = await cookies();
  const localeCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  const gap: SkGapInput = {
    turnId: body.turnId,
    userId: g.user.id,
    role: g.role,
    locale: isLocale(localeCookie) ? localeCookie : null,
    page: body.page,
    signal: "thumbs_down",
    question: body.question,
    reply: body.reply,
    wanted: body.note,
    route: "feedback",
    context: body.previous.length ? { previous: body.previous } : null,
  };
  await recordGaps(admin, [gap]);
  return NextResponse.json({ ok: true });
}
