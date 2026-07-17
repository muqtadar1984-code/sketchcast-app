import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { aiTutorEnabled, aiTutorRequireProPlus, aiTutorTalEnabled, aiTutorCanvasEnabled } from "@/utils/flags";
import { normalizeQuestion } from "@/utils/tutor/models";
import { resolveTutorContext, loadGrounding, hasLessonGrounding, tutorEntitled } from "@/utils/tutor/service";
import { verifyBoardToken } from "@/utils/tutor/board-token";
import {
  BoardSession,
  StubNarrator,
  starterLibrary,
  generateTal,
  type TalProgram,
  type BoardEvent,
  type Grounding as EreGrounding,
} from "@/ere";
import {
  BOARD_SCENE,
  loadOrCreateBoard,
  saveBoard,
  talCacheGet,
  talCachePut,
  anthropicComplete,
  subjectFor,
  parseStudentEvents,
  persistStudentEvents,
  refHash,
  boardCors,
  type StudentEventInput,
} from "@/utils/tutor/board";

export const runtime = "nodejs";

// AI Tutor Phase 1/2 — one turn on the PERSISTENT, now SHARED teaching board. The
// tutor emits TAL (never pixels); the ERE engine validates + applies it and we
// return the authoritative snapshot for the client to render. Phase 2 adds:
//   * cross-origin auth — the standalone board app (board.sketchcast.app) can't
//     send the portal cookie, so it presents a scoped Bearer board-token instead
//     (dual-auth: cookie same-origin OR token cross-origin). CORS is echoed only
//     to the allowlisted board origin.
//   * student events — select/point/circle/annotate the student made are fed into
//     the read-back (so the tutor responds to the referenced object), persisted
//     (append-only, actor='student'), and fold into the TAL cache key.
// ANY failure returns { mode: "text" } so the client degrades to the chat.

const cors = (request: Request) => boardCors(request.headers.get("origin"));
const jsonCors = (request: Request, data: unknown, init?: { status?: number }) =>
  NextResponse.json(data as object, { status: init?.status ?? 200, headers: cors(request) });

/** Resolve the caller: the Supabase cookie session (same-origin portal), else a
 * scoped board token that must be bound to THIS generationId (cross-origin
 * iframe). Returns the user id, or null. */
async function resolveCaller(request: Request, generationId: string): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) return user.id;
  // Cross-origin: a Bearer board token, only when the canvas flag is on.
  if (!aiTutorCanvasEnabled()) return null;
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return null;
  const claims = verifyBoardToken(m[1]!.trim());
  if (!claims || claims.gen !== generationId) return null; // token must match the lesson
  return claims.sub;
}

// CORS preflight for the board app.
export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: cors(request) });
}

