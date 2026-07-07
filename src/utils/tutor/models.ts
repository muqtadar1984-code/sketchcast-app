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

export type CacheRow = { id: string; answer_text: string; is_verified: boolean };

/** CONSERVATIVE serve rule: only replay a cached answer when it's a near-exact
 * match (safe) OR already verified. A fuzzy-but-different question is regenerated
 * fresh, so a near-miss can never be served as if it were the real answer. */
export function shouldServeCached(row: CacheRow | null | undefined, nearExact: boolean): boolean {
  if (!row) return false;
  return nearExact || row.is_verified === true;
}
