/**
 * The premium-voice gate, against the truth table the worker also runs.
 *
 * Founder decision 2026-09-05: premium voices go to paid plans and to comp
 * overrides of 100000 or more — NOT to every comp override, which is what both
 * gates asked for before migration 0105. On prod the difference was 18 accounts
 * versus 7.
 *
 * The cases live in fixtures/premium-voice-cases.json, a byte-identical copy of
 * sketchcast/tests/fixtures/premium_voice_cases.json. Both suites pin the same
 * sha256, so editing one copy alone turns the OTHER repo's suite red — which is
 * the point: the app must never offer a voice the worker will refuse.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { PAID_VOICE_TIERS, premiumVoicesFor } from "../narration";

const FIXTURE = join(__dirname, "fixtures", "premium-voice-cases.json");
// Bump ONLY when sketchcast/tests/fixtures/premium_voice_cases.json is changed
// to match, byte for byte.
const PREMIUM_VOICE_CASES_SHA256 =
  "403e9119f81e9f67771dc36b7dcf287c24bec2a5c7d4e0efcdad51a69d22cad3";

type Case = {
  name: string;
  max_books: number | null;
  max_chapters: number | null;
  tier: string;
  db_premium: boolean;
  unlimited: boolean;
  expect_premium: boolean;
};
const raw = readFileSync(FIXTURE);
const table = JSON.parse(raw.toString("utf8")) as {
  threshold: number;
  paid_tiers: string[];
  cases: Case[];
};

describe("premium voices — the shared truth table", () => {
  it("is the same table the worker runs", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(PREMIUM_VOICE_CASES_SHA256);
    expect(table.cases.length).toBeGreaterThanOrEqual(15);
  });

  it("the fixture's own db_premium column IS the rule: big override OR paid tier", () => {
    // Pins what migration 0105's premium_voices_allowed() must compute, so the
    // table can never quietly encode a different rule than the SQL.
    for (const c of table.cases) {
      const big = Math.max(c.max_books ?? 0, c.max_chapters ?? 0) >= table.threshold;
      expect({ [c.name]: c.db_premium }).toEqual({
        [c.name]: big || table.paid_tiers.includes(c.tier),
      });
      expect({ [c.name]: c.expect_premium }).toEqual({ [c.name]: c.db_premium });
    }
  });

  it("the app's paid allow-list is the fixture's, which is the worker's PAID_TIERS", () => {
    expect([...PAID_VOICE_TIERS].sort()).toEqual([...table.paid_tiers].sort());
  });

  it("with the database's answer present, premiumVoicesFor IS that answer", () => {
    for (const c of table.cases) {
      const fu = { tier: c.tier, unlimited: c.unlimited, premium_voices: c.db_premium };
      expect({ [c.name]: premiumVoicesFor(fu) }).toEqual({ [c.name]: c.expect_premium });
    }
  });

  it("a 100000 override gets premium; a 20-book override does NOT, and keeps unlimited", () => {
    const big = table.cases.find((c) => c.max_books === 100000)!;
    const small = table.cases.find((c) => c.max_books === 20)!;
    expect(premiumVoicesFor({ tier: big.tier, unlimited: true, premium_voices: true })).toBe(true);
    expect(premiumVoicesFor({ tier: small.tier, unlimited: true, premium_voices: false })).toBe(false);
    // `unlimited` still means unlimited GENERATION for both — 0105 does not
    // touch it, and the small-override accounts must not lose their caps.
    expect(big.unlimited).toBe(true);
    expect(small.unlimited).toBe(true);
  });
});

describe("premium voices — an un-migrated database degrades to PAID TIERS ONLY", () => {
  // The window between this deploy and the founder applying 0105: my_fair_use()
  // still returns no `premium_voices` key.
  it("falls back to the paid tiers, never to `unlimited`", () => {
    for (const c of table.cases) {
      const fu = { tier: c.tier, unlimited: c.unlimited }; // no premium_voices
      expect({ [c.name]: premiumVoicesFor(fu) }).toEqual({
        [c.name]: table.paid_tiers.includes(c.tier),
      });
    }
  });

  it("the over-grant we are removing cannot come back through the fallback", () => {
    // This is the regression that matters: before 0105 this returned true, and
    // it is why 11 seeded 20-book accounts would have been handed premium.
    expect(premiumVoicesFor({ tier: "unlimited", unlimited: true })).toBe(false);
    expect(premiumVoicesFor({ tier: "trial", unlimited: true })).toBe(false);
  });

  it("an explicit false from the database still wins over any tier fallback", () => {
    expect(premiumVoicesFor({ tier: "pro", premium_voices: false })).toBe(false);
    expect(premiumVoicesFor({ tier: "trial", premium_voices: true })).toBe(true);
  });

  it("no fair-use payload at all is never premium", () => {
    expect(premiumVoicesFor(null)).toBe(false);
    expect(premiumVoicesFor(undefined)).toBe(false);
    expect(premiumVoicesFor({})).toBe(false);
  });
});
