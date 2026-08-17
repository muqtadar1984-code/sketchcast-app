/**
 * Console roster Actions cell — pure state derivation
 * (src/utils/console-actions.ts). The same predicates drive the buttons AND
 * the /api/console/* route refusals, so the rules are pinned here without a
 * database or a clock.
 *
 * Run: npx vitest run src/utils/__tests__/console-actions.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  REMIND_COOLDOWN_DAYS,
  deriveFeedbackState,
  deriveRemindState,
  isOpenFeedbackRequest,
  lifecycleSegmentFor,
  remindSegment,
  reminderInCooldown,
  reminderRetryAfter,
  type FeedbackRequestFacts,
  type RemindFacts,
} from "@/utils/console-actions";

const NOW = new Date("2026-08-17T12:00:00Z");
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString();
const daysAhead = (n: number) => new Date(NOW.getTime() + n * DAY_MS).toISOString();

function req(over: Partial<FeedbackRequestFacts> = {}): FeedbackRequestFacts {
  return { createdAt: daysAgo(1), snoozedUntil: null, respondedAt: null, ...over };
}

describe("remindSegment", () => {
  it("no books → no_upload", () => {
    expect(remindSegment(0, 0)).toBe("no_upload");
  });

  it("books but zero attempts → no_generation", () => {
    expect(remindSegment(3, 0)).toBe("no_generation");
  });

  it("ANY generation attempt disqualifies — even with zero books", () => {
    // The segments.ts rule: someone we may have failed 23 times must never be
    // nudged. Attempts, not successes.
    expect(remindSegment(3, 1)).toBeNull();
    expect(remindSegment(0, 1)).toBeNull();
  });

  it("maps onto the lifecycle copy vocabulary", () => {
    expect(lifecycleSegmentFor("no_upload")).toBe("no_book");
    expect(lifecycleSegmentFor("no_generation")).toBe("no_generation");
  });
});

describe("reminder cooldown", () => {
  it("retry-after is send + 3 days", () => {
    expect(REMIND_COOLDOWN_DAYS).toBe(3);
    expect(reminderRetryAfter(daysAgo(1)).toISOString()).toBe(daysAhead(2));
  });

  it("blocks inside the window, unblocks at exactly 3 days", () => {
    expect(reminderInCooldown(daysAgo(2.9), NOW)).toBe(true);
    expect(reminderInCooldown(daysAgo(3), NOW)).toBe(false);
    expect(reminderInCooldown(null, NOW)).toBe(false);
  });
});

describe("isOpenFeedbackRequest", () => {
  it("unanswered + never snoozed = open", () => {
    expect(isOpenFeedbackRequest(req(), NOW)).toBe(true);
  });

  it("actively snoozed = still open (a second ask must 409)", () => {
    expect(isOpenFeedbackRequest(req({ snoozedUntil: daysAhead(2) }), NOW)).toBe(true);
  });

  it("lapsed snooze = no longer open", () => {
    expect(isOpenFeedbackRequest(req({ snoozedUntil: daysAgo(1) }), NOW)).toBe(false);
  });

  it("answered = closed, snooze irrelevant", () => {
    expect(isOpenFeedbackRequest(req({ respondedAt: daysAgo(1), snoozedUntil: daysAhead(9) }), NOW)).toBe(false);
  });
});

describe("deriveFeedbackState", () => {
  it("never asked → active Request button", () => {
    expect(deriveFeedbackState([], NOW)).toEqual({ kind: "request" });
  });

  it("open unanswered → Requested (disabled)", () => {
    expect(deriveFeedbackState([req()], NOW)).toEqual({ kind: "requested" });
  });

  it("snoozed → Snoozed until <date> (disabled)", () => {
    const until = daysAhead(3);
    expect(deriveFeedbackState([req({ snoozedUntil: until })], NOW)).toEqual({
      kind: "snoozed",
      until,
    });
  });

  it("answered → Answered ✓, and a NEW request is allowed", () => {
    expect(deriveFeedbackState([req({ respondedAt: daysAgo(1) })], NOW)).toEqual({ kind: "answered" });
  });

  it("a lapsed snooze with no answer reverts to the active Request button", () => {
    expect(deriveFeedbackState([req({ snoozedUntil: daysAgo(1) })], NOW)).toEqual({ kind: "request" });
  });

  it("an open re-ask outranks an old answer", () => {
    const rows = [req({ createdAt: daysAgo(30), respondedAt: daysAgo(29) }), req({ createdAt: daysAgo(1) })];
    expect(deriveFeedbackState(rows, NOW)).toEqual({ kind: "requested" });
    // order-independent
    expect(deriveFeedbackState([...rows].reverse(), NOW)).toEqual({ kind: "requested" });
  });
});

describe("deriveRemindState", () => {
  function facts(over: Partial<RemindFacts> = {}): RemindFacts {
    return {
      role: "teacher",
      books: 0,
      generationAttempts: 0,
      optedOutAt: null,
      lastReminderAt: null,
      ...over,
    };
  }

  it("ready: no books → Remind: upload", () => {
    expect(deriveRemindState(facts(), NOW)).toEqual({ kind: "ready", segment: "no_upload" });
  });

  it("ready: books, no attempts → Remind: generate", () => {
    expect(deriveRemindState(facts({ books: 2 }), NOW)).toEqual({ kind: "ready", segment: "no_generation" });
  });

  it("hidden when they've attempted a generation (nothing to remind)", () => {
    expect(deriveRemindState(facts({ books: 2, generationAttempts: 5 }), NOW)).toEqual({ kind: "hidden" });
  });

  it("hidden for non-teachers — lifecycle mail is teacher-only (0080)", () => {
    expect(deriveRemindState(facts({ role: "student" }), NOW)).toEqual({ kind: "hidden" });
    expect(deriveRemindState(facts({ role: "parent" }), NOW)).toEqual({ kind: "hidden" });
  });

  it("opted out beats cooldown — unsubscribe is absolute", () => {
    expect(
      deriveRemindState(facts({ optedOutAt: daysAgo(10), lastReminderAt: daysAgo(1) }), NOW),
    ).toEqual({ kind: "opted_out" });
  });

  it("cooldown from a MANUAL send within 3 days", () => {
    const sentAt = daysAgo(2);
    expect(deriveRemindState(facts({ lastReminderAt: sentAt }), NOW)).toEqual({
      kind: "cooldown",
      sentAt,
    });
  });

  it("an AUTOMATED lifecycle send also cools down manual — founder's rule", () => {
    // The caller folds lifecycle_emails.sent_at into lastReminderAt; the
    // derivation treats both identically.
    const sentAt = daysAgo(0.5);
    expect(deriveRemindState(facts({ lastReminderAt: sentAt }), NOW)).toEqual({
      kind: "cooldown",
      sentAt,
    });
  });

  it("ready again once the cooldown lapses", () => {
    expect(deriveRemindState(facts({ lastReminderAt: daysAgo(4) }), NOW)).toEqual({
      kind: "ready",
      segment: "no_upload",
    });
  });
});
