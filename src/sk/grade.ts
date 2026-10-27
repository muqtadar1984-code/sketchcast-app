// SK B4 — deterministic grading for a check or practice item, built on the
// quiz's authoritative scorers (src/app/api/quiz/logic.ts) so a student's mark
// in SK is the same mark the same answer earns on a quiz paper. The three
// integrity rules of that file hold here too: the key never leaves the server
// (see stripItem in ./items), the score is derived server-side, and the
// match-option order is never derivable from public material.
//
// mcq, true_false, fill_blank and match are deterministic; short answers
// return needs_review for now (LLM partial credit, practice-only, is a later
// step — plan §10 "Grading rules").

import { scoreQuiz, type RawQuestion } from "@/app/api/quiz/logic";
import type { GradeOutcome } from "./types";

export const GRADE_RULE_VERSION = "sk-b4.1";
export const MAX_ATTEMPTS = 3;

export type GradeResult = {
  outcome: GradeOutcome;
  score: number;
  max: number;
  feedback: string;
  hintAvailable: boolean;
  /** Attempt 1, no hint, auto-marked: evidence the student did it alone. */
  independent: boolean;
  grader: "deterministic" | "teacher";
};

/** Spoken or typed answers arrive as text; coerce to what the scorer compares. */
export function coerceResponse(item: RawQuestion, response: unknown): unknown {
  if (item.type === "true_false") {
    if (typeof response === "boolean") return response;
    const s = String(response ?? "").trim().toLowerCase();
    if (["true", "t", "yes", "y", "correct", "right"].includes(s)) return true;
    if (["false", "f", "no", "n", "incorrect", "wrong"].includes(s)) return false;
    return response;
  }
  if (item.type === "mcq") {
    const s = String(response ?? "").trim();
    // A bare option letter ("B", "b)", "option c") → that option's text.
    const m = /^(?:option\s*)?([a-h])\s*[).:]?\s*$/i.exec(s);
    if (m) {
      const idx = m[1]!.toLowerCase().charCodeAt(0) - 97;
      if (idx < item.options.length) return item.options[idx];
    }
    return s;
  }
  if (item.type === "match") {
    // Accept {0: "...", 1: "..."} or ["...", "..."].
    if (Array.isArray(response)) return Object.fromEntries(response.map((v, i) => [i, v]));
    return response && typeof response === "object" ? response : {};
  }
  return typeof response === "string" ? response : String(response ?? "");
}

export function gradeItem(item: RawQuestion, response: unknown, opts: { attemptNo: number; hintsUsed: number }): GradeResult {
  const attemptNo = Math.max(1, Math.floor(opts.attemptNo));
  const hintsUsed = Math.max(0, Math.floor(opts.hintsUsed));
  if (item.type === "short" || item.type === "subjective") {
    return {
      outcome: "needs_review",
      score: 0,
      max: item.marks || 1,
      feedback: "Thanks — I'll have a teacher look at this one.",
      hintAvailable: false,
      independent: false,
      grader: "teacher",
    };
  }
  const { auto, max } = scoreQuiz([item], { [item.id]: coerceResponse(item, response) });
  const full = max > 0 ? auto >= max : auto > 0;
  const outcome: GradeOutcome = full ? "correct" : auto > 0 ? "partial" : "incorrect";
  const hintAvailable = outcome !== "correct" && attemptNo < MAX_ATTEMPTS;
  const feedback =
    outcome === "correct"
      ? attemptNo === 1
        ? "That's right."
        : "That's it — you got there."
      : outcome === "partial"
        ? `Partly right: ${auto} of ${max}.${hintAvailable ? " Want a hint for the rest?" : ""}`
        : hintAvailable
          ? "Not quite. Want a hint?"
          : "Not quite — let's look at it together.";
  return { outcome, score: auto, max, feedback, hintAvailable, independent: outcome === "correct" && attemptNo === 1 && hintsUsed === 0, grader: "deterministic" };
}
