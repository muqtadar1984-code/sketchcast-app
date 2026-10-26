// SK book access — codes are well-formed, check-charactered, unreadable from
// the database; the access decision orders school → subscription → grant,
// respects expiry/revocation, and keeps prepared teaching when the live
// allowance is spent (R3 refinement 4).
import { describe, expect, it } from "vitest";
import { allowanceWarning, checkChar, consentAllows, formatCode, generateCode, hmacCode, isWellFormedCode, normalizeCode, planGrantsSk, redeemMessage, skAccess } from "../access";

const fixedRandom = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));

describe("codes", () => {
  it("generates a prefixed 16-char body + check char that validates and prints in blocks", () => {
    const code = generateCode("SKB2", fixedRandom);
    expect(code).toHaveLength(4 + 16 + 1);
    expect(isWellFormedCode(code, "SKB2")).toBe(true);
    expect(formatCode(code)).toMatch(/^SKB2-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z*~$=]{5}$/);
    // Deterministic for a fixed random source, different for different bytes.
    expect(generateCode("SKB2", fixedRandom)).toBe(code);
    expect(generateCode("SKB2", (n) => new Uint8Array(n))).not.toBe(code);
  });
  it("accepts what a person types (dashes, lowercase, O for 0, I/L for 1) and rejects a wrong check character", () => {
    const code = generateCode("SKB2", fixedRandom);
    const typed = formatCode(code).toLowerCase().replace(/0/g, "o").replace(/1/g, "l");
    expect(normalizeCode(typed)).toBe(code);
    expect(isWellFormedCode(typed, "SKB2")).toBe(true);
    const body = code.slice(4, 20);
    const wrong = code.slice(0, 20) + (checkChar(body) === "0" ? "1" : "0");
    expect(isWellFormedCode(wrong, "SKB2")).toBe(false);
    expect(isWellFormedCode("SKB2-TOO-SHORT", "SKB2")).toBe(false);
  });
  it("stores only an HMAC, stable for the same code and secret, refusing a weak secret", () => {
    const code = generateCode("SKB2", fixedRandom);
    const a = hmacCode(code, "a-secret-of-adequate-length");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacCode(formatCode(code).toLowerCase(), "a-secret-of-adequate-length")).toBe(a); // typed form folds to the same HMAC
    expect(hmacCode(code, "another-secret-of-adequate-len")).not.toBe(a);
    expect(() => hmacCode(code, "short")).toThrow();
  });
});

const NOW = new Date("2026-11-01T10:00:00Z");
const grant = (over: Partial<Parameters<typeof skAccess>[0]["grants"][number]> = {}) => ({
  product_id: "p1",
  activated_at: "2026-10-20T00:00:00Z",
  expires_at: "2026-11-19T00:00:00Z",
  revoked_at: null,
  usage_allowance: null,
  ...over,
});

describe("skAccess", () => {
  it("prefers school, then subscription, then a live grant", () => {
    expect(skAccess({ productId: "p1", now: NOW, schoolLicence: true, subscriptions: [], grants: [] }).source).toBe("school");
    expect(skAccess({ productId: "p1", now: NOW, subscriptions: [{ plan_key: "homeschool_monthly", active: true, current_period_end: "2026-12-01T00:00:00Z" }], grants: [] }).source).toBe("subscription");
    expect(skAccess({ productId: "p1", now: NOW, subscriptions: [{ plan_key: "teacher_pro_monthly", active: true, current_period_end: null }], grants: [grant()] }).source).toBe("grant"); // plain Pro does not include SK
    expect(skAccess({ productId: "p1", now: NOW, subscriptions: [], grants: [] }).allowed).toBe(false);
  });
  it("ignores expired, future, revoked and other-product grants", () => {
    const d = (g: ReturnType<typeof grant>) => skAccess({ productId: "p1", now: NOW, subscriptions: [], grants: [g] });
    expect(d(grant({ expires_at: "2026-10-30T00:00:00Z" })).allowed).toBe(false);
    expect(d(grant({ activated_at: "2026-11-02T00:00:00Z" })).allowed).toBe(false);
    expect(d(grant({ revoked_at: "2026-10-25T00:00:00Z" })).allowed).toBe(false);
    expect(d(grant({ product_id: "p2" })).allowed).toBe(false);
    expect(d(grant()).expiresAt).toBe("2026-11-19T00:00:00Z");
  });
  it("keeps access when the live allowance is spent — only live turns stop — and warns at 75/90 %", () => {
    const base = { productId: "p1", now: NOW, subscriptions: [], grants: [grant({ usage_allowance: { live_turns: 100, generated_segments: 10 } })], allowanceEnforced: true };
    const fresh = skAccess({ ...base, usage: { live_turns: 10, generated_segments: 0 } });
    expect(fresh.allowed).toBe(true);
    expect(fresh.allowanceRemaining).toEqual({ live_turns: 90, generated_segments: 10 });
    expect(fresh.liveExhausted).toBe(false);
    const spent = skAccess({ ...base, usage: { live_turns: 120, generated_segments: 3 } });
    expect(spent.allowed).toBe(true); // prepared teaching continues
    expect(spent.liveExhausted).toBe(true);
    expect(spent.allowanceRemaining).toEqual({ live_turns: 0, generated_segments: 7 });
    expect(allowanceWarning(skAccess({ ...base, usage: { live_turns: 76, generated_segments: 0 } }).liveUsedFraction)).toBe("75");
    expect(allowanceWarning(skAccess({ ...base, usage: { live_turns: 91, generated_segments: 0 } }).liveUsedFraction)).toBe("90");
    expect(allowanceWarning(spent.liveUsedFraction)).toBe("exhausted");
  });
  it("does not meter while the allowance flag is off or no allowance is recorded", () => {
    const off = skAccess({ productId: "p1", now: NOW, subscriptions: [], grants: [grant({ usage_allowance: { live_turns: 1 } })], usage: { live_turns: 99, generated_segments: 0 } });
    expect(off.allowed).toBe(true);
    expect(off.allowanceRemaining).toBeNull();
    expect(off.liveExhausted).toBe(false);
  });
  it("planGrantsSk mirrors the tutor families including homeschool", () => {
    for (const k of ["teacher_pro_plus_annual", "family_monthly", "homeschool_annual", "school_annual"]) expect(planGrantsSk(k)).toBe(true);
    expect(planGrantsSk("teacher_pro_monthly")).toBe(false);
  });
  it("maps every redemption failure to a friendly message, never the raw reason", () => {
    for (const r of ["invalid", "used", "revoked", "rate_limited", "not_your_child", "boom"]) expect(redeemMessage(r)).not.toMatch(/P0001|exception|_/);
  });
});

describe("consent", () => {
  it("requires a live guardian consent for a student's voice, none for adults", () => {
    expect(consentAllows("voice", "student", [])).toBe(false);
    expect(consentAllows("voice", "student", [{ scope: "voice", revoked_at: "2026-10-01T00:00:00Z" }])).toBe(false);
    expect(consentAllows("voice", "student", [{ scope: "analytics", revoked_at: null }])).toBe(false);
    expect(consentAllows("voice", "student", [{ scope: "voice", revoked_at: null }])).toBe(true);
    for (const role of ["teacher", "parent", "school_admin", "coordinator", null]) expect(consentAllows("voice", role, [])).toBe(true);
  });
});
