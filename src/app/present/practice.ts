// Worksheet practice on the student Board — the CLIENT's pure half (SK student
// Board plan 2026-10-31, phase 2). What she has done on each question this
// session, the score line at the end, how a revealed key reads, and the
// `sk:learner-gap` event that hands a struggling question to SK's teaching
// (phase 3, built separately — this only fires the event).
//
// Nothing here checks an answer: the server does (/api/present/learn/answer),
// and the key reaches the browser only at the ladder's "answer" rung.

export type Rung = "hint" | "step" | "answer";
export type HelpSource = "paper" | "cache" | "model" | "generic";
export type RevealedKey =
  | { type: "text"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "pairs"; value: { left: string; right: string }[] };

/** The route's reply (src/sk/practice/service.ts PracticeReply). */
export type PracticeReply = {
  outcome: "correct" | "incorrect" | "review" | "help";
  correct: boolean;
  attemptNo: number;
  wrong: number;
  rung: "none" | Rung;
  help: { rung: Rung; text: string | null; source: HelpSource } | null;
  answer: RevealedKey | null;
  done: boolean;
  gap: "wrong_twice" | null;
  concept: string | null;
};

/** One question, as far as she has got with it this session. */
export type QuestionState = {
  /** Answers sent (help taps not counted). */
  attempts: number;
  wrong: number;
  /** Help served, in order (one per rung reached). */
  help: { rung: Rung; text: string | null; source: HelpSource }[];
  answer: RevealedKey | null;
  correct: boolean;
  /** A written answer sent to her teacher (subjective). */
  review: boolean;
  done: boolean;
  lastAnswer: string | null;
  concept: string | null;
};

export const emptyQuestion = (): QuestionState => ({ attempts: 0, wrong: 0, help: [], answer: null, correct: false, review: false, done: false, lastAnswer: null, concept: null });

export const practiceKey = (generationId: string | undefined, questionId: string | undefined) => `${generationId ?? ""}:${questionId ?? ""}`;

/** Her answer as one line of text (the event's `lastAnswer`, the panel's echo). */
export function answerText(a: unknown): string | null {
  if (typeof a === "boolean") return a ? "true" : "false";
  if (typeof a === "string") return a.trim() || null;
  if (Array.isArray(a)) return a.map((x) => String(x ?? "")).join(" | ") || null;
  return null;
}

/** Fold one reply into the question's state. */
export function applyReply(prev: QuestionState, reply: PracticeReply, given: unknown): QuestionState {
  const isAnswer = reply.outcome !== "help";
  const next: QuestionState = {
    ...prev,
    attempts: prev.attempts + (isAnswer ? 1 : 0),
    wrong: reply.wrong,
    correct: prev.correct || reply.correct,
    review: prev.review || reply.outcome === "review",
    done: prev.done || reply.done,
    lastAnswer: isAnswer ? answerText(given) : prev.lastAnswer,
    concept: reply.concept ?? prev.concept,
    answer: reply.answer ?? prev.answer,
    help: reply.help && !prev.help.some((h) => h.rung === reply.help!.rung) ? [...prev.help, reply.help] : prev.help,
  };
  return next;
}

/** The highest rung she has reached on this question, or null. */
export function rungReached(q: QuestionState): Rung | null {
  return q.answer ? "answer" : q.help.length ? q.help[q.help.length - 1].rung : null;
}

/** Is the question finished on the Board (nothing left to submit)? */
export const finished = (q: QuestionState | undefined): boolean => !!q && (q.done || q.correct || q.review);

/**
 * "Your score: 7/10 · 2 hints". `total` = the questions the server marks
 * (written answers go to the teacher and are not in it); `correct` = those
 * she got right, with or without help; `hints` = help rungs served.
 */
export function practiceSummary(questions: { qtype?: string; key: string }[], state: ReadonlyMap<string, QuestionState>): { correct: number; total: number; hints: number; finished: boolean } {
  let correct = 0;
  let total = 0;
  let hints = 0;
  let open = 0;
  for (const q of questions) {
    const s = state.get(q.key);
    if (s) hints += s.help.length;
    if (!finished(s) && !(s?.answer)) open += 1;
    if (q.qtype === "subjective") continue;
    total += 1;
    if (s?.correct) correct += 1;
  }
  return { correct, total, hints, finished: questions.length > 0 && open === 0 };
}

/** SK's one line at the end: well done at 70 % or better, keep going below. */
export function endLine(s: { correct: number; total: number }, words: { wellDone: string; keepGoing: string }): string {
  return s.total > 0 && s.correct / s.total >= 0.7 ? words.wellDone : words.keepGoing;
}

/** A revealed key as she reads it. */
export function keyLine(k: RevealedKey, words: { answerTrue: string; answerFalse: string }): string {
  if (k.type === "bool") return k.value ? words.answerTrue : words.answerFalse;
  if (k.type === "pairs") return k.value.map((p) => `${p.left} → ${p.right}`).join(" · ");
  return k.value;
}

// ── the hand-off to SK's teaching (phase 3) ─────────────────────────────────

export const LEARNER_GAP_EVENT = "sk:learner-gap";

export type LearnerGapDetail = {
  generationId: string;
  questionId: string;
  questionText: string;
  concept: string | null;
  attempts: number;
  lastAnswer: string | null;
  reason: "wrong_twice" | "asked_help";
};

/** The event's detail — exactly the agreed contract, nothing else. */
export function gapDetail(o: {
  generationId: string;
  questionId: string;
  questionText: string;
  concept?: string | null;
  attempts: number;
  lastAnswer?: string | null;
  reason: "wrong_twice" | "asked_help";
}): LearnerGapDetail {
  return {
    generationId: o.generationId,
    questionId: o.questionId,
    questionText: o.questionText,
    concept: o.concept ?? null,
    attempts: o.attempts,
    lastAnswer: o.lastAnswer ?? null,
    reason: o.reason,
  };
}

/** Fire `sk:learner-gap` on the window (no-op without one). */
export function dispatchGap(detail: LearnerGapDetail, target: { dispatchEvent(e: Event): boolean } | null = typeof window === "undefined" ? null : window): void {
  if (!target || typeof CustomEvent === "undefined") return;
  target.dispatchEvent(new CustomEvent(LEARNER_GAP_EVENT, { detail }));
}
