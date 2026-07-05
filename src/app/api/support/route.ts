import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { supportAgentEnabled } from "@/utils/flags";

export const runtime = "nodejs";

// "Report an issue" on a specific lesson/paper → files a console issue and
// queues the diagnosis agent. OWNERSHIP IS THE GATE: the generation is looked
// up with `.eq("owner_id", user.id)` — reporting someone else's content 404s,
// so the agent can only ever be pointed at the reporter's own tenant data
// (the worker re-checks scope independently). GET polls the reporter's own
// issue (RLS pi_report_read).

const CATEGORIES = ["wrong_chapter", "poor_quality", "missing_parts", "other"] as const;

export async function POST(request: Request) {
  if (!supportAgentEnabled()) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { generationId?: string; category?: string; detail?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const generationId = (body.generationId ?? "").trim();
  const category = CATEGORIES.includes(body.category as (typeof CATEGORIES)[number])
    ? (body.category as string)
    : "other";
  if (!generationId) {
    return NextResponse.json({ error: "generationId is required." }, { status: 400 });
  }

  // The tenant gate: must be the reporter's OWN generation.
  const { data: gen } = await supabase
    .from("generations")
    .select("id, kind, book_id, title")
    .eq("id", generationId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!gen) {
    return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
  }

  const { data: me } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!me || me.role === "student") {
    return NextResponse.json({ error: "Not available for student accounts." }, { status: 403 });
  }

  // Dedupe + rate limit (adversarial-review findings): an open manual report
  // for the same generation is returned as-is instead of farming another paid
  // diagnosis run, and reports are capped per reporter per hour.
  const { data: existing } = await supabase
    .from("platform_issues")
    .select("id")
    .eq("generation_id", gen.id)
    .eq("trigger_source", "manual")
    .neq("status", "resolved")
    .limit(1)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ ok: true, id: existing.id, deduped: true });
  }
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count: recent } = await supabase
    .from("platform_issues")
    .select("id", { count: "exact", head: true })
    .gte("created_at", hourAgo);
  if ((recent ?? 0) >= 5) {
    return NextResponse.json(
      { error: "You've filed several reports recently — give us a little time to work through them." },
      { status: 429 },
    );
  }

  const detail = (body.detail ?? "").trim().slice(0, 2000) || null;
  const { data: issue, error: iErr } = await supabase
    .from("platform_issues")
    .insert({
      reporter_id: user.id,
      reporter_role: me.role,
      school_id: me.school_id ?? null,
      category,
      trigger_source: "manual",
      title: `${category.replace("_", " ")}: ${gen.title || gen.kind || "lesson"}`.slice(0, 200),
      description: detail,
      generation_id: gen.id,
      book_id: gen.book_id,
      context: { url: "/dashboard" },
    })
    .select("id")
    .single();
  if (iErr || !issue) {
    return NextResponse.json({ error: iErr?.message ?? "Could not file the report." }, { status: 500 });
  }

  // Queue the diagnosis job (jobs inserts are service-role only by design).
  try {
    const admin = createAdminClient();
    const { error: jErr } = await admin.from("jobs").insert({
      type: "support_diagnose",
      status: "queued",
      issue_id: issue.id,
      generation_id: gen.id,
      book_id: gen.book_id,
    });
    if (jErr) throw jErr;
  } catch (e) {
    return NextResponse.json(
      { ok: true, id: issue.id, warning: `Report saved; diagnosis queue failed: ${(e as Error).message}` },
    );
  }

  return NextResponse.json({ ok: true, id: issue.id });
}

export async function GET(request: Request) {
  if (!supportAgentEnabled()) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  // RLS: reporters read only their own rows.
  const { data } = await supabase
    .from("platform_issues")
    .select("id, status, agent_action, diagnosis, resolution_note")
    .eq("id", id)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const dx = (data.diagnosis ?? {}) as { user_message?: string };
  return NextResponse.json({
    status: data.status,
    action: data.agent_action,
    message: dx.user_message ?? null,
    resolution: data.resolution_note ?? null,
  });
}
