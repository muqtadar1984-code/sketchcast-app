import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { aiTutorEnabled } from "@/utils/flags";
import { normalizeQuestion, pickTier, shouldServeCached } from "@/utils/tutor/models";
import {
  resolveTutorContext,
  loadGrounding,
  findCached,
  bumpCache,
  saveCache,
  logMessage,
  streamAnswer,
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

  let body: { question?: string; generationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const question = String(body.question ?? "").trim();
  const generationId = String(body.generationId ?? "");
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
  const grounding = await loadGrounding(admin, ctx.bookId, ctx.chapterNum);
  if (!grounding) return NextResponse.json({ error: "The tutor isn't ready for this lesson yet." }, { status: 409 });

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

        // Cache-first — a near-exact or verified match replays at $0.
        const cached = await findCached(admin, ctx.bookId, ctx.chapterNum, qNorm);
        if (cached && shouldServeCached(cached.row, cached.nearExact)) {
          send("text", cached.row.answer_text);
          send("done", "cache");
          controller.close();
          await bumpCache(admin, cached.row.id);
          await logMessage(admin, { ...base, role: "coach", content: cached.row.answer_text, tutorMove: "answer" });
          return;
        }

        // Miss → grounded, tiered generation.
        let full = "";
        for await (const chunk of streamAnswer(question, grounding, pickTier(question))) {
          full += chunk;
          send("text", chunk);
        }
        send("done", "generated");
        controller.close();

        const answer = full.trim();
        if (answer) {
          await saveCache(admin, ctx.bookId, ctx.chapterNum, question, qNorm, answer);
          await logMessage(admin, { ...base, role: "coach", content: answer, tutorMove: "answer" });
        }
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
