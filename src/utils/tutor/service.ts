// AI Tutor service layer — the I/O the pure core (models.ts) can't do: Anthropic
// calls, grounding + access reads, and the shared answer cache. Server-only.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TUTOR_MODELS,
  CACHE_NEAR_EXACT,
  CACHE_FUZZY,
  CACHE_VERIFY_AT,
  buildSystemPrompt,
  type Grounding,
  type TutorTier,
  type CacheRow,
} from "./models";

export function anthropic(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  return new Anthropic({ apiKey: key });
}

export type TutorContext = { bookId: string; chapterNum: number };

/** Access + chapter resolution. A student may be tutored on a generation only if
 * it was ASSIGNED to them (a student_progress row exists) — the same signal the
 * app uses to give students their lessons. Returns null (→ 403) otherwise. */
export async function resolveTutorContext(
  admin: SupabaseClient,
  studentId: string,
  generationId: string,
): Promise<TutorContext | null> {
  const { data: prog } = await admin
    .from("student_progress")
    .select("id")
    .eq("generation_id", generationId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (!prog) return null;

  const { data: gen } = await admin
    .from("generations")
    .select("book_id, chapter_ref")
    .eq("id", generationId)
    .maybeSingle();
  if (!gen?.book_id) return null;

  const chapterNum = parseInt(String(gen.chapter_ref ?? ""), 10);
  if (Number.isNaN(chapterNum)) return null;
  return { bookId: gen.book_id as string, chapterNum };
}

/** The tutor's curriculum fence — persisted by the worker at generation time.
 * Null means this chapter has no lesson yet (→ 409, "not ready"). */
export async function loadGrounding(
  admin: SupabaseClient,
  bookId: string,
  chapterNum: number,
): Promise<Grounding | null> {
  const { data } = await admin
    .from("chapter_grounding")
    .select("chapter_title, concepts, script_text")
    .eq("book_id", bookId)
    .eq("chapter_num", chapterNum)
    .maybeSingle();
  if (!data) return null;
  return {
    chapterTitle: (data.chapter_title as string) ?? "this chapter",
    concepts: data.concepts ?? null,
    scriptText: (data.script_text as string | null) ?? null,
  };
}

/** Cache lookup: near-exact first (safe to replay), then a verified fuzzy match. */
export async function findCached(
  admin: SupabaseClient,
  bookId: string,
  chapterNum: number,
  qNorm: string,
): Promise<{ row: CacheRow; nearExact: boolean } | null> {
  const near = await admin.rpc("tutor_qa_match", { p_book_id: bookId, p_chapter_num: chapterNum, p_q_norm: qNorm, p_threshold: CACHE_NEAR_EXACT });
  const nearRow = (near.data as CacheRow[] | null)?.[0];
  if (nearRow) return { row: nearRow, nearExact: true };

  const fuzzy = await admin.rpc("tutor_qa_match", { p_book_id: bookId, p_chapter_num: chapterNum, p_q_norm: qNorm, p_threshold: CACHE_FUZZY });
  const fuzzyRow = (fuzzy.data as CacheRow[] | null)?.[0];
  if (fuzzyRow) return { row: fuzzyRow, nearExact: false };
  return null;
}

export async function bumpCache(admin: SupabaseClient, id: string): Promise<void> {
  await admin.rpc("tutor_qa_bump", { p_id: id, p_verify_at: CACHE_VERIFY_AT });
}

export async function saveCache(
  admin: SupabaseClient,
  bookId: string,
  chapterNum: number,
  question: string,
  qNorm: string,
  answer: string,
): Promise<void> {
  await admin.from("tutor_qa").insert({
    book_id: bookId,
    chapter_num: chapterNum,
    question_text: question,
    question_norm: qNorm,
    answer_text: answer,
  });
}

export async function logMessage(
  admin: SupabaseClient,
  m: { studentId: string; generationId: string; bookId: string; chapterNum: number; role: "student" | "coach"; content: string; tutorMove?: string },
): Promise<void> {
  await admin.from("tutor_messages").insert({
    student_id: m.studentId,
    generation_id: m.generationId,
    book_id: m.bookId,
    chapter_num: m.chapterNum,
    role: m.role,
    content: m.content,
    tutor_move: m.tutorMove ?? null,
  });
}

/** Stream a grounded, safe answer from Claude. The chapter CONTEXT is a cached
 * prompt prefix (identical across a chapter's questions → paid once). Yields
 * text chunks as they arrive. */
export async function* streamAnswer(question: string, grounding: Grounding, tier: TutorTier): AsyncGenerator<string> {
  const { instructions, context } = buildSystemPrompt(grounding);
  const stream = anthropic().messages.stream({
    model: TUTOR_MODELS[tier],
    max_tokens: 300,
    system: [
      { type: "text", text: instructions },
      { type: "text", text: context, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: question }],
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
