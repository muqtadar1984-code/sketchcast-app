// Pure derivations for the console roster's Actions cell and the
// /api/console/remind route (staff-only, English-only surface — no i18n keys).
// Kept as functions over already-fetched facts so every rule is testable
// without a database or a clock, mirroring src/utils/lifecycle/segments.ts.

export type RemindSegment = "no_upload" | "no_generation";

/** Founder's rule: ANY reminder that reached the user — manual (console_reminders)
 * or automated (lifecycle_emails) — disables manual sending for 3 days. */
export const REMIND_COOLDOWN_DAYS = 3;

/**
 * The largest per-teacher cap the console may set (`set_caps` in
 * /api/console/ops). It is the ONLY place in this repo's TypeScript that
 * carries this number.
 *
 * It is load-bearing beyond the form. Since migration 0105 a comp override of
 * at least a THRESHOLD — held once, in `premium_voices_allowed()` in
 * supabase/migrations/0105_premium_voices_threshold.sql — also unlocks the
 * premium narration voices. That threshold is deliberately NOT repeated here:
 * the database is the only thing that knows it, which is what stops the app
 * and the worker drifting apart.
 *
 * But the two numbers are related, and nothing in the type system says so:
 * if this ceiling ever drops BELOW the threshold, comping a teacher into the
 * premium voices becomes impossible through the console and nothing would
 * fail. src/__tests__/premium-voices-migration.test.ts reads the threshold out
 * of the migration and pins `CAP_CEILING >= threshold` for exactly that reason.
 */
export const CAP_CEILING = 100000;

const DAY_MS = 86_400_000;

/**
 * Which manual nudge fits, if any. Mirrors selectSegment's ATTEMPTS rule
 * (src/utils/lifecycle/segments.ts): anyone who has tried to generate — any
 * status, success or failure — is a support conversation, not a nudge target.
 * Unlike the cron there is no waiting period or since-cutoff: the founder is
 * looking at the row and deciding NOW.
 */
export function remindSegment(
  books: number,
  generationAttempts: number,
): RemindSegment | null {
  if (generationAttempts > 0) return null;
  if (books === 0) return "no_upload";
  return "no_generation";
}

/** Console segments map onto the lifecycle copy's vocabulary: the manual
 * "no_upload" sends the cron's "no_book" email, verbatim. */
export function lifecycleSegmentFor(segment: RemindSegment): "no_book" | "no_generation" {
  return segment === "no_upload" ? "no_book" : "no_generation";
}

/** When manual sending unblocks again after a send at `lastSentAtIso`. */
export function reminderRetryAfter(lastSentAtIso: string): Date {
  return new Date(new Date(lastSentAtIso).getTime() + REMIND_COOLDOWN_DAYS * DAY_MS);
}

export function reminderInCooldown(lastSentAtIso: string | null, now: Date): boolean {
  if (!lastSentAtIso) return false;
  return reminderRetryAfter(lastSentAtIso).getTime() > now.getTime();
}

// ── Feedback button ──────────────────────────────────────────────────────────

export type FeedbackRequestFacts = {
  /** ISO — when the request was created. */
  createdAt: string;
  /** ISO — "maybe later" until, null if never snoozed. */
  snoozedUntil: string | null;
  /** ISO — when the questionnaire was submitted, null while unanswered. */
  respondedAt: string | null;
};

export type FeedbackButtonState =
  | { kind: "hidden" } // students: the questionnaire never shows for them
  | { kind: "request" } // never asked (or a snooze lapsed unanswered) — active
  | { kind: "requested" } // open ask, awaiting an answer — disabled
  | { kind: "snoozed"; until: string } // user said "maybe later" — disabled
  | { kind: "answered" }; // answered — ACTIVE: a new request is allowed

/** OPEN = unanswered and not past its snooze — the same predicate the
 * /api/console/feedback-request route 409s on. */
export function isOpenFeedbackRequest(
  r: Pick<FeedbackRequestFacts, "snoozedUntil" | "respondedAt">,
  now: Date,
): boolean {
  if (r.respondedAt) return false;
  if (!r.snoozedUntil) return true;
  return new Date(r.snoozedUntil).getTime() > now.getTime();
}

export function deriveFeedbackState(
  requests: readonly FeedbackRequestFacts[],
  now: Date,
  role?: string | null,
): FeedbackButtonState {
  // The dashboard never shows the questionnaire to students and the route
  // refuses them — hiding the button keeps the roster honest about that.
  if (role === "student") return { kind: "hidden" };
  // At most one open request exists (the route enforces it), but derive from
  // the newest one anyway so a historical double never wedges the button.
  let open: FeedbackRequestFacts | null = null;
  let answered = false;
  for (const r of requests) {
    if (r.respondedAt) answered = true;
    if (!isOpenFeedbackRequest(r, now)) continue;
    if (!open || r.createdAt > open.createdAt) open = r;
  }
  if (open) {
    return open.snoozedUntil && new Date(open.snoozedUntil).getTime() > now.getTime()
      ? { kind: "snoozed", until: open.snoozedUntil }
      : { kind: "requested" };
  }
  return answered ? { kind: "answered" } : { kind: "request" };
}

// ── Remind button ────────────────────────────────────────────────────────────

export type RemindFacts = {
  /** profiles.role — lifecycle mail is TEACHER-ONLY (0080: students are minors,
   * parents don't upload textbooks; emailing either would be wrong). */
  role: string;
  /** LIVE books (removed_at null) — what the roster's Books column shows. */
  books: number;
  /** Generation attempts, ANY status — any row in generations. */
  generationAttempts: number;
  /** profiles.email_optout_at — unsubscribe is absolute. */
  optedOutAt: string | null;
  /** Latest sent_at across console_reminders AND lifecycle_emails, or null. */
  lastReminderAt: string | null;
};

export type RemindButtonState =
  | { kind: "hidden" } // nothing to remind (or not a teacher) — no button
  | { kind: "opted_out" } // disabled
  | { kind: "cooldown"; sentAt: string } // disabled — "Sent <date>"
  | { kind: "ready"; segment: RemindSegment };

export function deriveRemindState(f: RemindFacts, now: Date): RemindButtonState {
  if (f.role !== "teacher") return { kind: "hidden" };
  const segment = remindSegment(f.books, f.generationAttempts);
  if (!segment) return { kind: "hidden" };
  if (f.optedOutAt) return { kind: "opted_out" };
  if (f.lastReminderAt && reminderInCooldown(f.lastReminderAt, now)) {
    return { kind: "cooldown", sentAt: f.lastReminderAt };
  }
  return { kind: "ready", segment };
}
