import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { teacherBetaEnabled } from "@/utils/flags";

export const runtime = "nodejs";

// TWO feedback flows share this route, split by the `action` field:
//
//  1. action = "submit" | "later" — the founder-requested questionnaire
//     (feedback_requests / feedback_responses, 0083). Authenticated users
//     acting on their OWN open request only. The tables are service-role only,
//     so reads/writes go through the admin client AFTER the ownership check.
//
//  2. no action (legacy) — beta feedback submission. SAVE FIRST (beta_feedback
//     row — the unique teacher_id constraint enforces single submission),
//     EMAIL SECOND (Resend notification to the founder; a send failure never
//     loses the feedback — logged + retried once, then the request still
//     succeeds).

const FEEDBACK_TO = process.env.FEEDBACK_EMAIL_TO || "muqtadar.quraishi@sketchcast.app";
const FEEDBACK_FROM = "SketchCast AI <noreply@sketchcast.app>";

type Body = {
  overall?: number;
  lesson_quality?: number;
  deck_quality?: number;
  ease_of_use?: number;
  worked_well?: string | null;
  improve?: string | null;
  trigger_type?: "auto" | "manual";
};

function rating(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

async function sendEmail(subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("feedback email skipped: RESEND_API_KEY not set");
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FEEDBACK_FROM, to: [FEEDBACK_TO], subject, text }),
  });
  if (!res.ok) console.error("feedback email failed:", res.status, await res.text().catch(() => ""));
  return res.ok;
}

// ── Questionnaire actions (submit / later) ──────────────────────────────────

const MOST_USED = ["presentation", "worksheet", "exam_paper", "lesson_plan", "activity", "case_study", "none"];
const SNOOZE_DAYS = 3;
const DAY_MS = 86_400_000;

type RequestActionBody = {
  action: "submit" | "later";
  request_id?: string;
  ease?: number;
  usefulness?: number;
  quality?: number;
  most_used?: string;
  blocker?: string | null;
  wish?: string | null;
  contact_ok?: boolean;
};

async function handleRequestAction(body: RequestActionBody) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const requestId = (body.request_id ?? "").trim();
  if (!requestId) return NextResponse.json({ error: "request_id is required." }, { status: 400 });

  // Service-role tables (0083) — but only after proving the request is the
  // caller's own. A request that isn't theirs is indistinguishable from one
  // that doesn't exist.
  const admin = createAdminClient();
  const { data: reqRow, error: qErr } = await admin
    .from("feedback_requests")
    .select("id, user_id, responded_at")
    .eq("id", requestId)
    .maybeSingle();
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
  if (!reqRow || reqRow.user_id !== user.id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (reqRow.responded_at) {
    return NextResponse.json({ error: "Already answered — thank you!" }, { status: 409 });
  }

  if (body.action === "later") {
    const until = new Date(Date.now() + SNOOZE_DAYS * DAY_MS).toISOString();
    const { error: uErr } = await admin
      .from("feedback_requests")
      .update({ snoozed_until: until })
      .eq("id", requestId);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, snoozed_until: until });
  }

  // submit
  const ease = rating(body.ease);
  const usefulness = rating(body.usefulness);
  const quality = rating(body.quality);
  if (!ease || !usefulness || !quality) {
    return NextResponse.json({ error: "All three ratings (1–5) are required." }, { status: 400 });
  }
  const mostUsed = body.most_used ?? "";
  if (!MOST_USED.includes(mostUsed)) {
    return NextResponse.json({ error: "most_used is invalid." }, { status: 400 });
  }
  const blocker = (body.blocker ?? "").toString().slice(0, 4000) || null;
  const wish = (body.wish ?? "").toString().slice(0, 4000) || null;

  const { error: insErr } = await admin.from("feedback_responses").insert({
    request_id: requestId,
    user_id: user.id,
    ease,
    usefulness,
    quality,
    most_used: mostUsed,
    blocker,
    wish,
    contact_ok: body.contact_ok === true,
  });
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  // Stamp AFTER the response row exists — a failure between the two leaves an
  // open request (re-submittable), never a stamped request with no answer.
  const { error: stampErr } = await admin
    .from("feedback_requests")
    .update({ responded_at: new Date().toISOString() })
    .eq("id", requestId);
  if (stampErr) console.error("feedback responded_at stamp failed:", requestId, stampErr.message);

  return NextResponse.json({ ok: true });
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  // Parse once, up front, so the two flows can share the body. `parsed`
  // stays undefined on bad JSON and the legacy path keeps its original
  // behaviour (flag → auth → gate → THEN the 400).
  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = await request.json();
  } catch {
    parseFailed = true;
  }
  const action =
    parsed && typeof parsed === "object" ? (parsed as { action?: unknown }).action : undefined;
  if (action === "submit" || action === "later") {
    return handleRequestAction({ ...(parsed as object), action } as RequestActionBody);
  }
  return handleBetaFeedback(parsed as Body | undefined, parseFailed);
}

