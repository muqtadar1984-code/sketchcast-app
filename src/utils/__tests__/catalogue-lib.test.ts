/**
 * The /api/library route plumbing that is pure enough to unit-test without a
 * database: the body readers in src/app/api/library/lib.ts.
 *
 * uuid() must LOWER-CASE: some ids it admits are compared as text — the derive
 * route's live check and the jobs_one_live_derive index both key on
 * params->>'curriculum_id' — so "ABCDEF12-…" and "abcdef12-…" must be the same
 * curriculum, not a way to run two derives at once.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-lib.test.ts
 */
import { describe, expect, it } from "vitest";
import { IN_CHUNK, text, uuid, uuidList } from "@/app/api/library/lib";

const LOWER = "0f9b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const UPPER = "0F9B1C2D-3E4F-4A5B-8C6D-7E8F9A0B1C2D";
const MIXED = "0f9B1c2D-3E4f-4a5B-8c6D-7e8F9a0B1c2D";

describe("uuid() — one spelling per id", () => {
  it("accepts a well-formed uuid and returns it trimmed", () => {
    expect(uuid(LOWER)).toBe(LOWER);
    expect(uuid(`  ${LOWER}\n`)).toBe(LOWER);
  });

  it("lower-cases a case-variant so text comparisons see the same id", () => {
    expect(uuid(UPPER)).toBe(LOWER);
    expect(uuid(MIXED)).toBe(LOWER);
    expect(uuid(` ${UPPER} `)).toBe(LOWER);
  });

  it("refuses anything that is not a uuid", () => {
    for (const bad of [null, undefined, 42, {}, [], "", "not-a-uuid", LOWER.slice(1), `${LOWER}0`, LOWER.replace("-", "")]) {
      expect(uuid(bad), String(bad)).toBeNull();
    }
  });
});

describe("uuidList() — a body field of ids", () => {
  it("normalises each entry the way uuid() does and drops duplicates that only differ by case", () => {
    expect(uuidList([UPPER, LOWER, MIXED])).toEqual({ ids: [LOWER] });
  });

  it("is null when absent, invalid for a non-array or a non-uuid entry", () => {
    expect(uuidList(undefined)).toBeNull();
    expect(uuidList(null)).toBeNull();
    expect(uuidList("x")).toEqual({ invalid: true });
    expect(uuidList([LOWER, "nope"])).toEqual({ invalid: true });
  });
});

describe("the small readers", () => {
  it("text() trims and caps, and is empty for a non-string", () => {
    expect(text("  Biology  ", 60)).toBe("Biology");
    expect(text("abcdef", 3)).toBe("abc");
    expect(text(12, 60)).toBe("");
  });

  it("IN_CHUNK is the 150-id `.in()` chunk the candidates page uses", () => {
    expect(IN_CHUNK).toBe(150);
  });
});
