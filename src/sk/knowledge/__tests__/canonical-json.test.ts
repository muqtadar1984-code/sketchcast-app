// SK S7 K1 — the contract's chapter hash must equal Python's byte for byte:
//   sha256(json.dumps({sections, exercises}, sort_keys=True, ensure_ascii=False))
// The reference vector (fixtures/python-json-vector.json) was produced by real
// CPython 3.10 with fixtures/python-json-vector.py: floats (1.0, 1e-05, 1e16,
// -0.0, 1.5e300, 2.50, 1E3), a 20-digit int, "-0", control characters,
// U+007F, U+2028, an emoji, Arabic, and keys that sort differently by code
// point than by UTF-16 unit.
// Run: node node_modules/vitest/vitest.mjs run src/sk/knowledge/__tests__/canonical-json.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chapterContentSha256, compareCodePoints, parseRawJson, pythonDumps, pythonFloatRepr, RawNumber, sha256Hex } from "../canonical-json";

const vector = JSON.parse(readFileSync(path.join(__dirname, "fixtures/python-json-vector.json"), "utf8")) as { raw: string; dumps: string; sha: string };

describe("Python json.dumps(sort_keys=True, ensure_ascii=False), reimplemented", () => {
  it("matches CPython's bytes and sha256 on the reference vector", () => {
    const raw = parseRawJson(vector.raw) as { [k: string]: never };
    expect(pythonDumps({ sections: raw.sections, exercises: raw.exercises })).toBe(vector.dumps);
    expect(chapterContentSha256(raw)).toBe(vector.sha);
    expect(vector.sha).toBe("7a451d293100f6426c3a69d92699083c69e486707225396b9dffc38c4b1d6046");
  });

  it("would get it WRONG with JSON.parse: 1.0 and 1 are not the same to Python", () => {
    const viaJsonParse = JSON.parse(vector.raw);
    expect(sha256Hex(pythonDumps({ sections: viaJsonParse.sections, exercises: viaJsonParse.exercises }))).not.toBe(vector.sha);
  });

  it("prints floats like float.__repr__", () => {
    const cases: [number, string][] = [
      [1, "1.0"], [0.1, "0.1"], [1e-5, "1e-05"], [0.0001, "0.0001"], [1e16, "1e+16"], [1e15, "1000000000000000.0"],
      [1.5e300, "1.5e+300"], [-2.5, "-2.5"], [123.456e-2, "1.23456"], [-0, "-0.0"], [5e-324, "5e-324"], [1.7976931348623157e308, "1.7976931348623157e+308"],
      [12345.678, "12345.678"], [100, "100.0"],
    ];
    for (const [x, py] of cases) expect(pythonFloatRepr(x), String(x)).toBe(py);
  });

  it("keeps integer lexemes exact and folds -0 to 0", () => {
    expect(pythonDumps(new RawNumber("12345678901234567890"))).toBe("12345678901234567890");
    expect(pythonDumps(new RawNumber("-0"))).toBe("0");
    expect(pythonDumps(new RawNumber("1E3"))).toBe("1000.0");
    expect(pythonDumps(new RawNumber("2.50"))).toBe("2.5");
  });

  it("escapes only quote, backslash and C0 controls; ensure_ascii=False keeps the rest raw", () => {
    const s = 'a"b\\c\n\t' + String.fromCharCode(1) + String.fromCharCode(0x7f) + String.fromCharCode(0x2028) + "é😀";
    expect(pythonDumps(s)).toBe('"a\\"b\\\\c\\n\\t\\u0001' + String.fromCharCode(0x7f) + String.fromCharCode(0x2028) + 'é😀"');
    expect(pythonDumps("/")).toBe('"/"');
  });

  it("sorts keys by code point (U+FFFF before an emoji, unlike UTF-16 order)", () => {
    const ffff = String.fromCharCode(0xffff);
    expect(compareCodePoints(ffff, "😀")).toBeLessThan(0);
    expect(ffff.localeCompare("😀") === 0 || ffff < "😀").toBe(false); // JS's < says the opposite
    expect(pythonDumps({ "😀": 1, [ffff]: 2, b: 3, B: 4 })).toBe(`{"B": 4, "b": 3, "${ffff}": 2, "😀": 1}`);
  });

  it("uses Python's separators and empty containers", () => {
    expect(pythonDumps({ a: [], b: {}, c: [1, true, null] })).toBe('{"a": [], "b": {}, "c": [1, true, null]}');
  });

  it("parses strictly", () => {
    expect(() => parseRawJson("{")).toThrow();
    expect(() => parseRawJson('{"a": 1} x')).toThrow(/trailing/);
    expect(() => parseRawJson("[01]")).toThrow();
    expect(parseRawJson('{"a": "\\ud83d\\ude00", "a": 2}')).toEqual({ a: new RawNumber("2") });
  });
});
