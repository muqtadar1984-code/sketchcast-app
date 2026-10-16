import { describe, expect, it } from "vitest";
import { fillBlankCorrect, numericEqual, parseNumeric } from "../numeric";

describe("parseNumeric", () => {
  it("reads numbers, fractions, π-expressions and units", () => {
    expect(parseNumeric("44")).toEqual({ value: 44, pi: false, unit: null });
    expect(parseNumeric("9π")).toEqual({ value: 9, pi: true, unit: null });
    expect(parseNumeric("9 pi cm²")).toEqual({ value: 9, pi: true, unit: "cm²" });
    expect(parseNumeric("9π cm^2")).toEqual({ value: 9, pi: true, unit: "cm²" });
    expect(parseNumeric("π")).toEqual({ value: 1, pi: true, unit: null });
    expect(parseNumeric("22/7")?.value).toBeCloseTo(22 / 7, 12);
    expect(parseNumeric("9π/2")).toEqual({ value: 4.5, pi: true, unit: null });
    expect(parseNumeric("−3")).toEqual({ value: -3, pi: false, unit: null });
    expect(parseNumeric("x = 3")).toEqual({ value: 3, pi: false, unit: null });
    expect(parseNumeric("45°")).toEqual({ value: 45, pi: false, unit: "°" });
    expect(parseNumeric("12 %")).toEqual({ value: 12, pi: false, unit: "%" });
    expect(parseNumeric("1,000 m")).toEqual({ value: 1000, pi: false, unit: "m" });
    expect(parseNumeric("3,5")).toEqual({ value: 3.5, pi: false, unit: null });
    expect(parseNumeric("2 × π")).toEqual({ value: 2, pi: true, unit: null });
  });

  it("refuses prose, units alone, blanks and division by zero", () => {
    for (const s of ["chlorophyll", "cm", "", "  ", "two", "3 cats and a dog", "1/0", "pi pi", null, undefined, "e"]) {
      expect(parseNumeric(s), String(s)).toBeNull();
    }
  });
});

describe("numericEqual", () => {
  const n = (s: string) => parseNumeric(s)!;
  it("compares values to a relative 1e-9, requires the same π-ness, forgives a missing unit", () => {
    expect(numericEqual(n("56.520"), n("56.52"))).toBe(true);
    expect(numericEqual(n("3.142857142857143"), n("22/7"))).toBe(true);
    expect(numericEqual(n("44"), n("44 cm"))).toBe(true);
    expect(numericEqual(n("44 m"), n("44 cm"))).toBe(false);
    expect(numericEqual(n("9"), n("9π"))).toBe(false);
    expect(numericEqual(n("28.27"), n("9π"))).toBe(false);
    expect(numericEqual(n("1000"), n("1,000"))).toBe(true);
  });
});

describe("fillBlankCorrect", () => {
  it("is the exact rule first, the numeric rule second, and never scores a blank", () => {
    expect(fillBlankCorrect("Chlorophyll", undefined, " chlorophyll ")).toBe(true);
    expect(fillBlankCorrect("Chlorophyll", undefined, "chlorophyl")).toBe(false);
    expect(fillBlankCorrect("9π", undefined, "9pi")).toBe(true);
    expect(fillBlankCorrect("adenosine triphosphate", ["ATP"], "atp")).toBe(true);
    expect(fillBlankCorrect("adenosine triphosphate", ["9π"], "9 pi")).toBe(true);
    expect(fillBlankCorrect("44", undefined, "")).toBe(false);
    expect(fillBlankCorrect("44", undefined, undefined)).toBe(false);
    expect(fillBlankCorrect(undefined, undefined, "44")).toBe(false);
  });
});
