import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { aiAssistantEnabled } from "@/utils/flags";
import { normalizeQuestion } from "@/utils/tutor/models";
import { loadGrounding, buildStudentModel, findCached, bumpCache, saveCache } from "@/utils/tutor/service";
import { assistantProvider } from "@/utils/assistant/provider";
import { inScopeBooks, scopeTopics, decideScope, type Topic } from "@/utils/assistant/scope";
import { buildAssistantPrompt, declineMessage, NO_BOOK_MESSAGE } from "@/utils/assistant/prompt";
import { MATH_TOOLS, mathToolsAvailable, runMathTool } from "@/utils/assistant/math-tool";
import { runAssistantTurn } from "@/utils/assistant/orchestrator";
import { openSession, logTurn } from "@/utils/assistant/store";

export const runtime = "nodejs";

// The AI Teaching Assistant — the active student-tutor path (replaces Ask Coach;
// the TAL board is preserved behind its own flag). Flow per turn:
//   retrieve (in-scope books → topic scoring) → scope-decide (Option B) →
//   in-scope: book-first answer via the provider adapter (+ constrained math
//   tools), streamed as SSE with a "from your [chapter]" source tag;
//   off-topic: deterministic warm decline-and-redirect (no model call);
//   no-book: friendly empty state. Latency + cost logged per turn.

const enc = new TextEncoder();
const sse = (controller: ReadableStreamDefaultController, event: string, data: string) => {
  controller.enqueue(enc.encode(`event: ${event}\ndata: ${data.replace(/\n/g, "\ndata: ")}\n\n`));
};

