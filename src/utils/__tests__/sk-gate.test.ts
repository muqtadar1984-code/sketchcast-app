import { describe, it, expect, afterEach } from "vitest";
import { skAllowedEmails, skUserAllowed } from "../flags";

// SK_ALLOWED_EMAILS is the restricted-live gate (founder, 2026-10-27): with the
// SK flag on in production, this list is the only thing between the tutor and
// every signed-in user. Two properties matter and are pinned here:
//   * UNSET or EMPTY means "not in force" — the flag and skAccess() decide, so
//     deleting the variable is the release, not a lock-out;
//   * SET means exact, verified-address matching only. It can narrow access,
//     never widen it: a signed-in user off the list is treated like nobody.

const KEY = "SK_ALLOWED_EMAILS";
const TESTER = "tester@example.test"; // a placeholder, never the live address
const CONFIRMED = "2026-01-01T00:00:00Z";
const asUser = (email: string | null | undefined, confirmed: string | null = CONFIRMED) => ({ email, email_confirmed_at: confirmed });

afterEach(() => {
  delete process.env[KEY];
});

describe("skUserAllowed — restricted live", () => {
  it("is not in force when the variable is unset or blank: everyone passes to the next gate", () => {
    expect(skAllowedEmails()).toEqual([]);
    expect(skUserAllowed(null)).toBe(true);
    expect(skUserAllowed(asUser("anyone@example.test"))).toBe(true);
    process.env[KEY] = "  , ,";
    expect(skUserAllowed(asUser("anyone@example.test"))).toBe(true);
  });

  it("when set, admits only a verified address on the list", () => {
    process.env[KEY] = TESTER;
    expect(skUserAllowed(asUser(TESTER))).toBe(true);
    expect(skUserAllowed(asUser("someone-else@example.test"))).toBe(false);
    expect(skUserAllowed(null)).toBe(false); // anonymous ⇒ 404, not 401
    expect(skUserAllowed(undefined)).toBe(false);
    expect(skUserAllowed(asUser(TESTER, null))).toBe(false); // unverified address is not an identity
  });

  it("trims, lower-cases and strips pasted quotes; matches exactly otherwise", () => {
    process.env[KEY] = ` "${TESTER.toUpperCase()}" , second@example.test `;
    expect(skAllowedEmails()).toEqual([TESTER, "second@example.test"]);
    expect(skUserAllowed(asUser(` ${TESTER} `))).toBe(true);
    expect(skUserAllowed(asUser("second@example.test"))).toBe(true);
    expect(skUserAllowed(asUser("tester+tag@example.test"))).toBe(false); // no plus/dot normalisation
    expect(skUserAllowed(asUser(""))).toBe(false);
  });

  it("the literal 'true' allow-lists nobody real (it is a list, not a flag)", () => {
    process.env[KEY] = "true";
    expect(skUserAllowed(asUser(TESTER))).toBe(false);
  });
});