export async function POST(request: Request) {
  if (!aiTutorEnabled() || !aiTutorTalEnabled()) return jsonCors(request, { error: "Not available." }, { status: 404 });

  let body: { generationId?: string; question?: string; studentEvents?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonCors(request, { error: "Invalid JSON." }, { status: 400 });
  }
  const generationId = String(body.generationId ?? "");
  const question = String(body.question ?? "").trim().slice(0, 500);
  if (!generationId || !question) return jsonCors(request, { error: "Ask a question about your lesson." }, { status: 400 });

  const userId = await resolveCaller(request, generationId);
  if (!userId) return jsonCors(request, { error: "Not signed in." }, { status: 401 });

  const admin = createAdminClient();
  const ctx = await resolveTutorContext(admin, userId, generationId);
  if (!ctx) return jsonCors(request, { error: "This lesson isn't assigned to you." }, { status: 403 });
  if (aiTutorRequireProPlus() && !(await tutorEntitled(admin, generationId))) {
    return jsonCors(request, { error: "The AI Coach is a Pro+ feature.", upgrade: true }, { status: 403 });
  }

  // No grounding → the board can't be taught from this lesson yet: text fallback.
  const grounding = await loadGrounding(admin, ctx.bookId, ctx.chapterNum);
  // Index-time rows carry only source_text — the board needs LESSON grounding.
  if (!hasLessonGrounding(grounding)) return jsonCors(request, { mode: "text" });

  // Student deixis/annotation for this turn (untrusted iframe input → validated).
  const studentEvents: StudentEventInput[] = parseStudentEvents(body.studentEvents);
  const ref = refHash(studentEvents);

  try {
    const { data: bookRow } = await admin.from("books").select("subject").eq("id", ctx.bookId).maybeSingle();
    const board = await loadOrCreateBoard(admin, userId, generationId, ctx.bookId, ctx.chapterNum);
    board.scene_graph.scene = BOARD_SCENE; // normalise (fresh rows / legacy)

    const library = starterLibrary();
    // Student events occupy the seq range just BEFORE this turn's tutor events, so
    // the session's log continues after them (kept consistent in applyAndReturn).
    const nStud = studentEvents.length;
    const session = BoardSession.fromSnapshot(BOARD_SCENE, library, new StubNarrator(), board.scene_graph, board.event_seq + nStud);
    const qNorm = normalizeQuestion(question);

    // The student events as BoardEvents, for perception (read-back) + persistence.
    const studentBoardEvents = studentEvents.map((e, i) => ({
      id: `se_${board.event_seq + i}`,
      seq: board.event_seq + i,
      ts: 0,
      scene: BOARD_SCENE,
      actor: "student",
      type: e.type,
      target: e.target,
      payload: e.payload,
    })) as unknown as BoardEvent[];

    // Apply a validated program to the board, persist (student + tutor events), and
    // return it. Shared by the cache-hit and freshly-generated paths.
    const applyAndReturn = async (program: TalProgram, narration: string | null, cacheOnMiss: boolean) => {
      program.scene = BOARD_SCENE; // a cached program from another board carries its scene
      const result = await session.runTurn(program);
      if (!result.ok) return null; // (e.g. a rare hash collision) → caller regenerates / falls back
      const narrationText = narration ?? deriveNarration(program);
      const events = [...session.log.all()];
      // Persist the student events for this turn (append-only), then the board.
      await persistStudentEvents(admin, board.id, board.event_seq, studentEvents);
      await saveBoard(admin, board.id, session.graph.toJSON(), session.graph.stateHash(), board.turn + 1, session.log.seq, events);
      if (cacheOnMiss) {
        // Key on the board state BEFORE this turn + the reference the student made.
        await talCachePut(admin, ctx.bookId, ctx.chapterNum, qNorm, board.board_hash, program, narrationText, ref);
      }
      // Authoritative new snapshot + this turn's events → client is a pure renderer.
      return jsonCors(request, {
        mode: "board",
        snapshot: session.graph.toJSON(),
        events,
        studentEvents: studentBoardEvents,
        narrationText,
        boardId: board.id,
      });
    };

    // 1) Cache-first — same question + same board state + same reference replays $0.
    const cached = await talCacheGet(admin, ctx.bookId, ctx.chapterNum, qNorm, board.board_hash, ref);
    if (cached?.tal) {
      const res = await applyAndReturn(cached.tal as TalProgram, cached.narration, false);
      if (res) return res; // else fall through to a fresh generation
    }

    // 2) Miss → the gateway makes the model emit valid TAL (grounded, catalog-
    //    constrained, board-aware + student-reference-aware), validates, repairs once.
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
      readBack: session.graph.readBack(board.turn + 1, studentBoardEvents),
    });
    if (!gen.ok) return jsonCors(request, { mode: "text" }); // invalid after repair → grounded-text fallback

    const res = await applyAndReturn(gen.program as TalProgram, null, true);
    return res ?? jsonCors(request, { mode: "text" });
  } catch (e) {
    console.error("tutor.turn", (e as Error).message);
    return jsonCors(request, { mode: "text" }); // never break the tutor
  }
}

// Rehydrate an existing board when the panel/iframe opens. Dual-auth + CORS like
// POST, since the standalone board app calls this cross-origin on load.
export async function GET(request: Request) {
  if (!aiTutorEnabled() || !aiTutorTalEnabled()) return jsonCors(request, { error: "Not available." }, { status: 404 });

  const generationId = new URL(request.url).searchParams.get("generationId") ?? "";
  if (!generationId) return jsonCors(request, { error: "Missing lesson." }, { status: 400 });

  const userId = await resolveCaller(request, generationId);
  if (!userId) return jsonCors(request, { error: "Not signed in." }, { status: 401 });

  const admin = createAdminClient();
  const ctx = await resolveTutorContext(admin, userId, generationId);
  if (!ctx) return jsonCors(request, { error: "This lesson isn't assigned to you." }, { status: 403 });

  const { data: board } = await admin
    .from("tutor_board")
    .select("scene_graph")
    .eq("student_id", userId)
    .eq("generation_id", generationId)
    .maybeSingle();
  return jsonCors(request, { snapshot: (board?.scene_graph as unknown) ?? null });
}

function deriveNarration(program: TalProgram): string {
  return (program.actions ?? [])
    .filter((a): a is { op: "speak"; id: string; text: string } => a.op === "speak")
    .map((a) => a.text)
    .join(" ");
}
