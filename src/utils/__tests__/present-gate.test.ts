import { describe, it, expect, afterEach } from "vitest";
import { presentAllowed } from "../flags";

// The Present-mode allowlist is the ONLY thing standing between an unreleased,
// half-built classroom surface and every other user of a live app. It is a
// short function, which is exactly the kind that ships untested and then turns
// out to have been open — or shut — the whole time.
//
// Two real incidents are pinned here as tests:
//   * PRESENT_ALLOWED_EMAILS was first set in Vercel to the literal string
//     "true", by analogy with every other FEATURE_* flag in flags.ts. That does
//     not enable the feature for anyone — it allowlists an address called
//     "true" — and nothing anywhere would have said so.
//   * An empty variable is the kill switch. There is no second boolean flag, so
//     if empty ever started meaning "everyone", the feature would be wide open
//     with no other gate to catch it.

const KEY = "PRESENT_ALLOWED_EMAILS";
// A PLACEHOLDER, deliberately not the live allowlisted address. The allowlist is
// a temporary gate — Present mode is being tested on one account before it goes
// to the public — so a test that hardcoded the real value would encode something
// designed to change, in a public repo, for no gain: what is under test is the
// matching logic, and that is identical whichever address it runs on.
const FOUNDER = "founder@example.test";
const CONFIRMED = "2026-01-01T00:00:00Z";

/** A signed-in, email-VERIFIED account. presentAllowed takes the user rather
 *  than a bare address precisely so the verification check cannot be skipped by
 *  a caller that only has a string to hand. */
const asUser = (email: string | null | undefined) => ({ email, email_confirmed_at: CONFIRMED });

afterEach(() => {
  delete process.env[KEY];
});

describe("presentAllowed — the kill switch", () => {
  it("lets NOBODY in when the variable is unset", () => {
    expect(presentAllowed(asUser(FOUNDER))).toBe(false);
  });

  it("lets nobody in when the variable is empty or only separators", () => {
    for (const v of ["", "   ", ",", " , , "]) {
      process.env[KEY] = v;
      expect(presentAllowed(asUser(FOUNDER))).toBe(false);
    }
  });

  it('lets nobody in when the variable was set to "true" like a boolean flag', () => {
    // THE ACTUAL MISTAKE, 2026-08-27. Every other flag in flags.ts is
    // `=== "true"`, so this is the natural thing to type — and it silently
    // allowlists an address nobody has.
    process.env[KEY] = "true";
    expect(presentAllowed(asUser(FOUNDER))).toBe(false);
    expect(presentAllowed(asUser("true"))).toBe(true); // the literal it really allowed
  });
});

describe("presentAllowed — who gets in", () => {
  it("admits exactly the configured address", () => {
    process.env[KEY] = FOUNDER;
    expect(presentAllowed(asUser(FOUNDER))).toBe(true);
  });

  it("keeps every OTHER signed-in account out", () => {
    // The case that matters most: this runs inside a live app full of teachers,
    // students, parents and school admins who are all authenticated.
    process.env[KEY] = FOUNDER;
    for (const other of [
      "someone.else@gmail.com",
      "teacher@school.edu.my",
      "muqtadar.quraishi@sketchcast.app", // even platform staff
      "student01@school.edu.my",
    ]) {
      expect(presentAllowed(asUser(other))).toBe(false);
    }
  });

  it("is case-insensitive on both sides", () => {
    process.env[KEY] = "Founder@EXAMPLE.test";
    expect(presentAllowed(asUser("FOUNDER@example.TEST"))).toBe(true);
  });

  it("tolerates whitespace and a trailing comma around entries", () => {
    process.env[KEY] = "  a@example.com ,  b@example.com , ";
    expect(presentAllowed(asUser("a@example.com"))).toBe(true);
    expect(presentAllowed(asUser("b@example.com"))).toBe(true);
    expect(presentAllowed(asUser("c@example.com"))).toBe(false);
  });

  it("tolerates quotes pasted around the value", () => {
    // A dashboard paste that keeps its quotes is the difference between a probe
    // that runs on the panel and a founder bounced to /dashboard with no reason
    // given. Stripping them cannot widen the list — the value is operator-set.
    for (const v of [`"${FOUNDER}"`, `'${FOUNDER}'`, ` "${FOUNDER}" `]) {
      process.env[KEY] = v;
      expect(presentAllowed(asUser(FOUNDER))).toBe(true);
    }
  });
});

describe("presentAllowed — an unverified address is not an identity", () => {
  it("refuses an allowlisted address whose email was never confirmed", () => {
    // The repo already applies this test wherever an email decides something
    // that matters (auth/callback, the Stripe caller — both binding money to a
    // person). An access gate deserves it at least as much.
    process.env[KEY] = FOUNDER;
    expect(presentAllowed({ email: FOUNDER, email_confirmed_at: null })).toBe(false);
    expect(presentAllowed({ email: FOUNDER })).toBe(false);
  });

  it("admits the same address once it is confirmed", () => {
    process.env[KEY] = FOUNDER;
    expect(presentAllowed({ email: FOUNDER, email_confirmed_at: CONFIRMED })).toBe(true);
  });

  it("refuses a missing user outright", () => {
    process.env[KEY] = FOUNDER;
    expect(presentAllowed(null)).toBe(false);
    expect(presentAllowed(undefined)).toBe(false);
  });
});

describe("presentAllowed — refuses to widen", () => {
  it("rejects a null, undefined or blank email even against a populated list", () => {
    process.env[KEY] = FOUNDER;
    expect(presentAllowed(asUser(null))).toBe(false);
    expect(presentAllowed(asUser(undefined))).toBe(false);
    expect(presentAllowed(asUser(""))).toBe(false);
    expect(presentAllowed(asUser("   "))).toBe(false);
  });

  it("does NOT let a blank list entry match a blank email", () => {
    // `"a@b.com,,"` splits to an empty entry. If that survived the filter, an
    // account with no email on record would be admitted by an empty string
    // matching an empty string.
    process.env[KEY] = `${FOUNDER},,`;
    expect(presentAllowed(asUser(""))).toBe(false);
    expect(presentAllowed(asUser(null))).toBe(false);
  });

  it("does not normalise Gmail plus-tags or dots into a match", () => {
    // Deliberate strictness: these ARE the same Gmail inbox, but treating them
    // as equal would widen an access gate on an assumption about one provider's
    // routing rules. An allowlist should only ever narrow when in doubt.
    process.env[KEY] = FOUNDER;
    expect(presentAllowed(asUser("founder+probe@example.test"))).toBe(false);
    expect(presentAllowed(asUser("foun.der@example.test"))).toBe(false);
  });

  it("does not match on prefix, suffix or substring", () => {
    process.env[KEY] = FOUNDER;
    expect(presentAllowed(asUser("founder@example.test.attacker.invalid"))).toBe(false);
    expect(presentAllowed(asUser("xfounder@example.test"))).toBe(false);
    expect(presentAllowed(asUser("founder@example.tes"))).toBe(false);
  });

  it("never treats a wildcard as a wildcard", () => {
    // If someone reaches for the obvious shape, it must fail CLOSED rather than
    // admit a domain.
    process.env[KEY] = "*@sketchcast.app";
    expect(presentAllowed(asUser("anyone@sketchcast.app"))).toBe(false);
    process.env[KEY] = "*";
    expect(presentAllowed(asUser(FOUNDER))).toBe(false);
  });
});
