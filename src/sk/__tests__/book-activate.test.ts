/**
 * S4 slice D — the pure half of book activation (src/sk/book-activate.ts):
 * the /activate child picker, picking a child by name, code FORMAT checks
 * (incl. batch-prefixed code cards), masking, finding a code in an utterance
 * without mistaking words for codes, and the form's refusal keys.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/book-activate.test.ts
 */
import { describe, expect, it } from "vitest";
import { formatCode, generateCode, generateEditionCode } from "@/sk/codes";
import {
  activateErrorKey,
  bookCodeKind,
  childPicker,
  findBookCode,
  findOrderNumber,
  forChildFor,
  maskBookSecrets,
  maskBookSecretsDeep,
  maskCode,
  maskOrderNumber,
  pickChild,
  verifiedChildrenFrom,
} from "@/sk/book-activate";

const P = "11111111-1111-4111-8111-111111111111";
const A = "a6000000-0000-4000-8000-000000000016";
const O = "a7000000-0000-4000-8000-000000000017";
const X = "a8000000-0000-4000-8000-000000000018";
const rnd = (seed: number) => (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * seed + 11) & 0xff));
const EDITION = generateEditionCode(rnd(37));
const CARD = generateCode("SKB2", rnd(41));
const AISYAH = { id: A, name: "Aisyah binti Ali" };
const OMAR = { id: O, name: "Omar Hakim" };

describe("verified children (parent_links rows)", () => {
  it("keeps only THIS parent's VERIFIED links, named, sorted, de-duplicated", () => {
    const rows = [
      { parent_id: P, child_id: O, verified_at: "2026-10-01", profiles: { full_name: "Omar Hakim" } },
      { parent_id: P, child_id: A, verified_at: "2026-10-01", profiles: [{ full_name: null, username: "Aisyah binti Ali" }] },
      { parent_id: P, child_id: A, verified_at: "2026-10-02", profiles: { full_name: "Aisyah binti Ali" } },
      { parent_id: P, child_id: X, verified_at: null, profiles: { full_name: "Unverified" } },
      { parent_id: "someone-else", child_id: X, verified_at: "2026-10-01", profiles: { full_name: "Not mine" } },
      { parent_id: P, child_id: "not-a-uuid", verified_at: "2026-10-01" },
    ];
    expect(verifiedChildrenFrom(rows, P)).toEqual([AISYAH, OMAR]);
    expect(verifiedChildrenFrom(null, P)).toEqual([]);
  });
});

describe("the /activate child picker", () => {
  it("one child → preselected; two → required, no default; none → for me (a parent gets the note)", () => {
    expect(childPicker("parent", [AISYAH])).toEqual({ mode: "one", child: AISYAH, children: [AISYAH] });
    expect(childPicker("parent", [AISYAH, OMAR])).toEqual({ mode: "pick", children: [AISYAH, OMAR] });
    expect(childPicker("parent", [])).toEqual({ mode: "self_note" });
  });
  it("students and teachers are unchanged (no picker)", () => {
    expect(childPicker("student", [AISYAH])).toEqual({ mode: "self" });
    expect(childPicker("teacher", [])).toEqual({ mode: "self" });
    expect(childPicker(null, [])).toEqual({ mode: "self" });
  });
  it("what the form submits: the child, or null for me, or undefined = must choose first", () => {
    expect(forChildFor(childPicker("parent", [AISYAH]), "")).toBe(A);
    const two = childPicker("parent", [AISYAH, OMAR]);
    expect(forChildFor(two, "")).toBeUndefined();
    expect(forChildFor(two, X)).toBeUndefined(); // not one of hers
    expect(forChildFor(two, O)).toBe(O);
    expect(forChildFor(childPicker("parent", []), "")).toBeNull();
    expect(forChildFor(childPicker("student", []), A)).toBeNull();
  });
});

describe("pickChild (SK: which child?)", () => {
  const kids = [AISYAH, OMAR];
  it("no name: one child → that child; two → ask; none linked → self", () => {
    expect(pickChild([AISYAH], {})).toEqual({ kind: "one", child: AISYAH });
    expect(pickChild(kids, {})).toEqual({ kind: "many", options: kids });
    expect(pickChild([], {})).toEqual({ kind: "self" });
  });
  it("matches a whole name, a first name, a prefix, case and accents folded", () => {
    expect(pickChild(kids, { childQuery: "aisyah" })).toEqual({ kind: "one", child: AISYAH });
    expect(pickChild(kids, { childQuery: "Omar Hakim" })).toEqual({ kind: "one", child: OMAR });
    expect(pickChild(kids, { childQuery: "Ais" })).toEqual({ kind: "one", child: AISYAH });
    expect(pickChild(kids, { childQuery: "Aisyah's" })).toEqual({ kind: "one", child: AISYAH });
  });
  it("an unknown name or a foreign id is none — never a guess", () => {
    expect(pickChild(kids, { childQuery: "Zara" })).toEqual({ kind: "none", query: "Zara" });
    expect(pickChild(kids, { childId: X })).toEqual({ kind: "none", query: X });
    expect(pickChild([], { childQuery: "Aisyah" })).toEqual({ kind: "none", query: "Aisyah" });
  });
});

