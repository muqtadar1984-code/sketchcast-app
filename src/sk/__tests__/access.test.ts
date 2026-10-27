// SK book access — codes are well-formed, check-charactered, unreadable from
// the database; edition codes (SKE) share the check scheme; order numbers are
// normalised and HMACed under their own domain; the access decision orders
// school → subscription → grant, keeps BOOK access permanent while TUTORING is
// a window (0159), respects expiry/revocation, and keeps prepared teaching
// when the live allowance is spent (R3 refinement 4).
import { describe, expect, it } from "vitest";
import {
  allowanceWarning,
  checkChar,
  codeKind,
  consentAllows,
  formatCode,
  generateCode,
  generateEditionCode,
  hmacCode,
  hmacOrderNumber,
  isWellFormedCode,
  isWellFormedOrderNumber,
  normalizeCode,
  normalizeOrderNumber,
  planGrantsSk,
  redeemMessage,
  skAccess,
} from "../access";

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
  it("edition codes carry the SKE prefix with the same check scheme and print SKE-XXXX-XXXX-XXXX-XXXXC", () => {
    const ed = generateEditionCode(fixedRandom);
    expect(ed).toHaveLength(3 + 16 + 1);
    expect(ed.startsWith("SKE")).toBe(true);
    expect(isWellFormedCode(ed, "SKE")).toBe(true);
    expect(isWellFormedCode(ed, "SKB")).toBe(false); // an edition code is not a card
    expect(formatCode(ed)).toMatch(/^SKE-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z*~$=]{5}$/);
    expect(normalizeCode(formatCode(ed).toLowerCase())).toBe(ed);
    expect(codeKind(formatCode(ed))).toBe("edition");
    expect(codeKind(formatCode(generateCode("SKB2", fixedRandom)))).toBe("card");
    expect(codeKind("hello")).toBeNull();
    // the same body under the two prefixes is the same check character but a different HMAC
    const card = generateCode("SKB", fixedRandom);
    expect(card.slice(3)).toBe(ed.slice(3));
    expect(hmacCode(card, "a-secret-of-adequate-length")).not.toBe(hmacCode(ed, "a-secret-of-adequate-length"));
  });
  it("formatCode keeps an explicit prefix length when given one", () => {
    const code = generateCode("SKB2", fixedRandom);
    expect(formatCode(code, 4)).toBe(formatCode(code));
  });
});

describe("order numbers", () => {
  it("normalises an Amazon order number to 123-1234567-1234567 from any spacing and refuses other shapes", () => {
    expect(normalizeOrderNumber("123-1234567-1234567")).toBe("123-1234567-1234567");
    expect(normalizeOrderNumber(" 12312345671234567 ")).toBe("123-1234567-1234567");
    expect(normalizeOrderNumber("123 1234567 1234567")).toBe("123-1234567-1234567");
    expect(isWellFormedOrderNumber("123-1234567-1234567")).toBe(true);
    expect(isWellFormedOrderNumber("1231234567123456")).toBe(false); // 16 digits
    expect(isWellFormedOrderNumber("abc")).toBe(false);
    expect(isWellFormedOrderNumber("")).toBe(false);
  });
  it("HMACs the canonical form under its own domain, never colliding with a code", () => {
    const s = "a-secret-of-adequate-length";
    const a = hmacOrderNumber("123-1234567-1234567", s);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacOrderNumber("12312345671234567", s)).toBe(a);
    expect(hmacOrderNumber("123-1234567-1234568", s)).not.toBe(a);
    expect(hmacCode("12312345671234567", s)).not.toBe(a);
    expect(() => hmacOrderNumber("123-1234567-1234567", "short")).toThrow();
  });
});

const NOW = new Date("2026-11-01T10:00:00Z");
const grant = (over: Partial<Parameters<typeof skAccess>[0]["grants"][number]> = {}) => ({
  product_id: "p1",
  source: "code" as const,
  activated_at: "2026-10-20T00:00:00Z",
  expires_at: null,
  tutor_expires_at: "2026-11-19T00:00:00Z",
  revoked_at: null,
  usage_allowance: null,
  ...over,
});

