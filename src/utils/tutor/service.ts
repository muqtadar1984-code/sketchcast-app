// AI Tutor service layer — the I/O the pure core (models.ts) can't do: Anthropic
// calls, grounding + access reads, and the shared answer cache. Server-only.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEntitlement, getSchoolEntitlement } from "@/utils/stripe/entitlements";
import {
  TUTOR_MODELS,
  CACHE_NEAR_EXACT,
  CACHE_FUZZY,
  CACHE_VERIFY_AT,
  buildSystemPrompt,
  gradeAnswers,
  scoreMastery,
  planGrantsTutor,
  type Grounding,
  type TutorTier,
  type CacheRow,
  type Question,
  type StudentModel,
  type Mastery,
} from "./models";

export function anthropic(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  return new Anthropic({ apiKey: key });
}

export type TutorContext = { bookId: string; chapterNum: number };

/** Access + chapter resolution. The coach on a lesson is available to anyone who
 * legitimately has that lesson in front of them: (a) the teacher/creator who OWNS
 * the generation (previewing their own lesson), (b) a STUDENT the lesson is
 * assigned to, or (c) a VERIFIED PARENT of such a student. Returns null (→ 403)
 * otherwise. Personalisation (weak spots, mastery, recap) only applies for the
 * assigned student; owners/parents get a generic chapter coach. */
export async function resolveTutorContext(
  admin: SupabaseClient,
  userId: string,
  generationId: string,
): Promise<TutorContext | null> {
  const { data: gen } = await admin
    .from("generations")
    .select("book_id, chapter_ref, owner_id")
    .eq("id", generationId)
    .maybeSingle();
  if (!gen?.book_id) return null;

  const chapterNum = parseInt(String(gen.chapter_ref ?? ""), 10);
  if (Number.isNaN(chapterNum)) return null;
  const ctx: TutorContext = { bookId: gen.book_id as string, chapterNum };

  // (a) the owner — teacher/creator previewing their own lesson.
  if (gen.owner_id === userId) return ctx;

  // (b) a student the lesson is ASSIGNED to.
  const { data: prog } = await admin
    .from("student_progress")
    .select("id")
    .eq("generation_id", generationId)
    .eq("student_id", userId)
    .maybeSingle();
  if (prog) return ctx;

  // (c) a VERIFIED parent of a student the lesson is assigned to.
  const { data: links } = await admin
    .from("parent_links")
    .select("child_id")
    .eq("parent_id", userId)
    .not("verified_at", "is", null);
  const childIds = (links ?? []).map((l) => l.child_id as string);
  if (childIds.length) {
    const { data: childProg } = await admin
      .from("student_progress")
      .select("id")
      .eq("generation_id", generationId)
      .in("student_id", childIds)
      .maybeSingle();
    if (childProg) return ctx;
  }
  return null;
}

/** Does the lesson OWNER's plan grant the AI Tutor? Pro+ (teacher_pro_plus /
 * family) grants it directly; a teacher on a school plan is covered by the
 * school's entitlement. Plain Pro does not. Used only when Pro+ is being enforced
 * (post-trial) — during the open trial the feature flag alone grants access. */
export async function tutorEntitled(admin: SupabaseClient, generationId: string): Promise<boolean> {
  const { data: gen } = await admin.from("generations").select("owner_id").eq("id", generationId).maybeSingle();
  const ownerId = (gen?.owner_id as string | undefined) ?? "";
  if (!ownerId) return false;

  const ent = await getEntitlement(ownerId);
  if (ent.active && planGrantsTutor(ent.plan_key)) return true;

  // School staff: the school's top-tier plan covers its teachers.
  const { data: prof } = await admin.from("profiles").select("school_id").eq("id", ownerId).maybeSingle();
  const schoolId = (prof?.school_id as string | undefined) ?? "";
  if (schoolId) {
    const school = await getSchoolEntitlement(schoolId);
    if (school.active) return true;
  }
  return false;
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
    .select("chapter_title, concepts, script_text, source_text")
    .eq("book_id", bookId)
    .eq("chapter_num", chapterNum)
    .maybeSingle();
  if (!data) return null;
  return {
    chapterTitle: (data.chapter_title as string) ?? "this chapter",
    concepts: data.concepts ?? null,
    scriptText: (data.script_text as string | null) ?? null,
    // The chapter's raw book text (persisted at index time, or OCR-cached for
    // scanned books) — lets the assistant answer on chapters whose lessons
    // haven't been GENERATED yet: if it's in the book, it's answerable.
    sourceText: (data.source_text as string | null) ?? null,
  };
}

/** Load a quiz generation's questions.json (with the answer key) from the
 * artifacts bucket. Null when the generation has no interactive quiz. */
export async function loadQuestions(admin: SupabaseClient, generationId: string): Promise<Question[] | null> {
  const { data: art } = await admin
    .from("artifacts")
    .select("storage_path")
    .eq("generation_id", generationId)
    .eq("kind", "questions_json")
    .maybeSingle();
  if (!art?.storage_path) return null;
  const dl = await admin.storage.from("artifacts").download(art.storage_path as string);
  if (dl.error || !dl.data) return null;
  try {
    const parsed = JSON.parse(await dl.data.text());
    return Array.isArray(parsed?.questions) ? (parsed.questions as Question[]) : null;
  } catch {
    return null;
  }
}

/** Build the student model for a chapter from REAL evidence: their submissions to
 * this chapter's quizzes (worksheet/exam), re-graded against the answer key to
 * surface the specific questions they got wrong. Pure reads — no new grading. */
