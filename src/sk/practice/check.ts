// Worksheet practice on the student Board (SK student Board plan 2026-10-31,
// phase 2): checking ONE answer against the paper's key, on the server.
// PURE — no Supabase, no model — so the route and the tests share it.
//
// THE SAME GRADER AS THE QUIZ, FOR WHAT THE QUIZ GRADES. fill_blank, mcq,
// true_false and match are marked exactly as /api/quiz/submit marks them
// (app/api/quiz/logic.ts scoreQuiz: fillBlankCorrect with its numeric
// reading, the mcq option text, a real boolean, the match pairs). Practice is
// a little kinder in two places, and ONLY here, never in the quiz's mark:
//   * a number she ROUNDED is right (key 3.14159, "3.14"): she gave d ≥ 1
//     decimals, fewer than the key has, and the key rounds to her value at d;
//   * a `short` answer (the quiz sends it to the teacher) is right when it
//     matches the key exactly or as a number, or when it carries every
//     content word of a short key ("the nucleus" for "Nucleus"). Anything
//     else is wrong — the help ladder, not a lenient mark, is the remedy.
// `subjective` is never auto-marked: outcome "review" (her teacher marks it),
// and the ladder still offers help on request.

import { norm, type RawQuestion } from "@/app/api/quiz/logic";
import { fillBlankCorrect, parseNumeric } from "@/app/api/quiz/numeric";

export type PracticeType = RawQuestion["type"];
export const PRACTICE_TYPES: readonly PracticeType[] = ["fill_blank", "short", "true_false", "match", "mcq", "subjective"];

export type CheckOutcome = "correct" | "incorrect" | "review";

/** What she answered, bounded and shaped for the question type; null = not an answer to it. */
export type GivenAnswer = string | boolean | string[];

const MAX_TEXT = 500;

/**
 * Shape the body's `answer` for this question type. Strings are trimmed and
 * cut at 500 characters; a match answer is one string per left-hand prompt.
 * Null when it is not an answer this question can take (the route says 400).
 */
export function shapeAnswer(q: RawQuestion, raw: unknown): GivenAnswer | null {
  if (q.type === "true_false") return typeof raw === "boolean" ? raw : null;
  if (q.type === "match") {
    const n = Array.isArray(q.pairs) ? q.pairs.length : 0;
    if (!Array.isArray(raw) || raw.length !== n || n === 0) return null;
    if (!raw.every((x) => typeof x === "string")) return null;
    return (raw as string[]).map((s) => s.slice(0, MAX_TEXT));
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim().slice(0, MAX_TEXT);
  return s ? s : null;
}

/** Decimal places written in a numeric answer ("3.140" → 3). */
function decimalsOf(s: string): number {
  const m = /\d[.,](\d+)/.exec(s);
  return m ? m[1].length : 0;
}

/**
 * Practice's tolerant numeric compare: the exact numeric reading first (the
 * quiz's), then "she rounded the key correctly" — d ≥ 1 decimals given, the
 * key written with more, same π-ness and units, |key − given| ≤ ½·10^-d.
 */
export function numericClose(key: unknown, given: unknown): boolean {
  const k = parseNumeric(key);
  const g = parseNumeric(given);
  if (!k || !g) return false;
  if (k.pi !== g.pi) return false;
  if (k.unit && g.unit && k.unit !== g.unit) return false;
  if (Math.abs(k.value - g.value) <= 1e-9 * Math.max(1, Math.abs(k.value))) return true;
  const d = decimalsOf(String(given));
  if (d < 1 || d >= decimalsOf(String(key)) || d > 6) return false;
  return Math.abs(k.value - g.value) <= 0.5 * 10 ** -d + 1e-12;
}

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "and", "or", "is", "are", "it", "its", "by", "for", "with", "at", "as", "be"]);
const words = (s: string): string[] =>
  norm(s)
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Every content word of a SHORT key (≤ 4 content words) appears in her answer. */
export function keyWordsPresent(key: unknown, given: unknown): boolean {
  const kw = words(String(key ?? "")).filter((w) => !STOP.has(w));
  if (kw.length === 0 || kw.length > 4) return false;
  const have = new Set(words(String(given ?? "")));
  return kw.every((w) => have.has(w));
}

/** Check one answer. The key never leaves this function. */
export function checkAnswer(q: RawQuestion, given: GivenAnswer): CheckOutcome {
  switch (q.type) {
    case "fill_blank":
      return fillBlankCorrect(q.answer, q.accept, given) || [q.answer, ...(q.accept ?? [])].some((k) => numericClose(k, given)) ? "correct" : "incorrect";
    case "short": {
      const keys = [q.answer, ...(q.accept ?? [])];
      if (fillBlankCorrect(q.answer, q.accept, given)) return "correct";
      if (keys.some((k) => numericClose(k, given) || keyWordsPresent(k, given))) return "correct";
      return "incorrect";
    }
    case "mcq":
      return norm(given) !== "" && norm(given) === norm(q.answer) ? "correct" : "incorrect";
    case "true_false":
      return typeof given === "boolean" && typeof q.answer === "boolean" && given === q.answer ? "correct" : "incorrect";
    case "match": {
      const pairs = Array.isArray(q.pairs) ? q.pairs : [];
      const picked = Array.isArray(given) ? given : [];
      return pairs.length > 0 && pairs.every((p, i) => norm(picked[i]) !== "" && norm(picked[i]) === norm(p.right)) ? "correct" : "incorrect";
    }
    default:
      return "review";
  }
}

/** The key as the ANSWER rung shows it (only ever sent at that rung). */
export type RevealedKey =
  | { type: "text"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "pairs"; value: { left: string; right: string }[] };

export function revealKey(q: RawQuestion): RevealedKey | null {
  switch (q.type) {
    case "true_false":
      return typeof q.answer === "boolean" ? { type: "bool", value: q.answer } : null;
    case "match":
      return Array.isArray(q.pairs) && q.pairs.length ? { type: "pairs", value: q.pairs.map((p) => ({ left: String(p?.left ?? ""), right: String(p?.right ?? "") })) } : null;
    case "subjective":
      return q.answer_outline ? { type: "text", value: String(q.answer_outline) } : null;
    default:
      return q.answer !== undefined && String(q.answer).trim() ? { type: "text", value: String(q.answer) } : null;
  }
}

/** The key as plain text (the model's grounding and the leak check). */
export function keyText(q: RawQuestion): string {
  const k = revealKey(q);
  if (!k) return "";
  if (k.type === "bool") return k.value ? "true" : "false";
  if (k.type === "pairs") return k.value.map((p) => `${p.left} → ${p.right}`).join("; ");
  return k.value;
}

/** The concept / skill the paper tags this question with, when it names one. */
export function conceptOf(q: RawQuestion): string | null {
  const r = q as unknown as Record<string, unknown>;
  for (const f of ["concept", "skill", "objective", "topic", "tag"]) {
    const v = r[f];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
  }
  return null;
}
