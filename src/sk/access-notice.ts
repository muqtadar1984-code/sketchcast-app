// SK B8 — the access block of the session view and the one notice the
// student panel shows from it. Client-safe on purpose (no node imports): the
// panel renders this; loop.ts builds it.

export type AccessView = {
  /** Who let the student in: a school licence, their own plan, a book grant,
   * the dev-flag (no entitlement source wired), or nobody ("none": a session
   * whose access ended after it was opened). */
  source: "dev-flag" | "school" | "subscription" | "grant" | "none";
  grantSource: string | null;
  /** Prepared teaching, checks and practice. */
  book: boolean;
  /** Live help now: questions and asides. */
  tutor: boolean;
  tutorExpiresAt: string | null;
  /** Live allowance left this period; null = not metered. */
  allowance: { liveTurns: number | null; generatedSegments: number | null } | null;
  liveExhausted: boolean;
  warning: "none" | "75" | "90" | "exhausted";
  /** FEATURE_SK_ALLOWANCE — when false nothing is refused for allowance (usage is still counted). */
  enforced: boolean;
};

/** SK's line when a live turn is refused: tutoring window over, or the
 * month's live allowance spent. Prepared teaching carries on either way.
 * (Wording is the founder's call — see the B8 PR.) */
export const LIVE_ENDED_TEXT = "Your live tutoring time for this book has ended, so I can't take new questions — but the lessons, checks and practice are all still here. Say continue, or use the buttons, and we'll carry on.";
export const LIVE_EXHAUSTED_TEXT = "You've used this month's live-question allowance, so I can't answer new questions until it resets — the lessons, checks and practice all carry on. Say continue and we'll keep going.";
export const NO_BOOK_ACCESS_TEXT = "You don't have access to this book yet. Activate your copy, or sign in with the account that holds it.";

/** The panel's small notice, or null when there is nothing to say. */
export function accessNotice(a: AccessView | null | undefined): string | null {
  if (!a || a.source === "dev-flag") return null;
  if (!a.book) return "Your access to this book has ended.";
  if (!a.tutor) return a.tutorExpiresAt ? "Live tutoring for this book has ended — the lessons, checks and practice are still yours." : "This book comes without live tutoring — the lessons, checks and practice are all here.";
  if (a.liveExhausted) return "This month's live-question allowance is used up. Lessons, checks and practice carry on.";
  if (a.warning === "90") return "You've used 90% of this month's live questions.";
  if (a.warning === "75") return "You've used 75% of this month's live questions.";
  return null;
}
