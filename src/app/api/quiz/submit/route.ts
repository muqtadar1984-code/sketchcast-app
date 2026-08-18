import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { submitQuizWith, type QuizStore } from "../logic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/quiz/submit — record an in-app quiz attempt and SCORE IT HERE.
//
// Until 2026-08-18 the browser computed `auto`/`max` in quiz-player.tsx and
// upserted them itself. The live RLS policy (sub_student_rw, FOR ALL, qual
// `student_id = auth.uid()`) let any authenticated session write every column
// of its own submissions row — teacher_score, grade_status, graded_by,
// graded_at included — and no trigger re-derived anything. A student could
// simply write their own grade. Migration 0091 confines the student session to
// mode='file' rows with no marks on them; interactive rows are now authored
// only by the service role, from this route. (0090 is the additive half — it
// adds submissions.attempt_count, which this route reads and writes, and MUST
// be applied BEFORE this build is deployed; 0091 must be applied AFTER.)
//
// Statuses: 401 signed out, 400 bad JSON or bad answers, 403 not assigned,
// 404 no such quiz, 429 cooldown or a lost write race, 409 out of attempts
// (MAX_INTERACTIVE_ATTEMPTS), 500 no admin client or the write failed. The 409
// names the cap, because a student who has run out needs to know to ask a
// teacher rather than keep tapping.
//
// The student_id comes from the verified session and NEVER from the body, so
// "submit as someone else" is not expressible.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { generationId?: unknown; answers?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const generationId = String(body.generationId ?? "");

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Quizzes are unavailable right now." }, { status: 500 });
  }

  const result = await submitQuizWith(admin as unknown as QuizStore, user.id, generationId, body.answers);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    auto: result.auto,
    max: result.max,
    needsReview: result.needsReview,
    // How many tries are left, so a client can warn BEFORE the last one is
    // spent rather than only explaining the 409 afterwards.
    attempt: result.attempt,
    attemptsLeft: result.attemptsLeft,
  });
}