// ── Legacy beta feedback ────────────────────────────────────────────────────

async function handleBetaFeedback(body: Body | undefined, parseFailed: boolean) {
  if (!teacherBetaEnabled()) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  // Beta adults only — every adult can teach (admins/coordinators included),
  // but students (minors) and non-beta accounts must not be able to file "beta
  // feedback" (it would also consume a unique slot + email the founder).
  const { data: me } = await supabase
    .from("profiles")
    .select("role, beta_tester")
    .eq("id", user.id)
    .maybeSingle();
  const gate = me as { role?: string; beta_tester?: boolean } | null;
  // Accept the beta flag OR the DB's live trial scope (my_trial_pin, 0057):
  // pre-0012 accounts have beta_tester=false yet see the trial surfaces —
  // their feedback must not 403 (review finding).
  let allowed = !!gate?.beta_tester;
  if (!allowed) {
    const { data: tp, error: tpErr } = await supabase.rpc("my_trial_pin");
    const scope = (Array.isArray(tp) ? tp[0] : tp) as { in_scope?: boolean } | null;
    allowed = !tpErr && !!scope?.in_scope;
  }
  if (!gate?.role || gate.role === "student" || !allowed) {
    return NextResponse.json({ error: "Feedback is for beta teachers." }, { status: 403 });
  }

  if (parseFailed || !body) {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const overall = rating(body.overall);
  const lessonQ = rating(body.lesson_quality);
  const deckQ = rating(body.deck_quality);
  const ease = rating(body.ease_of_use);
  if (!overall || !lessonQ || !deckQ || !ease) {
    return NextResponse.json({ error: "All four ratings (1–5) are required." }, { status: 400 });
  }
  const workedWell = (body.worked_well ?? "").toString().slice(0, 4000) || null;
  const improve = (body.improve ?? "").toString().slice(0, 4000) || null;
  const triggerType = body.trigger_type === "auto" ? "auto" : "manual";

  // Usage context snapshot (best-effort — never blocks the submission).
  let context: Record<string, unknown> = {};
  try {
    const [{ data: books }, { data: gens }, { data: views }] = await Promise.all([
      supabase.from("books").select("id, title").eq("owner_id", user.id),
      supabase.from("generations").select("id, kind, chapter_ref, status").eq("owner_id", user.id),
      supabase.from("artifact_views").select("generation_id, kind"),
    ]);
    context = {
      book: books?.[0]?.title ?? null,
      chapter_ref: gens?.[0]?.chapter_ref ?? null,
      generations: (gens ?? []).map((g) => g.kind),
      artifacts_viewed: (views ?? []).length,
    };
  } catch {
    // context stays empty
  }

  // 1) Save (the source of truth). User-scoped client → RLS + unique constraint.
  const { error: insErr } = await supabase.from("beta_feedback").insert({
    teacher_id: user.id,
    overall,
    lesson_quality: lessonQ,
    deck_quality: deckQ,
    ease_of_use: ease,
    worked_well: workedWell,
    improve,
    trigger_type: triggerType,
    context,
  });
  if (insErr) {
    if (insErr.code === "23505") {
      return NextResponse.json({ error: "Feedback already received — thank you!" }, { status: 409 });
    }
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  // 2) Notify the founder (retry once; failure never loses the saved feedback).
  const { data: prof } = await supabase.from("profiles").select("full_name").eq("id", user.id).single();
  const who = prof?.full_name || user.email || user.id;
  const subject = `Beta feedback from ${who} — overall ${overall}/5`;
  const text = [
    `Teacher: ${who} (${user.email ?? "no email"})`,
    `Submitted: ${new Date().toISOString()}  ·  trigger: ${triggerType}`,
    "",
    `Overall: ${overall}/5`,
    `Lesson (video) quality: ${lessonQ}/5`,
    `Deck & documents quality: ${deckQ}/5`,
    `Ease of use: ${ease}/5`,
    "",
    `What worked well:\n${workedWell ?? "—"}`,
    "",
    `What to improve:\n${improve ?? "—"}`,
    "",
    `Context: ${JSON.stringify(context)}`,
  ].join("\n");
  let sent = await sendEmail(subject, text).catch(() => false);
  if (!sent) sent = await sendEmail(subject, text).catch(() => false);

  return NextResponse.json({ ok: true, emailed: sent });
}