// GET — warm-start/pre-init: called when the panel MOUNTS (before the student
// types), so the first turn doesn't pay session setup. Returns the greeting,
// the in-scope books, and the session id.
export async function GET() {
  if (!aiAssistantEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const admin = createAdminClient();
  const [{ data: profile }, books] = await Promise.all([
    admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
    inScopeBooks(admin, user.id),
  ]);
  const session = await openSession(admin, user.id);
  const first = (profile?.full_name as string | null)?.split(" ")[0];

  const greeting = books.length
    ? `Hi${first ? ` ${first}` : ""}! I'm your AI Teaching Assistant. Ask me anything from ${
        books.length === 1 ? `"${books[0]!.title}"` : `your ${books.length} books`
      } — I can explain, practise with you, and check maths step by step.`
    : NO_BOOK_MESSAGE;

  return NextResponse.json({
    ready: books.length > 0,
    greeting,
    sessionId: session.id,
    books: books.map((b) => ({ id: b.id, title: b.title, subject: b.subject })),
  });
}

// POST — one streamed turn.
export async function POST(request: Request) {
  if (!aiAssistantEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });
  const t0 = Date.now();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { question?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const question = String(body.question ?? "").trim().slice(0, 600);
  if (!question) return NextResponse.json({ error: "Ask a question." }, { status: 400 });

  const admin = createAdminClient();
  const [books, session, { data: profile }] = await Promise.all([
    inScopeBooks(admin, user.id),
    openSession(admin, user.id),
    admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
  ]);
  const topics = await scopeTopics(admin, books);
  const retrievalMs = Date.now() - t0;

  const activeTopic: Topic | null = session.activeTopic
    ? {
        bookId: session.activeTopic.bookId,
        chapterNum: session.activeTopic.chapterNum,
        title: session.activeTopic.title,
        bookTitle: books.find((b) => b.id === session.activeTopic!.bookId)?.title ?? "",
      }
    : null;
  const decision = decideScope(question, topics, { activeTopic });

  const stream = new ReadableStream({
    async start(controller) {
      const finish = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      try {
        // ── No book / off-topic: deterministic, instant, free ────────────────
        if (decision.kind === "no_book" || decision.kind === "off_topic") {
          const text =
            decision.kind === "no_book"
              ? NO_BOOK_MESSAGE
              : declineMessage(decision.suggestTopics, books[0]?.subject ?? null);
          sse(controller, "meta", JSON.stringify({ state: decision.kind, sessionId: session.id }));
          sse(controller, "text", text);
          sse(controller, "done", JSON.stringify({ latency: { retrievalMs, totalMs: Date.now() - t0 } }));
          await logTurn(admin, session.id, user.id, {
            question,
            answer: text,
            source: null,
            provider: "none",
            latency: { retrievalMs, totalMs: Date.now() - t0 },
            tokens: null,
          });
          finish();
          return;
        }

        // ── In scope: book-first ─────────────────────────────────────────────
        const { best } = decision;
        const sourceLabel = `Chapter ${best.chapterNum} — ${best.title}`;
        sse(controller, "meta", JSON.stringify({
          state: "in_scope",
          sessionId: session.id,
          source: { book: best.bookTitle, label: sourceLabel },
        }));

        // Answer cache: an identical question on this chapter replays for $0.
        // Conservative serve rule (same as the tutor): near-exact always; a fuzzy
        // match only once it's been verified by confirmed reuse.
        const qNorm = normalizeQuestion(question);
        const cached = await findCached(admin, best.bookId, best.chapterNum, qNorm);
        if (cached && (cached.nearExact || cached.row.is_verified)) {
          sse(controller, "text", cached.row.answer_text);
          sse(controller, "done", JSON.stringify({ latency: { retrievalMs, totalMs: Date.now() - t0, cached: 1 } }));
          void bumpCache(admin, cached.row.id);
          await logTurn(admin, session.id, user.id, {
            question,
            answer: cached.row.answer_text,
            source: { bookId: best.bookId, chapterNum: best.chapterNum, label: sourceLabel },
            provider: "cache",
            latency: { retrievalMs, totalMs: Date.now() - t0 },
            tokens: null,
          });
          finish();
          return;
        }

        // Grounding excerpt (generated-lesson chapters have rich grounding; other
        // chapters fall back to topic-level guidance — still book-bounded).
        const grounding = await loadGrounding(admin, best.bookId, best.chapterNum);
        const excerpt = grounding
          ? [grounding.concepts ? JSON.stringify(grounding.concepts).slice(0, 5000) : "", grounding.scriptText ?? ""]
              .filter(Boolean)
              .join("\n")
          : `(No lesson text available for this chapter yet — teach the topic "${best.title}" at the student's level, within the curriculum.)`;

        const student = await buildStudentModel(admin, user.id, best.bookId, best.chapterNum, best.title).catch(() => null);
        const mastery =
          student?.attempted
            ? `Latest quiz score: ${student.scorePct ?? "?"}%.` +
              (student.weakQuestions.length ? ` Struggled with: ${student.weakQuestions.join("; ").slice(0, 400)}` : "")
            : null;

        const { data: bookGrade } = await admin.from("books").select("grade").eq("id", best.bookId).maybeSingle();
        const system = buildAssistantPrompt({
          studentName: (profile?.full_name as string | null)?.split(" ")[0] ?? null,
          gradeLabel: (bookGrade?.grade as string | null) ?? null,
          grounding: { bookTitle: best.bookTitle, chapterTitle: best.title, excerpt },
          topicList: topics.map((t) => t.title),
          masterySummary: mastery,
          historySummary: session.historySummary,
          mathToolsAvailable: mathToolsAvailable(),
        });

        const provider = await assistantProvider();
        let firstTokenMs = 0;
        let toolMs = 0;
        let full = "";
        let usage: { inputTokens: number; outputTokens: number } | null = null;

        for await (const ev of runAssistantTurn({
          provider,
          system,
          history: session.recentTurns,
          question,
          tools: mathToolsAvailable() ? MATH_TOOLS : undefined,
          runTool: async (call) => {
            const tt = Date.now();
            const out = await runMathTool(call);
            toolMs += Date.now() - tt;
            return out;
          },
        })) {
          if (ev.type === "text") {
            if (!firstTokenMs) firstTokenMs = Date.now() - t0;
            full += ev.text;
            sse(controller, "text", ev.text);
          } else if (ev.type === "tool") {
            sse(controller, "tool", ev.name);
          } else if (ev.type === "done") {
            usage = ev.usage;
          } else {
            // Friendly, retryable-aware error — never a raw failure to a child.
            sse(controller, "error", ev.retryable ? "One moment — I'm thinking hard. Try that again in a few seconds!" : "I couldn't answer that one. Try asking a different way?");
          }
        }

        const latency = { retrievalMs, firstTokenMs, toolMs, totalMs: Date.now() - t0 };
        sse(controller, "done", JSON.stringify({ latency }));

        if (full) {
          // Bank the answer for classmates (same chapter, same question → $0).
          void saveCache(admin, best.bookId, best.chapterNum, question, qNorm, full).catch(() => {});
          await logTurn(admin, session.id, user.id, {
            question,
            answer: full,
            source: { bookId: best.bookId, chapterNum: best.chapterNum, label: sourceLabel },
            provider: provider.id,
            latency,
            tokens: usage,
          });
        }
        finish();
      } catch (e) {
        console.error("assistant.turn", (e as Error).message);
        sse(controller, "error", "Something went wrong — try again in a moment.");
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
