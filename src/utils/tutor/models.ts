// AI Tutor (Pro+) — pure, testable core: model tiering, question normalisation,
// the closed-book grounding/safety prompt, and the CONSERVATIVE cache-serve rule.
// No I/O here so it can be unit-tested without a DB or the network.

/** Model tiers. Cheap (Haiku) handles routine grounded answers; strong (Sonnet)
 * is reserved for harder/novel questions — and, later, the Socratic teaching
 * turns. Kept here so the escalation policy lives in one place. */
export const TUTOR_MODELS = {
  cheap: "claude-haiku-4-5-20251001",
  strong: "claude-sonnet-5",
} as const;
export type TutorTier = keyof typeof TUTOR_MODELS;

/** Conservative cache thresholds (pg_trgm similarity, 0–1). A near-exact repeat
 * is safe to replay even if unverified; a merely-similar question is only
 * replayed once its answer has been verified by repeated use. */
export const CACHE_NEAR_EXACT = 0.82;
export const CACHE_FUZZY = 0.6;
export const CACHE_VERIFY_AT = 10;

export type Grounding = {
  chapterTitle: string;
  concepts: unknown; // Agent-2 analysis (jsonb) — definitions, prerequisites, difficulty
  scriptText: string | null; // the lesson's own narration text
};

/** Normalise a question for cache matching: lower-case, collapse whitespace,
 * drop trailing punctuation. Deterministic so the same question maps identically. */
export function normalizeQuestion(q: string): string {
  return (q || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.\s]+$/g, "")
    .trim();
}

/** Pick the model tier. Cheap by default; escalate to the strong model for
 * reasoning-heavy or long questions, which benefit from deeper thinking. */
export function pickTier(question: string): TutorTier {
  const q = (question || "").toLowerCase();
  const hard = /\b(why|how come|prove|derive|compare|contrast|explain why|what if|because|relationship|difference between)\b/.test(q);
  const long = q.length > 140;
  return hard || long ? "strong" : "cheap";
}

/** Build the closed-book grounding + child-safety system prompt. The chapter
 * CONTEXT is returned separately so the caller can mark it a cached prompt prefix
 * (it's identical across every question in a chapter → paid for once). */
export function buildSystemPrompt(g: Grounding): { instructions: string; context: string } {
  const instructions =
    `You are "Coach", a warm, encouraging tutor helping a school student with the chapter ` +
    `"${g.chapterTitle}". Follow these rules exactly:\n` +
    `1. Answer ONLY using the CHAPTER CONTEXT provided. If the answer is not in it, say it is ` +
    `not in this chapter and gently steer the student back — never guess or use outside knowledge.\n` +
    `2. Never produce unsafe, adult, violent, hateful, or off-topic content. If asked, kindly ` +
    `redirect to the chapter.\n` +
    `3. Be warm and Socratic: 2–4 short sentences, no markdown, speak directly to the student, and ` +
    `where it helps, end with a small question that nudges them to think.\n` +
    `4. Never do the student's graded work for them or hand over exam answers — guide them instead.`;
  return { instructions, context: buildContext(g) };
}

function buildContext(g: Grounding): string {
  const parts: string[] = [`CHAPTER: ${g.chapterTitle}`];
  if (g.concepts) {
    try {
      parts.push("CONCEPTS:\n" + JSON.stringify(g.concepts).slice(0, 12000));
    } catch {
      /* non-serialisable → skip */
    }
  }
  if (g.scriptText) parts.push("LESSON NARRATION:\n" + g.scriptText.slice(0, 12000));
  return parts.join("\n\n");
}

// ── personalisation (M2): weak spots from the student's real quiz answers ─────
// questions.json carries no concept tags, so we re-grade the stored answers
// against the answer key (same rule as the quiz player) to find the actual
// questions the student got wrong — genuinely specific, from real evidence.

export type Question = {
  id: string;
  type: "fill_blank" | "true_false" | "match" | "short" | "subjective";
  prompt: string;
  answer?: unknown;
  pairs?: { left: string; right: string }[];
  marks?: number;
};

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Re-grade a submission against its answer key. Returns the PROMPTS of the
 * objective questions the student got wrong (short/subjective are teacher-graded,
 * so they're skipped). Mirrors quiz-player.tsx exactly. Pure. */
export function gradeAnswers(
  questions: Question[],
  answers: Record<string, unknown>,
): { wrong: string[]; correct: number; gradable: number } {
  const wrong: string[] = [];
  let correct = 0;
  let gradable = 0;
  for (const q of questions || []) {
    if (q.type === "fill_blank" || q.type === "true_false" || q.type === "match") {
      gradable++;
      let ok = false;
      if (q.type === "fill_blank") ok = !!norm(answers[q.id]) && norm(answers[q.id]) === norm(q.answer);
      else if (q.type === "true_false") ok = typeof answers[q.id] === "boolean" && answers[q.id] === q.answer;
      else {
        const picked = (answers[q.id] as Record<number, string>) || {};
        const pairs = q.pairs || [];
        ok = pairs.length > 0 && pairs.every((p, i) => norm(picked[i]) === norm(p.right));
      }
      if (ok) correct++;
      else wrong.push(q.prompt);
    }
  }
  return { wrong, correct, gradable };
}

export type StudentModel = {
  chapterTitle: string;
  attempted: boolean; // has the student submitted a quiz for this chapter?
  scorePct: number | null; // most-recent objective score, if any
  weakQuestions: string[]; // prompts of questions they got wrong (deduped, capped)
};

function shorten(s: string, n = 90): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

/** The opening line the Coach greets the child with. Names a real weak spot when
 * there's evidence; a warm diagnostic opener when there isn't (cold start). */
export function buildGreeting(sm: StudentModel): string {
  if (!sm.attempted) {
    return `Hi, I'm Coach! Ask me anything about "${sm.chapterTitle}". Not sure where to start? Say "quiz me" and we'll find out together.`;
  }
  if (sm.weakQuestions.length) {
    return `Welcome back! Last time on "${sm.chapterTitle}", this one tripped you up: "${shorten(sm.weakQuestions[0])}". Want to nail it today? Ask me anything.`;
  }
  return `Nice work on "${sm.chapterTitle}" — you got the quiz right! Want to go a little deeper? Ask me anything.`;
}

/** A gentle per-student hint fed into the answer prompt so replies lean toward
 * the child's weak spots. Empty when there's nothing to personalise. */
export function buildStudentContext(sm: StudentModel): string {
  if (!sm.attempted || !sm.weakQuestions.length) return "";
  return (
    "STUDENT CONTEXT (use gently to personalise your help; never read it out verbatim): " +
    "this student recently struggled with — " +
    sm.weakQuestions.slice(0, 5).map((q) => `"${shorten(q)}"`).join("; ") +
    "."
  );
}

export type CacheRow = { id: string; answer_text: string; is_verified: boolean };

/** CONSERVATIVE serve rule: only replay a cached answer when it's a near-exact
 * match (safe) OR already verified. A fuzzy-but-different question is regenerated
 * fresh, so a near-miss can never be served as if it were the real answer. */
export function shouldServeCached(row: CacheRow | null | undefined, nearExact: boolean): boolean {
  if (!row) return false;
  return nearExact || row.is_verified === true;
}
