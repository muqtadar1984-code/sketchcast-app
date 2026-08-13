/** Which activation nudge (if any) a user should receive.
 *
 * Kept as a pure function over already-fetched facts so every rule is testable
 * without a database, a clock, or an email provider.
 */

export type Segment = "no_book" | "no_generation";

export type UserFacts = {
  userId: string;
  email: string | null;
  /** ISO — account creation. */
  createdAt: string;
  /** ISO — unsubscribe timestamp, null if still subscribed. */
  optedOutAt: string | null;
  bookCount: number;
  /** ISO of their FIRST book, null when they have none. */
  oldestBookAt: string | null;
  /**
   * Generation ATTEMPTS — every status, including failures.
   *
   * Attempts, not successes. This distinction is the whole reason the field is
   * named this way: one real user tried 24 times and succeeded once, because
   * our Anthropic balance hit zero and a branding bug ate the rest. Keying on
   * successes would have selected them for "ready to create your first
   * lesson?" — the worst possible message to someone we had just failed 23
   * times. Anyone who has tried is a support conversation, not a nudge.
   */
  generationAttempts: number;
  /** Segments this user has already been sent, ever. */
  alreadySent: readonly Segment[];
};

/** Give people a couple of days before nudging — an account created an hour
 * ago is still mid-session, not stalled. */
export const NO_BOOK_AFTER_DAYS = 3;
export const NO_GENERATION_AFTER_DAYS = 2;

const DAY_MS = 86_400_000;

function daysBetween(fromIso: string, now: Date): number {
  return (now.getTime() - new Date(fromIso).getTime()) / DAY_MS;
}

/**
 * @param since Cutoff — accounts created before this are NEVER emailed.
 *   Existing users were contacted by hand; a cron must not re-contact them.
 */
export function selectSegment(u: UserFacts, now: Date, since: Date): Segment | null {
  // Nothing to send to, nothing to send.
  if (!u.email) return null;

  // Unsubscribe is absolute and permanent.
  if (u.optedOutAt) return null;

  // New users only. Deliberately >= so the cutoff is inclusive of its own day.
  if (new Date(u.createdAt) < since) return null;

  // THE GUARD. Someone who has attempted anything — succeeded or failed — is
  // never a candidate for an activation nudge. See `generationAttempts`.
  if (u.generationAttempts > 0) return null;

  const sent = new Set(u.alreadySent);

  if (u.bookCount === 0) {
    if (sent.has("no_book")) return null;
    return daysBetween(u.createdAt, now) >= NO_BOOK_AFTER_DAYS ? "no_book" : null;
  }

  // Has a book, has never tried to generate. Time from the BOOK, not from
  // signup: someone who uploaded today doesn't need chasing because they
  // registered last month.
  if (sent.has("no_generation")) return null;
  if (!u.oldestBookAt) return null;
  return daysBetween(u.oldestBookAt, now) >= NO_GENERATION_AFTER_DAYS
    ? "no_generation"
    : null;
}