describe("skAccess", () => {
  it("prefers school, then subscription, then a live grant — the first two grant book AND tutoring", () => {
    const school = skAccess({ productId: "p1", now: NOW, schoolLicence: true, subscriptions: [], grants: [] });
    expect(school).toMatchObject({ book_access: true, tutor_access: true, source: "school", grant_source: null });
    const sub = skAccess({ productId: "p1", now: NOW, subscriptions: [{ plan_key: "homeschool_monthly", active: true, current_period_end: "2026-12-01T00:00:00Z" }], grants: [] });
    expect(sub).toMatchObject({ book_access: true, tutor_access: true, source: "subscription", tutor_expires_at: "2026-12-01T00:00:00Z" });
    const g = skAccess({ productId: "p1", now: NOW, subscriptions: [{ plan_key: "teacher_pro_monthly", active: true, current_period_end: null }], grants: [grant()] });
    expect(g).toMatchObject({ book_access: true, tutor_access: true, source: "grant", grant_source: "code", tutor_expires_at: "2026-11-19T00:00:00Z" }); // plain Pro does not include SK
    expect(skAccess({ productId: "p1", now: NOW, subscriptions: [], grants: [] })).toMatchObject({ book_access: false, tutor_access: false, source: null });
  });
  it("book access is permanent (expires_at NULL) while tutoring ends with the tutor window", () => {
    const d = (g: ReturnType<typeof grant>) => skAccess({ productId: "p1", now: NOW, subscriptions: [], grants: [g] });
    const lapsed = d(grant({ source: "purchase", tutor_expires_at: "2026-10-30T00:00:00Z" }));
    expect(lapsed.book_access).toBe(true);
    expect(lapsed.tutor_access).toBe(false);
    expect(lapsed.grant_source).toBe("purchase");
    expect(lapsed.tutor_expires_at).toBe("2026-10-30T00:00:00Z");
    expect(d(grant({ source: "edition_code", tutor_expires_at: null })).tutor_access).toBe(false); // no window = no tutoring
    expect(d(grant({ source: "edition_code", tutor_expires_at: null })).book_access).toBe(true);
    // a dated book expiry (legacy / explicit) still ends book access
    expect(d(grant({ expires_at: "2026-10-30T00:00:00Z" })).book_access).toBe(false);
    expect(d(grant({ expires_at: "2026-12-30T00:00:00Z" })).book_access).toBe(true);
  });
  it("ignores future, revoked and other-product grants", () => {
    const d = (g: ReturnType<typeof grant>) => skAccess({ productId: "p1", now: NOW, subscriptions: [], grants: [g] });
    expect(d(grant({ activated_at: "2026-11-02T00:00:00Z" })).book_access).toBe(false);
    expect(d(grant({ revoked_at: "2026-10-25T00:00:00Z" })).book_access).toBe(false);
    expect(d(grant({ product_id: "p2" })).book_access).toBe(false);
  });
  it("with several grants, the one whose tutor window reaches furthest decides tutoring", () => {
    const d = skAccess({
      productId: "p1",
      now: NOW,
      subscriptions: [],
      grants: [grant({ source: "code", tutor_expires_at: "2026-10-30T00:00:00Z" }), grant({ source: "purchase", tutor_expires_at: "2026-11-25T00:00:00Z" })],
    });
    expect(d.tutor_access).toBe(true);
    expect(d.grant_source).toBe("purchase");
    expect(d.tutor_expires_at).toBe("2026-11-25T00:00:00Z");
  });
  it("keeps access when the live allowance is spent — only live turns stop — and warns at 75/90 %", () => {
    const base = { productId: "p1", now: NOW, subscriptions: [], grants: [grant({ usage_allowance: { live_turns: 100, generated_segments: 10 } })], allowanceEnforced: true };
    const fresh = skAccess({ ...base, usage: { live_turns: 10, generated_segments: 0 } });
    expect(fresh.tutor_access).toBe(true);
    expect(fresh.allowance_remaining).toEqual({ live_turns: 90, generated_segments: 10 });
    expect(fresh.live_exhausted).toBe(false);
    const spent = skAccess({ ...base, usage: { live_turns: 120, generated_segments: 3 } });
    expect(spent.book_access).toBe(true);
    expect(spent.tutor_access).toBe(true); // prepared teaching continues
    expect(spent.live_exhausted).toBe(true);
    expect(spent.allowance_remaining).toEqual({ live_turns: 0, generated_segments: 7 });
    expect(allowanceWarning(skAccess({ ...base, usage: { live_turns: 76, generated_segments: 0 } }).live_used_fraction)).toBe("75");
    expect(allowanceWarning(skAccess({ ...base, usage: { live_turns: 91, generated_segments: 0 } }).live_used_fraction)).toBe("90");
    expect(allowanceWarning(spent.live_used_fraction)).toBe("exhausted");
  });
  it("does not meter while the allowance flag is off, no allowance is recorded, or the tutor window is closed", () => {
    const off = skAccess({ productId: "p1", now: NOW, subscriptions: [], grants: [grant({ usage_allowance: { live_turns: 1 } })], usage: { live_turns: 99, generated_segments: 0 } });
    expect(off.tutor_access).toBe(true);
    expect(off.allowance_remaining).toBeNull();
    expect(off.live_exhausted).toBe(false);
    const closed = skAccess({ productId: "p1", now: NOW, subscriptions: [], grants: [grant({ tutor_expires_at: "2026-10-30T00:00:00Z", usage_allowance: { live_turns: 100 } })], allowanceEnforced: true, usage: { live_turns: 5, generated_segments: 0 } });
    expect(closed.tutor_access).toBe(false);
    expect(closed.allowance_remaining).toBeNull();
  });
  it("planGrantsSk mirrors the tutor families including homeschool", () => {
    for (const k of ["teacher_pro_plus_annual", "family_monthly", "homeschool_annual", "school_annual"]) expect(planGrantsSk(k)).toBe(true);
    expect(planGrantsSk("teacher_pro_monthly")).toBe(false);
  });
  it("maps every redemption failure to a friendly message, never the raw reason", () => {
    for (const r of ["invalid", "used", "revoked", "rate_limited", "not_your_child", "order_used", "daily_cap", "bad_order", "boom"]) expect(redeemMessage(r)).not.toMatch(/P0001|exception|_/);
    expect(redeemMessage("order_used")).not.toBe(redeemMessage("boom"));
    expect(redeemMessage("daily_cap")).not.toBe(redeemMessage("boom"));
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
