import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { aiTutorEnabled, aiTutorRequireProPlus } from "@/utils/flags";
import { normalizeQuestion, pickTier, shouldServeCached, buildGreeting, buildStudentContext, classifyMove, toClaudeHistory } from "@/utils/tutor/models";
import {
  resolveTutorContext,
  loadGrounding,
  hasLessonGrounding,
  findCached,
  bumpCache,
  saveCache,
  logMessage,
  streamAnswer,
  buildStudentModel,
  recordMastery,
  tutorEntitled,
} from "@/utils/tutor/service";

export const runtime = "nodejs";

// AI Tutor ("Ask Coach") — a real-time, chapter-LOCKED tutor. A student asks a
// question about a lesson ASSIGNED to them; the answer is grounded strictly on
// that chapter (curriculum + child-safety fence), served from a shared cache when
// possible ($0), else streamed from Claude and banked. Transcript is logged
// (kept for the account's lifetime; deleted with the account — see migration 0025).
//
// M1 = grounded + safe + cached + tiered. Personalisation (M2), Socratic mastery
// (M3), voice (M4), the UI (M5) and Pro+ entitlement gating (M7) come next.

export async function POST(request: Request) {
  // Flag-gated (ON in the trial, later swapped for the Pro+ entitlement gate).
  if (!aiTutorEnabled()) {
    return NextResponse.json({ error: "Not available." }, { status: 404 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { question?: string; generationId?: string; history?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const question = String(body.question ?? "").trim();
  const generationId = String(body.generationId ?? "");
  const history = toClaudeHistory(body.history);
  const contextual = history.length > 0; // a follow-up that depends on the thread
  if (!question || !generationId) {
    return NextResponse.json({ error: "Ask a question about your lesson." }, { status: 400 });
  }
  if (question.length > 500) {
    return NextResponse.json({ error: "That question is a bit long — try a shorter one." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Access + chapter (assigned-to-this-student only) and the grounding fence.
  const ctx = await resolveTutorContext(admin, user.id, generationId);
  if (!ctx) return NextResponse.json({ error: "This lesson isn't assigned to you." }, { status: 403 });
  // Pro+ gate (enforced post-trial; open during the free trial).
  if (aiTutorRequireProPlus() && !(await tutorEntitled(admin, generationId))) {
    return NextResponse.json({ error: "The AI Coach is a Pro+ feature.", upgrade: true }, { status: 403 });
  }
  const grounding = await loadGrounding(admin, ctx.bookId, ctx.chapterNum);
  // Index-time rows carry only source_text — the tutor needs LESSON grounding.
  if (!hasLessonGrounding(grounding))
    return NextResponse.json({ error: "The tutor isn't ready for this lesson yet." }, { status: 409 });

  const qNorm = normalizeQuestion(question);
  const encoder = new TextEncoder();
  const base = { studentId: user.id, generationId, bookId: ctx.bookId, chapterNum: ctx.chapterNum } as const;

  const stream = new ReadableStream({
    async start(controller) {
      // SSE: one logical value per event; strip newlines so `data:` stays single-line.
      const send = (event: string, data: string) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data.replace(/\r?\n/g, " ")}\n\n`));

      try {
        await logMessage(admin, { ...base, role: "student", content: question });

        // Cache-first — but ONLY for a standalone question. A contextual follow-up
        // ("can you show me how") depends on the thread, so the shared cache (keyed
        // on the bare question) would serve the wrong answer — always generate fresh.
        if (!contextual) {
          const cached = await findCached(admin, ctx.bookId, ctx.chapterNum, qNorm);
          if (cached && shouldServeCached(cached.row, cached.nearExact)) {
            send("text", cached.row.answer_text);
            // Log the coach turn BEFORE closing so we can hand the client its id —
            // the voice route will only speak a real, logged coach message.
            const cid = await logMessage(admin, { ...base, role: "coach", content: cached.row.answer_text, tutorMove: classifyMove(cached.row.answer_text) });
            if (cid) send("mid", cid);
            send("done", "cache");
            controller.close();
            await bumpCache(admin, cached.row.id);
            await recordMastery(admin, { ...base, source: "tutor", signal: "engaged", weight: 0, detail: question });
            return;
          }
        }

        // Miss (or a contextual turn) → grounded, tiered generation with the thread
        // in context. Follow-ups lean on the strong model for the extra reasoning.
        const sm = await buildStudentModel(admin, user.id, ctx.bookId, ctx.chapterNum, grounding.chapterTitle);
        const tier = contextual ? "strong" : pickTier(question);
        let full = "";
        for await (const chunk of streamAnswer(question, grounding, tier, buildStudentContext(sm), history)) {
          full += chunk;
          send("text", chunk);
        }

        // Persist + hand the client the coach message id (for voice) before done.
        const answer = full.trim();
        let cid: string | null = null;
        if (answer) {
          // Only bank a STANDALONE answer in the shared cache — a contextual reply
          // is thread-specific and would mislead other students.
          if (!contextual) await saveCache(admin, ctx.bookId, ctx.chapterNum, question, qNorm, answer);
          cid = await logMessage(admin, { ...base, role: "coach", content: answer, tutorMove: classifyMove(answer) });
        }
        if (cid) send("mid", cid);
        send("done", "generated");
        controller.close();

        if (answer) await recordMastery(admin, { ...base, source: "tutor", signal: "engaged", weight: 0, detail: question });
      } catch (e) {
        send("error", "Coach had trouble answering — please try again.");
        controller.close();
        console.error("tutor.error", (e as Error).message);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

// Panel-open: is the tutor ready for this lesson, and the personalised greeting
// (names the child's real weak spot when there's quiz evidence; a warm
// diagnostic opener when there isn't).
export async function GET(request: Request) {
  if (!aiTutorEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const generationId = new URL(request.url).searchParams.get("generationId") ?? "";
  if (!generationId) return NextResponse.json({ error: "Missing generationId." }, { status: 400 });

  const admin = createAdminClient();
  const ctx = await resolveTutorContext(admin, user.id, generationId);
  if (!ctx) return NextResponse.json({ error: "This lesson isn't assigned to you." }, { status: 403 });
  if (aiTutorRequireProPlus() && !(await tutorEntitled(admin, generationId))) {
    return NextResponse.json({ ready: false, greeting: "", upgrade: true });
  }

  const grounding = await loadGrounding(admin, ctx.bookId, ctx.chapterNum);
  if (!hasLessonGrounding(grounding)) return NextResponse.json({ ready: false, greeting: "" });

  const sm = await buildStudentModel(admin, user.id, ctx.bookId, ctx.chapterNum, grounding.chapterTitle);
  return NextResponse.json({ ready: true, greeting: buildGreeting(sm) });
}
