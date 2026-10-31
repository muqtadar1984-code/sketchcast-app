import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { loadQuizArtifact, type QuizStore } from "@/app/api/quiz/logic";
import { learnerKitFor, learnerWorksheetIn } from "@/utils/present/learner";
import { learnerGate, loadLearnerKits } from "@/utils/present/learner-server";
import { claudeClient, claudeConfigured, claudeModel } from "@/utils/claude-backend";
import { skBedrockRegion, skModelMap } from "@/sk/claude-target";
import { meterStudentTurn } from "@/sk/student-cap";
import { skDbFrom } from "@/sk/store-supabase";
import { practise, type PracticeDeps } from "@/sk/practice/service";
import type { HelpModelCall } from "@/sk/practice/help";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/present/learn/answer — worksheet practice on the student Board
// (SK student Board plan 2026-10-31, phase 2).
//
//   { sessionId, kitId, generationId, questionId, kind: "answer" | "help", answer?, ms? }
//   → PracticeReply { outcome, correct, attemptNo, wrong, rung, help, answer, done, gap, concept }
//
// CHECKS, in order — each one a refusal that writes nothing:
//   401  not signed in;
//   403  not a learner (role student with the SK Shell on — learnerGate);
//   400  a malformed body (ids must be uuids, the question id ≤ 80 chars);
//   404  the kit is not one of HER assigned kits, or the worksheet is not a
//        PROJECTED worksheet of that kit (utils/present/learner.ts: shared to
//        her by one of her own generation_shares rows, done, not withdrawn,
//        never a test paper / plan / bank / answer key) — read through HER
//        session, so RLS confines it before the app's own rule does;
//   404  the question is not on the worksheet; 400 no usable answer;
//   403  the practice session id is another student's; 409 another kit's;
//   409  the question is already finished; 429 a double tap or too many tries.
// The student id is the verified session's, never the body's.
//
// THE KEY STAYS HERE. questions.json is read with the service role on the
// server (loadQuizArtifact, the quiz's own loader); the reply carries the key
// only at the ladder's "answer" rung (src/sk/practice/service.ts).
//
// COST. Checking is free. Help comes from the paper, else the cache, else ONE
// Haiku 5.5 call per question × rung — metered against the student's fair-use
// cap (sk-student.cap, the Shell's daily count) and cached for every later
// student (sk_practice_help).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = () => NextResponse.json({ error: "Not found." }, { status: 404 });

/** The route's model call: Haiku through the app's Claude path, in SK's region. Never in tests (mocked). */
const defaultCall: HelpModelCall = async (req) => {
  const client = claudeClient({ region: skBedrockRegion() });
  const res = (await client.messages.create({
    model: claudeModel(req.model, skModelMap()),
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
  })) as unknown as { content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number } };
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");
  return { text, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } };
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!(await learnerGate(supabase, user)).ok) return NextResponse.json({ error: "Practice is for students." }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    const b = await request.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("not an object");
    body = b as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const sessionId = String(body.sessionId ?? "");
  const kitId = String(body.kitId ?? "");
  const generationId = String(body.generationId ?? "");
  const questionId = typeof body.questionId === "string" ? body.questionId : "";
  const kind = body.kind === "help" ? "help" : body.kind === "answer" || body.kind === undefined ? "answer" : null;
  if (!UUID.test(sessionId) || !UUID.test(kitId) || !UUID.test(generationId) || !questionId || questionId.length > 80 || !kind) {
    return NextResponse.json({ error: "That answer didn't look right — please try again." }, { status: 400 });
  }

  // HER kit, through HER session (RLS + her own shares), and a worksheet of it.
  const kit = learnerKitFor(await loadLearnerKits(supabase), kitId);
  if (!kit || !learnerWorksheetIn(kit, generationId)) return NOT_FOUND();

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Practice is unavailable right now." }, { status: 500 });
  }

  const deps: PracticeDeps = {
    db: skDbFrom(admin),
    loadPaper: (id) => loadQuizArtifact(admin as unknown as QuizStore, id),
    call: claudeConfigured() ? defaultCall : null,
    meter: async () => (await meterStudentTurn(admin, user.id)).ok,
    log: (m) => console.warn(m),
  };
  try {
    const r = await practise(deps, { studentId: user.id, sessionId, kitId: kit.id, generationId, questionId, kind, answer: body.answer, ms: body.ms });
    return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[sk-practice] answer failed:", (e as Error).message);
    return NextResponse.json({ error: "Could not check that answer." }, { status: 500 });
  }
}

/** Like /api/present/learn/kit: Next's automatic OPTIONS would advertise the route. */
export async function OPTIONS() {
  return NOT_FOUND();
}
