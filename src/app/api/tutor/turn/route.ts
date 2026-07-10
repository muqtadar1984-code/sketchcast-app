import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { aiTutorEnabled, aiTutorRequireProPlus, aiTutorTalEnabled } from "@/utils/flags";
import { normalizeQuestion } from "@/utils/tutor/models";
import { resolveTutorContext, loadGrounding, tutorEntitled } from "@/utils/tutor/service";
import { BoardSession, StubNarrator, starterLibrary, generateTal, type TalProgram, type Grounding as EreGrounding } from "@/ere";
import {
  BOARD_SCENE,
  loadOrCreateBoard,
  saveBoard,
  talCacheGet,
  talCachePut,
  anthropicComplete,
  subjectFor,
} from "@/utils/tutor/board";

export const runtime = "nodejs";

// AI Tutor Phase 1 — one turn on the PERSISTENT teaching board. The tutor emits
// TAL (never pixels), the ERE engine validates + applies it to the student's
// board (which persists across turns), and we return the TAL for the client to
// render + narrate. Cache-first per (chapter, question, board state). ANY failure
// returns { mode: "text" } so the client falls back to the existing chat — the
// board is an enhancement, never a hard dependency.
export async function POST(request: Request) {
  if (!aiTutorEnabled() || !aiTutorTalEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { generationId?: string; question?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const generationId = String(body.generationId ?? "");
  const question = String(body.question ?? "").trim().slice(0, 500);
  if (!generationId || !question) return NextResponse.json({ error: "Ask a question about your lesson." }, { status: 400 });

  const admin = createAdminClient();
  const ctx = await resolveTutorContext(admin, user.id, generationId);
  if (!ctx) return NextResponse.json({ error: "This lesson isn't assigned to you." }, { status: 403 });
  if (aiTutorRequireProPlus() && !(await tutorEntitled(admin, generationId))) {
    return NextResponse.json({ error: "The AI Coach is a Pro+ feature.", upgrade: true }, { status: 403 });
  }

  // No grounding → the board can't be taught from this lesson yet: text fallback.
  const grounding = await loadGrounding(admin, ctx.bookId, ctx.chapterNum);
  if (!grounding) return NextResponse.json({ mode: "text" });

  try {
    const { data: bookRow } = await admin.from("books").select("subject").eq("id", ctx.bookId).maybeSingle();
    const board = await loadOrCreateBoard(admin, user.id, generationId, ctx.bookId, ctx.chapterNum);
    board.scene_graph.scene = BOARD_SCENE; // normalise (fresh rows / legacy)

    const library = starterLibrary();
    const session = BoardSession.fromSnapshot(BOARD_SCENE, library, new StubNarrator(), board.scene_graph, board.event_seq);
    const qNorm = normalizeQuestion(question);

    // Apply a validated program to the board, persist, and return it. Shared
    // helper for both the cache-hit and freshly-generated paths.
    const applyAndReturn = async (program: TalProgram, narration: string | null, cacheOnMiss: boolean) => {
      program.scene = BOARD_SCENE; // a cached program from another board carries its scene
      const result = await session.runTurn(program);
      if (!result.ok) return null; // (e.g. a rare hash collision) → caller regenerates / falls back
      const narrationText = narration ?? deriveNarration(program);
      const events = [...session.log.all()];
      await saveBoard(admin, board.id, session.graph.toJSON(), session.graph.stateHash(), board.turn + 1, session.log.seq, events);
      if (cacheOnMiss) {
        // Key on the board state BEFORE this turn (board.board_hash).
        await talCachePut(admin, ctx.bookId, ctx.chapterNum, qNorm, board.board_hash, program, narrationText);
      }
      // Return the AUTHORITATIVE new board snapshot + this turn's events so the
      // client is a pure renderer (no client-side re-apply → no divergence).
      return NextResponse.json({
        mode: "board",
        snapshot: session.graph.toJSON(),
        events,
        narrationText,
        boardId: board.id,
      });
    };

    // 1) Cache-first — same question against the same board state replays for $0.
    const cached = await talCacheGet(admin, ctx.bookId, ctx.chapterNum, qNorm, board.board_hash);
    if (cached?.tal) {
      const res = await applyAndReturn(cached.tal as TalProgram, cached.narration, false);
      if (res) return res; // else fall through to a fresh generation
    }

    // 2) Miss → the gateway makes the model emit valid TAL (grounded, catalog-
    //    constrained, board-aware), validates, and repairs once.
    const ereGrounding: EreGrounding = {
      chapterTitle: grounding.chapterTitle,
      conceptText: grounding.concepts ? JSON.stringify(grounding.concepts).slice(0, 6000) : undefined,
      scriptText: grounding.scriptText ?? undefined,
    };
    const tier = board.turn === 0 ? "cheap" : "strong"; // first draw is simple; follow-ups reason over the board
    const gen = await generateTal({
      complete: anthropicComplete(tier),
      library,
      scene: session.graph,
      turn: board.turn + 1,
      grounding: ereGrounding,
      studentMessage: question,
      subjects: subjectFor(bookRow?.subject as string | null),
      readBack: session.graph.readBack(board.turn + 1),
    });
    if (!gen.ok) return NextResponse.json({ mode: "text" }); // invalid after repair → grounded-text fallback

    const res = await applyAndReturn(gen.program as TalProgram, null, true);
    return res ?? NextResponse.json({ mode: "text" });
  } catch (e) {
    console.error("tutor.turn", (e as Error).message);
    return NextResponse.json({ mode: "text" }); // never break the tutor
  }
}

// Rehydrate an existing board when the panel opens (returns the current scene
// snapshot for the client to render statically). No board yet → { snapshot: null }.
export async function GET(request: Request) {
  if (!aiTutorEnabled() || !aiTutorTalEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const generationId = new URL(request.url).searchParams.get("generationId") ?? "";
  if (!generationId) return NextResponse.json({ error: "Missing lesson." }, { status: 400 });

  const admin = createAdminClient();
  const ctx = await resolveTutorContext(admin, user.id, generationId);
  if (!ctx) return NextResponse.json({ error: "This lesson isn't assigned to you." }, { status: 403 });

  const { data: board } = await admin
    .from("tutor_board")
    .select("scene_graph")
    .eq("student_id", user.id)
    .eq("generation_id", generationId)
    .maybeSingle();
  return NextResponse.json({ snapshot: (board?.scene_graph as unknown) ?? null });
}

function deriveNarration(program: TalProgram): string {
  return (program.actions ?? [])
    .filter((a): a is { op: "speak"; id: string; text: string } => a.op === "speak")
    .map((a) => a.text)
    .join(" ");
}
