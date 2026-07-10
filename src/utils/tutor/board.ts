// AI Tutor Phase 1 — server helpers for the persistent TAL board. The app is the
// HOST: it injects grounding, the model, and persistence into the platform-blind
// ERE engine (imported from @/ere). Board + events live in Supabase (migration
// 0029); identical grounded turns dedupe through tutor_tal_cache.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompleteFn, SceneGraphSnapshot } from "@/ere";
import { anthropic } from "./service";
import { TUTOR_MODELS, type TutorTier } from "./models";

// One fixed ERE scene id for every board — the board's real identity is its DB
// row, so a constant here keeps TAL programs cache-shareable across students
// (the scene string is only a within-session consistency check).
export const BOARD_SCENE = "board";

export type BoardRow = {
  id: string;
  scene_graph: SceneGraphSnapshot;
  board_hash: string;
  turn: number;
  event_seq: number;
};

/** Load the student's board for this lesson, creating an empty one on first use. */
export async function loadOrCreateBoard(
  admin: SupabaseClient,
  studentId: string,
  generationId: string,
  bookId: string,
  chapterNum: number,
): Promise<BoardRow> {
  const { data } = await admin
    .from("tutor_board")
    .select("id, scene_graph, board_hash, turn, event_seq")
    .eq("student_id", studentId)
    .eq("generation_id", generationId)
    .maybeSingle();
  if (data) return data as BoardRow;

  const empty: SceneGraphSnapshot = { scene: BOARD_SCENE, nodes: [] };
  const { data: created } = await admin
    .from("tutor_board")
    .insert({
      student_id: studentId,
      generation_id: generationId,
      book_id: bookId,
      chapter_num: chapterNum,
      scene_graph: empty,
      board_hash: "",
      turn: 0,
      event_seq: 0,
    })
    .select("id, scene_graph, board_hash, turn, event_seq")
    .single();
  return (created as BoardRow) ?? { id: "", scene_graph: empty, board_hash: "", turn: 0, event_seq: 0 };
}

/** Persist the mutated board + append this turn's events. */
export async function saveBoard(
  admin: SupabaseClient,
  boardId: string,
  snapshot: SceneGraphSnapshot,
  boardHash: string,
  turn: number,
  eventSeq: number,
  events: { seq: number; ts?: number; actor: string; type: string; target?: string; payload?: unknown; cause?: string }[],
): Promise<void> {
  await admin
    .from("tutor_board")
    .update({ scene_graph: snapshot, board_hash: boardHash, turn, event_seq: eventSeq, updated_at: new Date().toISOString() })
    .eq("id", boardId);
  if (events.length) {
    await admin.from("tutor_board_event").insert(
      events.map((e) => ({
        board_id: boardId,
        seq: e.seq,
        ts: e.ts ?? null,
        actor: e.actor,
        type: e.type,
        target: e.target ?? null,
        payload: (e.payload as object) ?? null,
        cause: e.cause ?? null,
      })),
    );
  }
}

/** Shared cache: the same question against the same board state replays for $0.
 * Keyed on the board state BEFORE the turn. */
export async function talCacheGet(
  admin: SupabaseClient,
  bookId: string,
  chapterNum: number,
  questionNorm: string,
  boardHash: string,
): Promise<{ tal: unknown; narration: string | null } | null> {
  const { data } = await admin
    .from("tutor_tal_cache")
    .select("tal, narration")
    .match({ book_id: bookId, chapter_num: chapterNum, question_norm: questionNorm, board_hash: boardHash })
    .maybeSingle();
  return data ? { tal: data.tal, narration: (data.narration as string | null) ?? null } : null;
}

export async function talCachePut(
  admin: SupabaseClient,
  bookId: string,
  chapterNum: number,
  questionNorm: string,
  boardHash: string,
  tal: unknown,
  narration: string,
): Promise<void> {
  await admin
    .from("tutor_tal_cache")
    .upsert(
      { book_id: bookId, chapter_num: chapterNum, question_norm: questionNorm, board_hash: boardHash, tal, narration },
      { onConflict: "book_id,chapter_num,question_norm,board_hash" },
    );
}

/** A model-agnostic completion for the ERE gateway — wraps the app's Anthropic
 * client (non-streaming, tiered, grammar prompt-cached). */
export function anthropicComplete(tier: TutorTier): CompleteFn {
  return async ({ system, user }) => {
    const resp = await anthropic().messages.create({
      model: TUTOR_MODELS[tier],
      max_tokens: 1500,
      // The grammar/rules in `system` are stable across a chapter's turns → cache.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    const block = resp.content.find((b) => b.type === "text");
    return block && "text" in block ? block.text : "";
  };
}

/** Map a book's free-text subject to the ERE catalog subjects, so the tutor is
 * offered the right knowledge objects. Unknown → undefined (full catalog; the
 * model composes from primitives). */
export function subjectFor(bookSubject: string | null | undefined): string[] | undefined {
  const s = (bookSubject ?? "").toLowerCase();
  if (/biolog|life science|anatomy/.test(s)) return ["biology"];
  if (/phys/.test(s)) return ["physics"];
  if (/comput|algorith|programming|\bcs\b|coding/.test(s)) return ["algorithms", "computer science"];
  return undefined;
}
