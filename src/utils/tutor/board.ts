// AI Tutor Phase 1 — server helpers for the persistent TAL board. The app is the
// HOST: it injects grounding, the model, and persistence into the platform-blind
// ERE engine (imported from @/ere). Board + events live in Supabase (migration
// 0029); identical grounded turns dedupe through tutor_tal_cache.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompleteFn, SceneGraphSnapshot } from "@/ere";
import { anthropic } from "./service";
import { TUTOR_MODELS, type TutorTier } from "./models";

// ── Phase 2: student events (shared board) ──────────────────────────────────
export type StudentEventInput = { type: string; target?: string; payload?: Record<string, unknown> };

// The student REFERS TO / marks up objects (deixis + annotation) — never mutates
// them (that stays with TAL). Only these types are accepted from the client.
const STUDENT_EVENT_TYPES = new Set([
  "student.select",
  "student.point",
  "student.circle",
  "student.annotate",
  "student.answer",
]);

function sanitizePayload(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p).slice(0, 10)) {
    if (typeof v === "string") out[k] = v.slice(0, 300);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "number")) out[k] = v.slice(0, 6);
  }
  return out;
}

/** Validate + sanitize the client's studentEvents[] — untrusted iframe input.
 * Caps count/size, drops unknown types, coerces target/payload. */
export function parseStudentEvents(raw: unknown): StudentEventInput[] {
  if (!Array.isArray(raw)) return [];
  const out: StudentEventInput[] = [];
  for (const e of raw.slice(0, 25)) {
    if (!e || typeof e !== "object") continue;
    const type = (e as { type?: unknown }).type;
    if (typeof type !== "string" || !STUDENT_EVENT_TYPES.has(type)) continue;
    const targetRaw = (e as { target?: unknown }).target;
    const target = typeof targetRaw === "string" ? targetRaw.slice(0, 120) : undefined;
    const payloadRaw = (e as { payload?: unknown }).payload;
    const payload =
      payloadRaw && typeof payloadRaw === "object" && !Array.isArray(payloadRaw)
        ? sanitizePayload(payloadRaw as Record<string, unknown>)
        : undefined;
    out.push({ type, target, payload });
  }
  return out;
}

/** Cache disambiguator for a referenced-target turn: the same question against
 * the same board but a DIFFERENT reference/focus is a different answer, so it
 * gets its own cache entry. Empty (no reference) → "" (shares the base entry). */
export function refHash(events: StudentEventInput[], focus?: string | null): string {
  if ((!events || events.length === 0) && !focus) return "";
  const canon = JSON.stringify({ f: focus ?? null, e: (events ?? []).map((e) => [e.type, e.target ?? ""]) });
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/** Append the student's events for this turn to the append-only log (service-role
 * only, actor='student'). Returns how many were written so the tutor turn's own
 * events can continue the sequence after them. */
export async function persistStudentEvents(
  admin: SupabaseClient,
  boardId: string,
  baseSeq: number,
  events: StudentEventInput[],
): Promise<number> {
  if (!events.length) return 0;
  const rows = events.map((e, i) => ({
    board_id: boardId,
    seq: baseSeq + i,
    ts: null,
    actor: "student",
    type: e.type,
    target: e.target ?? null,
    payload: (e.payload as object) ?? null,
    cause: null,
  }));
  await admin.from("tutor_board_event").insert(rows);
  return events.length;
}

// ── Phase 2: cross-origin CORS for the board app ────────────────────────────
/** The single allowlisted board-app origin (from env), or null if unset. */
export function boardAppOrigin(): string | null {
  const url = process.env.BOARD_APP_ORIGIN || process.env.NEXT_PUBLIC_BOARD_URL || "";
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

/** CORS headers for the board app — only ever echoes the exact allowlisted
 * origin (never a wildcard), and uses no credentials (the board sends a Bearer
 * token, not cookies). Empty object for any other origin. */
export function boardCors(reqOrigin: string | null): Record<string, string> {
  const allowed = boardAppOrigin();
  if (!allowed || reqOrigin !== allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

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
  refHashKey = "",
): Promise<{ tal: unknown; narration: string | null } | null> {
  const { data } = await admin
    .from("tutor_tal_cache")
    .select("tal, narration")
    .match({ book_id: bookId, chapter_num: chapterNum, question_norm: questionNorm, board_hash: boardHash, ref_hash: refHashKey })
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
  refHashKey = "",
): Promise<void> {
  await admin
    .from("tutor_tal_cache")
    .upsert(
      { book_id: bookId, chapter_num: chapterNum, question_norm: questionNorm, board_hash: boardHash, ref_hash: refHashKey, tal, narration },
      { onConflict: "book_id,chapter_num,question_norm,board_hash,ref_hash" },
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