export async function buildStudentModel(
  admin: SupabaseClient,
  studentId: string,
  bookId: string,
  chapterNum: number,
  chapterTitle: string,
): Promise<StudentModel> {
  const none: StudentModel = { chapterTitle, attempted: false, scorePct: null, weakQuestions: [] };

  // Quiz generations for this exact chapter.
  const { data: gens } = await admin
    .from("generations")
    .select("id")
    .eq("book_id", bookId)
    .eq("chapter_ref", String(chapterNum))
    .in("kind", ["worksheet", "exam_paper"]);
  const genIds = (gens ?? []).map((g) => g.id as string);
  if (genIds.length === 0) return none;

  // The student's own submissions to those quizzes, newest first.
  const { data: subs } = await admin
    .from("submissions")
    .select("generation_id, answers, auto_score, max_score")
    .eq("student_id", studentId)
    .in("generation_id", genIds)
    .order("submitted_at", { ascending: false });
  if (!subs?.length) return none;

  let scorePct: number | null = null;
  const weak: string[] = [];
  for (const sub of subs) {
    if (scorePct === null && sub.max_score) {
      scorePct = Math.round(((sub.auto_score as number) ?? 0) / (sub.max_score as number) * 100);
    }
    const questions = await loadQuestions(admin, sub.generation_id as string);
    if (questions && sub.answers) {
      weak.push(...gradeAnswers(questions, sub.answers as Record<string, unknown>).wrong);
    }
    if (weak.length >= 5) break;
  }
  const weakQuestions = Array.from(new Set(weak)).slice(0, 5);
  return { chapterTitle, attempted: true, scorePct, weakQuestions };
}

// ── mastery (M3) ─────────────────────────────────────────────────────────────

/** Append a mastery signal. Fire-and-forget: a logging failure must never break
 * a tutor turn, so errors are swallowed. */
export async function recordMastery(
  admin: SupabaseClient,
  m: {
    studentId: string;
    bookId: string;
    chapterNum: number;
    source: "tutor" | "quiz";
    signal: "engaged" | "correct" | "incorrect";
    weight?: number;
    detail?: string;
  },
): Promise<void> {
  try {
    await admin.from("mastery_events").insert({
      student_id: m.studentId,
      book_id: m.bookId,
      chapter_num: m.chapterNum,
      source: m.source,
      signal: m.signal,
      weight: m.weight ?? 1,
      detail: m.detail ?? null,
    });
  } catch {
    /* mastery logging is best-effort */
  }
}

/** The honest chapter-mastery estimate for the recap: authoritative quiz evidence
 * (re-graded from real submissions) combined with tutor practice count. Reuses
 * buildStudentModel so the recap and the greeting can never disagree, and returns
 * the underlying model so the recap can also show the weak spots. */
export async function buildMastery(
  admin: SupabaseClient,
  studentId: string,
  bookId: string,
  chapterNum: number,
  chapterTitle: string,
): Promise<{ mastery: Mastery; practiceCount: number; model: StudentModel }> {
  const model = await buildStudentModel(admin, studentId, bookId, chapterNum, chapterTitle);
  const { data } = await admin.rpc("tutor_mastery_summary", { p_student: studentId, p_book: bookId, p_chapter: chapterNum });
  const practiceCount = Number((data as { engaged?: number }[] | null)?.[0]?.engaged ?? 0);
  const mastery = scoreMastery({ scorePct: model.scorePct, weakCount: model.weakQuestions.length, practiceCount });
  return { mastery, practiceCount, model };
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
): Promise<string | null> {
  const { data } = await admin
    .from("tutor_messages")
    .insert({
      student_id: m.studentId,
      generation_id: m.generationId,
      book_id: m.bookId,
      chapter_num: m.chapterNum,
      role: m.role,
      content: m.content,
      tutor_move: m.tutorMove ?? null,
    })
    .select("id")
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** Load the text of a COACH message the requesting student actually received on
 * this lesson. This is the ONLY text the voice route will synthesise — so a
 * student can never make the (premium) voice speak arbitrary, un-fenced text:
 * every voiced string is a real coach reply that already passed the closed-book
 * safety fence. Null when the id isn't a coach message owned by this student on
 * this generation. */
export async function loadOwnCoachMessage(
  admin: SupabaseClient,
  messageId: string,
  studentId: string,
  generationId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("tutor_messages")
    .select("content")
    .eq("id", messageId)
    .eq("student_id", studentId)
    .eq("generation_id", generationId)
    .eq("role", "coach")
    .maybeSingle();
  return (data?.content as string | undefined) ?? null;
}

/** Stream a grounded, safe answer from Claude. The chapter CONTEXT is a cached
 * prompt prefix (identical across a chapter's questions → paid once). Yields
 * text chunks as they arrive. */
export async function* streamAnswer(
  question: string,
  grounding: Grounding,
  tier: TutorTier,
  studentContext = "",
  history: { role: "user" | "assistant"; content: string }[] = [],
): AsyncGenerator<string> {
  const { instructions, context } = buildSystemPrompt(grounding);
  // The chapter grounding is a CACHED prefix (identical across a chapter's
  // questions). The per-student context is NOT cached (it varies per child).
  const system = [
    { type: "text" as const, text: instructions },
    { type: "text" as const, text: context, cache_control: { type: "ephemeral" as const } },
    ...(studentContext ? [{ type: "text" as const, text: studentContext }] : []),
  ];
  const stream = anthropic().messages.stream({
    model: TUTOR_MODELS[tier],
    max_tokens: 300,
    system,
    // Prior turns give the coach memory of the thread; the new question is last.
    messages: [...history, { role: "user", content: question }],
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
