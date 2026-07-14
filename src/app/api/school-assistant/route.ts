import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { schoolAssistantEnabledFor } from "@/utils/flags";
import { fetchSchoolHealthRows, computeSchoolHealth } from "@/utils/school-health";
import { buildSchoolBriefingPrompt, briefingGreeting, STARTER_QUESTIONS, type BriefingViewer } from "@/utils/school-assistant/prompt";
import { assistantProvider, type Turn } from "@/utils/assistant/provider";
import { runAssistantTurn } from "@/utils/assistant/orchestrator";

export const runtime = "nodejs";

// The school-briefing assistant — leadership chat grounded in a LIVE snapshot of
// the same analytics the /dashboard/school pages show. Everything is fetched
// under the CALLER'S session, so RLS gives a principal the school and a
// coordinator only their slice; the model can't see (let alone leak) anything
// the viewer couldn't already read. Each turn writes an analytics_access_log
// row — the DPDP trail the Admin page surfaces — and that same log doubles as
// the daily usage cap.

const DAILY_TURN_CAP = 60;
const MAX_HISTORY_TURNS = 8;

function sse(event: string, data: string): string {
  return `event: ${event}\ndata: ${data.replace(/\n/g, "\ndata: ")}\n\n`;
}

type Gate =
  | { ok: true; viewer: BriefingViewer; schoolId: string; schoolName: string; userId: string; role: string }
  | { ok: false; status: number; error: string };

async function gate(supabase: Awaited<ReturnType<typeof createClient>>): Promise<Gate> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Not signed in." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!role || role === "student" || !schoolId) return { ok: false, status: 403, error: "Leadership only." };

  if (!(await schoolAssistantEnabledFor(supabase, schoolId))) {
    return { ok: false, status: 404, error: "Not enabled." };
  }

  // Same access model as the leadership pages: school_admin, or a scope-grant
  // holder (coordinator is a capability, not an enum).
  let viewer: BriefingViewer;
  if (role === "school_admin") {
    viewer = { name: profile?.full_name || "Principal", kind: "principal", scopeLabel: "Whole school" };
  } else {
    const { data: scopes } = await supabase.from("coordinator_scope").select("grade, subject");
    if (!scopes?.length) return { ok: false, status: 403, error: "Leadership only." };
    const grades = [...new Set(scopes.map((s) => s.grade as string))];
    const subjects = [...new Set(scopes.map((s) => s.subject).filter(Boolean))] as string[];
    viewer = {
      name: profile?.full_name || "Coordinator",
      kind: "coordinator",
      scopeLabel:
        (grades.length ? `Grade ${grades.join(", ")}` : "Your grades") +
        (subjects.length ? ` · ${subjects.join(", ")}` : ""),
    };
  }

  const { data: school } = await supabase.from("schools").select("name, display_name").eq("id", schoolId).maybeSingle();
  const schoolName = (school?.display_name as string | null) || (school?.name as string | null) || "your school";
  return { ok: true, viewer, schoolId, schoolName, userId: user.id, role };
}

// Warm-start: readiness + greeting + starter chips (no snapshot, no model call).
export async function GET() {
  const supabase = await createClient();
  const g = await gate(supabase);
  if (!g.ok) return NextResponse.json({ ready: false, error: g.error }, { status: g.status });
  return NextResponse.json({
    ready: true,
    school: g.schoolName,
    greeting: briefingGreeting(g.schoolName, g.viewer),
    starters: STARTER_QUESTIONS,
  });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const g = await gate(supabase);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  let body: { question?: string; history?: { role?: string; content?: string }[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const question = (body.question ?? "").trim().slice(0, 600);
  if (!question) return NextResponse.json({ error: "Ask a question." }, { status: 400 });

  // Client-held history (the briefing is deliberately stateless server-side):
  // validate hard — role whitelist, length caps, most-recent turns only.
  const history: Turn[] = (Array.isArray(body.history) ? body.history : [])
    .filter((t) => (t?.role === "user" || t?.role === "assistant") && typeof t?.content === "string" && t.content.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role as "user" | "assistant", text: String(t.content).slice(0, 2000) }));

  // Daily cap — counted off the audit log itself (one row per turn, below).
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count: turnsToday } = await supabase
    .from("analytics_access_log")
    .select("*", { count: "exact", head: true })
    .eq("actor_id", g.userId)
    .eq("scope", "school_briefing")
    .gte("created_at", dayStart.toISOString());
  if ((turnsToday ?? 0) >= DAILY_TURN_CAP) {
    return NextResponse.json({ error: "Daily briefing limit reached — try again tomorrow." }, { status: 429 });
  }

  // Live snapshot under the caller's RLS session (principal = school,
  // coordinator = slice). Small schools → small JSON; the prompt caps itself.
  const t0 = Date.now();
  const rows = await fetchSchoolHealthRows(supabase);
  const snapshot = computeSchoolHealth(rows);
  const retrievalMs = Date.now() - t0;

  // DPDP audit trail: the briefing names students to leadership, so each turn is
  // recorded exactly like the worklist views (visible on the Admin page). The
  // write is availability-first (a missed row never blocks the briefing) but not
  // SILENT — this log is also the daily-cap counter, so a persistent failure
  // must be visible in the server logs.
  const { error: auditErr } = await supabase.from("analytics_access_log").insert({
    actor_id: g.userId,
    actor_role: g.role,
    school_id: g.schoolId,
    scope: "school_briefing",
    target_kind: "school",
    detail: { question_chars: question.length, at_risk: snapshot.totals.atRisk, students: snapshot.totals.students },
  });
  if (auditErr) console.warn(`school-assistant: audit/cap row failed for ${g.userId}: ${auditErr.message}`);

  const system = buildSchoolBriefingPrompt({
    schoolName: g.schoolName,
    viewer: g.viewer,
    snapshot,
    dateISO: new Date().toISOString(),
  });

  let provider;
  try {
    provider = await assistantProvider();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: string) => controller.enqueue(encoder.encode(sse(event, data)));
      send("meta", JSON.stringify({ state: "ok", scope: g.viewer.scopeLabel }));
      let firstTokenMs: number | null = null;
      try {
        for await (const ev of runAssistantTurn({
          provider,
          system,
          history,
          question,
          maxTokens: 1400,
        })) {
          if (ev.type === "text") {
            if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
            send("text", ev.text);
          } else if (ev.type === "error") {
            send("error", ev.retryable ? `${ev.message} — try again in a moment.` : ev.message);
          } else if (ev.type === "done") {
            send("done", JSON.stringify({ latency: { retrievalMs, firstTokenMs, totalMs: Date.now() - t0 } }));
          }
        }
      } catch {
        send("error", "The briefing hit a snag — try again in a moment.");
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
