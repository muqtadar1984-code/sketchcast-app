import { describe, expect, it } from "vitest";
import { selectSegment, type UserFacts, type Segment } from "../segments";

const NOW = new Date("2026-09-01T12:00:00Z");
/** Cutoff: only accounts created on/after this are ever emailed. */
const SINCE = new Date("2026-08-12T00:00:00Z");

const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function user(over: Partial<UserFacts> = {}): UserFacts {
  return {
    userId: "u1",
    email: "teacher@example.com",
    createdAt: daysAgo(10),
    optedOutAt: null,
    bookCount: 0,
    oldestBookAt: null,
    generationAttempts: 0,
    alreadySent: [] as Segment[],
    ...over,
  };
}

const pick = (over: Partial<UserFacts> = {}) => selectSegment(user(over), NOW, SINCE);

describe("no_book", () => {
  it("selects a user who registered days ago and uploaded nothing", () => {
    expect(pick({ createdAt: daysAgo(5) })).toBe("no_book");
  });

  it("leaves a brand-new account alone — they may still be mid-session", () => {
    expect(pick({ createdAt: daysAgo(1) })).toBeNull();
  });

  it("fires exactly on the threshold", () => {
    expect(pick({ createdAt: daysAgo(3) })).toBe("no_book");
  });

  it("never sends the same nudge twice", () => {
    expect(pick({ createdAt: daysAgo(30), alreadySent: ["no_book"] })).toBeNull();
  });
});

describe("no_generation", () => {
  it("selects a user with a book who has never tried to generate", () => {
    expect(pick({ bookCount: 1, oldestBookAt: daysAgo(4) })).toBe("no_generation");
  });

  it("times from the BOOK, not from signup", () => {
    // Registered a month ago, uploaded this morning — not stalled.
    expect(
      pick({ createdAt: daysAgo(30), bookCount: 1, oldestBookAt: daysAgo(0.2) }),
    ).toBeNull();
  });

  it("never sends the same nudge twice", () => {
    expect(
      pick({ bookCount: 1, oldestBookAt: daysAgo(9), alreadySent: ["no_generation"] }),
    ).toBeNull();
  });

  it("does not fall back to no_book once they have a book", () => {
    expect(
      pick({ bookCount: 2, oldestBookAt: daysAgo(0.1), alreadySent: [] }),
    ).toBeNull();
  });
});

describe("the guard: anyone who has TRIED is never nudged", () => {
  it("skips a user whose every attempt failed — the 2026-08-10 case", () => {
    // 24 attempts, 1 success, 23 killed by our billing outage and a branding
    // bug. Keying on successes would send "ready to create your first lesson?"
    // to the user we had just failed 23 times.
    expect(
      pick({ bookCount: 1, oldestBookAt: daysAgo(20), generationAttempts: 24 }),
    ).toBeNull();
  });

  it("skips after even a single failed attempt", () => {
    expect(
      pick({ bookCount: 1, oldestBookAt: daysAgo(20), generationAttempts: 1 }),
    ).toBeNull();
  });

  it("outranks the no_book path too", () => {
    expect(pick({ createdAt: daysAgo(30), bookCount: 0, generationAttempts: 3 })).toBeNull();
  });
});

describe("suppression", () => {
  it("honours unsubscribe absolutely", () => {
    expect(pick({ createdAt: daysAgo(30), optedOutAt: daysAgo(1) })).toBeNull();
  });

  it("sends nothing to an account with no email address", () => {
    expect(pick({ createdAt: daysAgo(30), email: null })).toBeNull();
  });
});

describe("the cutoff — existing users were contacted by hand", () => {
  it("never emails an account created before the cutoff", () => {
    expect(selectSegment(user({ createdAt: "2026-08-01T00:00:00Z" }), NOW, SINCE)).toBeNull();
  });

  it("emails an account created after it", () => {
    expect(selectSegment(user({ createdAt: "2026-08-20T00:00:00Z" }), NOW, SINCE)).toBe(
      "no_book",
    );
  });

  it("includes the cutoff instant itself", () => {
    expect(selectSegment(user({ createdAt: SINCE.toISOString() }), NOW, SINCE)).toBe("no_book");
  });
});
