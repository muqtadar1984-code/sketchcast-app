// SK S7 K1 — the book-release chapter hash, reimplemented exactly.
//
// The contract (BOOK-RELEASES-CONTRACT-2026-10-30, `integrity.chapter_hash_rule`):
//   content_sha256 = sha256(json.dumps({sections, exercises}, sort_keys=True, ensure_ascii=False))
// computed in Python by the book app. To check it here the bytes must match
// Python's, so this module is a faithful port of CPython's json encoder for
// those arguments:
//   * separators ', ' and ': ' (the defaults when indent is None);
//   * keys sorted by code point (Python str ordering — NOT JS's UTF-16 order);
//   * ensure_ascii=False: only '"', '\\' and U+0000–U+001F are escaped
//     (\n \r \t \b \f by name, the rest as \u00XX in lower-case hex);
//     everything else, U+007F and U+2028/2029 included, is written raw;
//   * numbers as Python re-prints them after json.loads: an integer lexeme is
//     a Python int (exact, any size; "-0" → "0"), anything with '.', 'e' or
//     'E' is a float printed with float.__repr__ ("1.0", "1e-05", "1e+16").
// JSON.parse cannot tell 1 from 1.0, so the hash is computed from the RAW
// bundle text with a parser that keeps each number's lexeme.
// Pure: no I/O, importable from tests and scripts.

import { createHash } from "node:crypto";

/** A JSON number as it was written in the source text. */
export class RawNumber {
  readonly lexeme: string;
  constructor(lexeme: string) {
    this.lexeme = lexeme;
  }
}

export type RawJson = null | boolean | string | RawNumber | RawJson[] | { [key: string]: RawJson };

// ── parser (RFC 8259, numbers kept as lexemes) ─────────────────────────────
export function parseRawJson(text: string): RawJson {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`invalid JSON at ${i}: ${what}`);
  };
  const ws = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const str = (): string => {
    if (text[i] !== '"') fail("expected string");
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const e = text[i + 1];
        i += 2;
        if (e === '"' || e === "\\" || e === "/") out += e;
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16)); // surrogate pairs recombine in the JS string
          i += 4;
        } else fail("bad escape");
        continue;
      }
      if (c < " ") fail("control character in string");
      out += c;
      i++;
    }
  };
  const value = (): RawJson => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: { [key: string]: RawJson } = {};
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const k = str();
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        obj[k] = value(); // a duplicate key: the last one wins, as in Python
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: RawJson[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail("unexpected token");
    i += m![0].length;
    return new RawNumber(m![0]);
  };
  const v = value();
  ws();
  if (i !== text.length) fail("trailing data");
  return v;
}

// ── Python's number printing ───────────────────────────────────────────────
/** float.__repr__ for a finite double (CPython's 'r' format, ADD_DOT_0). */
export function pythonFloatRepr(x: number): string {
  if (!Number.isFinite(x)) throw new Error("JSON has no NaN/Infinity");
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  // toExponential() with no argument gives the shortest round-trip digits,
  // the same digits CPython's repr chooses.
  const [mant, expStr] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const exp = parseInt(expStr, 10);
  const decpt = exp + 1; // position of the decimal point relative to the digits
  if (decpt <= -4 || decpt > 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp);
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${e < 10 ? "0" : ""}${e}`;
  }
  if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

function pythonNumber(lexeme: string): string {
  if (/^-?\d+$/.test(lexeme)) return BigInt(lexeme).toString();
  return pythonFloatRepr(Number(lexeme));
}

// ── Python's string printing (ensure_ascii=False) ─────────────────────────
const NAMED: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

export function pythonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const named = NAMED[ch];
    if (named) out += named;
    else if (ch < " ") out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

/** Python str ordering: by code point, not by UTF-16 unit. */
export function compareCodePoints(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let k = 0; k < n; k++) {
    const d = A[k].codePointAt(0)! - B[k].codePointAt(0)!;
    if (d) return d;
  }
  return A.length - B.length;
}

// ── json.dumps(v, sort_keys=True, ensure_ascii=False) ──────────────────────
/** Accepts a RawJson tree or plain JS values (a plain JS number is printed as
 *  an int when it is an integer, else as a Python float). */
export function pythonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (v instanceof RawNumber) return pythonNumber(v.lexeme);
  if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : pythonFloatRepr(v);
  if (typeof v === "string") return pythonString(v);
  if (Array.isArray(v)) return v.length ? `[${v.map(pythonDumps).join(", ")}]` : "[]";
  if (typeof v === "object") {
    const keys = Object.keys(v as object).sort(compareCodePoints);
    if (!keys.length) return "{}";
    return `{${keys.map((k) => `${pythonString(k)}: ${pythonDumps((v as Record<string, unknown>)[k])}`).join(", ")}}`;
  }
  throw new Error(`cannot encode ${typeof v}`);
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The contract's chapter hash for one chapter of a RAW-parsed bundle. */
export function chapterContentSha256(chapter: { [key: string]: RawJson }): string {
  return sha256Hex(pythonDumps({ sections: chapter.sections ?? null, exercises: chapter.exercises ?? null }));
}
