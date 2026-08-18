import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { loadPaperWith, optionOrderKey, type QuizStore } from "../logic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/quiz/{generationId} — the STUDENT's copy of an in-app quiz.
//
// This route replaces the signed URL the student dashboard used to hand out.
// That URL pointed at questions.json in the artifacts bucket and was minted
// with the SERVICE ROLE, so it needed no credentials at all: a verifier fetched
// three of them from production and read back complete answer keys (fill_blank
// and true_false answers, the match pairs, the subjective answer_outline). The
// raw artifact URL must never reach a student session again — everything a
// student receives now goes through stripQuiz().
//
// The answer key still reaches the TEACHER by its own signed URL (grade-list),
// which is correct: they own the generation.
//
// Sits beside the static /api/quiz/submit segment. Next resolves static
// segments before dynamic ones, and this handler additionally requires a UUID,
// so "submit" could never be mistaken for a generation id in either direction.
export async function GET(_request: Request, { params }: { params: Promise<{ generationId: string }> }) {
  const { generationId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Quizzes are unavailable right now." }, { status: 500 });
  }

  // The server-only key behind the match option order. Read here rather than
  // inside logic.ts so that module keeps its no-ambient-state rule; null means
  // no secret is configured and loadPaperWith refuses the paper outright
  // (500), which is the ONLY degradation — there is no weaker seed to fall
  // back to, because the seed the student can compute is the vulnerability.
  const result = await loadPaperWith(
    admin as unknown as QuizStore,
    user.id,
    generationId,
    optionOrderKey(process.env),
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  // Never cached: the payload is per-student (keyed option order) and sits
  // behind a session check.
  return NextResponse.json(result.quiz, { headers: { "Cache-Control": "no-store" } });
}