describe("code format", () => {
  it("edition codes (SKE) and batch-prefixed code cards (SKB, SKB2…) are recognised; typos are not", () => {
    expect(bookCodeKind(EDITION)).toBe("edition");
    expect(bookCodeKind(formatCode(EDITION).toLowerCase())).toBe("edition");
    expect(bookCodeKind(CARD)).toBe("card");
    expect(bookCodeKind(formatCode(CARD))).toBe("card");
    expect(bookCodeKind(generateCode("SKB", rnd(43)))).toBe("card");
    const typo = EDITION.slice(0, -1) + (EDITION.endsWith("0") ? "1" : "0");
    expect(bookCodeKind(typo)).toBeNull();
    expect(bookCodeKind("SKE-TOO-SHORT")).toBeNull();
    expect(bookCodeKind("XYZ" + EDITION.slice(3))).toBeNull();
  });
  it("masks all but the prefix and the last 4", () => {
    const m = maskCode(EDITION);
    expect(m.startsWith("SKE-••••-••••-••••-•")).toBe(true);
    expect(m.endsWith(EDITION.slice(-4))).toBe(true);
    expect(m.replace(/[^0-9A-Z*~$=]/g, "")).toBe("SKE" + EDITION.slice(-4)); // the check character may be * ~ $ =
    expect(maskCode(CARD).startsWith("SKB2-••••")).toBe(true);
    expect(maskOrderNumber("12312345674567890")).toBe("•••-•••••••-•••7890");
  });
});

describe("finding a code in what someone said", () => {
  it("finds the printed form, the bare form and a code split into blocks", () => {
    expect(findBookCode(`activate my book code ${formatCode(EDITION)} for Aisyah`)).toMatchObject({ code: EDITION, kind: "edition" });
    expect(findBookCode(`kod saya ${EDITION.toLowerCase()}.`)).toMatchObject({ code: EDITION, kind: "edition" });
    expect(findBookCode(`فعّل الكود ${formatCode(CARD).split("-").join(" ")}`)).toMatchObject({ code: CARD, kind: "card" });
  });
  it("a code-looking token that fails its check character is still a (bad) code", () => {
    const typo = formatCode(EDITION).slice(0, -1) + (EDITION.endsWith("0") ? "1" : "0");
    expect(findBookCode(`activate ${typo}`)).toMatchObject({ kind: null });
  });
  it("words are not codes", () => {
    expect(findBookCode("what does a skeleton do")).toBeNull();
    expect(findBookCode("skeletal muscles and sketches")).toBeNull();
    expect(findBookCode("I have a code")).toBeNull();
  });
  it("finds an order number with or without dashes", () => {
    expect(findOrderNumber("order 123-1234567-1234567")).toBe("123-1234567-1234567");
    expect(findOrderNumber("12312345671234567")).toBe("123-1234567-1234567");
    expect(findOrderNumber("call 0123456789")).toBeNull();
  });
  it("masks codes and order numbers in text and in args objects", () => {
    const text = `activate ${formatCode(EDITION)} order 123-1234567-1234567 for Aisyah`;
    const masked = maskBookSecrets(text);
    expect(masked).not.toContain(formatCode(EDITION));
    expect(masked.replace(/[^0-9A-Z]/g, "")).not.toContain(EDITION.slice(3, 15));
    expect(masked).not.toContain("1234567-1234567");
    expect(masked).toContain("for Aisyah");
    expect(maskBookSecrets("what does a skeleton do")).toBe("what does a skeleton do");
    const deep = maskBookSecretsDeep({ code: EDITION, orderNumber: "123-1234567-1234567", n: 3, nested: [formatCode(CARD)] });
    expect(JSON.stringify(deep)).not.toContain(EDITION);
    expect(JSON.stringify(deep)).not.toContain(formatCode(CARD));
    expect(deep.n).toBe(3);
  });
});

describe("the form's refusal keys", () => {
  it("maps every route reason, then falls back on the status", () => {
    expect(activateErrorKey("not_your_child")).toBe("notYourChild");
    expect(activateErrorKey("rate_limited")).toBe("rateLimited");
    expect(activateErrorKey("used")).toBe("used");
    expect(activateErrorKey("order_used")).toBe("orderUsed");
    expect(activateErrorKey("daily_cap")).toBe("dailyCap");
    expect(activateErrorKey("bad_order")).toBe("badOrder");
    expect(activateErrorKey("revoked")).toBe("revoked");
    expect(activateErrorKey("invalid")).toBe("invalid");
    expect(activateErrorKey(undefined, 503)).toBe("notConfigured");
    expect(activateErrorKey("boom", 500)).toBe("generic");
  });
});
