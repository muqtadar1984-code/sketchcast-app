// The feedback questionnaire's pure client-side logic — what counts as a
// complete answer set, and the exact POST /api/feedback body built from one.
// Kept out of the component so the rules the Send button enforces are
// unit-tested directly (the server re-validates; this is the UX gate).
//
// The option keys ARE the DB's most_used check-constraint values
// (0083_feedback_requests.sql) — "none" is the "Haven't used them yet" pick.
// NOTE the display label for exam_paper is "Test paper" (existing UI naming),
// never "exam paper"; labels live in the feedbackAsk.q4Options messages.

export const MOST_USED_OPTIONS = [
  "presentation",
  "worksheet",
  "exam_paper",
  "lesson_plan",
  "activity",
  "case_study",
  "none",
] as const;

export type MostUsed = (typeof MOST_USED_OPTIONS)[number];

/** The three 1–5 ratings, in DB column order. */
export const RATING_KEYS = ["ease", "usefulness", "quality"] as const;
export type RatingKey = (typeof RATING_KEYS)[number];

/** What the modal holds while the teacher fills it in. 0 = not yet rated;
 *  "" = no most-used pick yet. Textareas stay raw (trimmed only on build). */
export type QuestionnaireAnswers = {
  ease: number;
  usefulness: number;
  quality: number;
  mostUsed: MostUsed | "";
  blocker: string;
  wish: string;
  contactOk: boolean;
};

export const EMPTY_ANSWERS: QuestionnaireAnswers = {
  ease: 0,
  usefulness: 0,
  quality: 0,
  mostUsed: "",
  blocker: "",
  wish: "",
  contactOk: false,
};

const validRating = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 5;

/** Send requires the three ratings and the most-used pick; the two textareas
 *  and the contact checkbox are optional. */
export function answersComplete(a: QuestionnaireAnswers): boolean {
  return (
    validRating(a.ease) &&
    validRating(a.usefulness) &&
    validRating(a.quality) &&
    (MOST_USED_OPTIONS as readonly string[]).includes(a.mostUsed)
  );
}

export type SubmitBody = {
  action: "submit";
  request_id: string;
  ease: number;
  usefulness: number;
  quality: number;
  most_used: MostUsed;
  blocker: string | null;
  wish: string | null;
  contact_ok: boolean;
};

/** The exact submit payload, or null while the answers are incomplete —
 *  the same check the Send button uses, so a disabled-button bypass (enter
 *  key, stale state) can never post a half-filled form. Free text travels
 *  trimmed; an empty or whitespace-only textarea becomes null, not "". */
export function buildSubmitBody(requestId: string, a: QuestionnaireAnswers): SubmitBody | null {
  if (!answersComplete(a)) return null;
  return {
    action: "submit",
    request_id: requestId,
    ease: a.ease,
    usefulness: a.usefulness,
    quality: a.quality,
    most_used: a.mostUsed as MostUsed,
    blocker: a.blocker.trim() || null,
    wish: a.wish.trim() || null,
    contact_ok: a.contactOk,
  };
}
