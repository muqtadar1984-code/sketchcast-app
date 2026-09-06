/**
 * canonicalKey — the topic catalogue's one normalisation function, against
 * the truth table the worker also runs.
 *
 * The cases live in fixtures/catalogue_key_cases.json, a byte-identical copy
 * of sketchcast/tests/fixtures/catalogue_key_cases.json. Both suites pin the
 * same sha256, so editing one copy alone turns the OTHER repo's suite red —
 * which is the point: an alias the portal files under one key must be the key
 * the harvester looks it up by, or every harvested candidate misses its topic.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-key.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalKey, singularToken } from "../catalogue/key";

const FIXTURE = join(__dirname, "fixtures", "catalogue_key_cases.json");
// Bump ONLY when sketchcast/tests/fixtures/catalogue_key_cases.json is changed
// to match, byte for byte.
const CATALOGUE_KEY_CASES_SHA256 = "599c789783ed0260d4d2f0615186976c2e9e495fe1afd34b1f955f31effe2275";

type Case = { in: string; key: string };
// LF-normalised before hashing: a Windows checkout may rewrite the fixture to
// CRLF (see premium-voice-gate.test.ts for the measurement); the pin proves the
// two repos run the SAME TABLE, not the same line endings.
const raw = Buffer.from(readFileSync(FIXTURE).toString("utf8").replace(/\r\n/g, "\n"), "utf8");
const table = JSON.parse(raw.toString("utf8")) as { _: string; rules: string[]; cases: Case[] };

describe("canonicalKey — the shared truth table", () => {
  it("is the same table the worker runs", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(CATALOGUE_KEY_CASES_SHA256);
    expect(table.cases.length).toBeGreaterThanOrEqual(28);
    expect(table._).toContain("byte-identical");
  });

  it("every case in the table holds", () => {
    for (const c of table.cases) {
      expect({ [c.in]: canonicalKey(c.in) }).toEqual({ [c.in]: c.key });
    }
  });

  it("the table covers the examples the plan names", () => {
    const byIn = new Map(table.cases.map((c) => [c.in, c.key]));
    expect(byIn.get("The Cell")).toBe("cell");
    expect(byIn.get("Cells")).toBe("cell");
    expect(byIn.get("Acids, Bases & Salts")).toBe("acid_base_and_salt");
    expect(byIn.get("Light — Reflection and Refraction")).toBe("light_reflection_and_refraction");
    expect(byIn.get("Newton's Laws")).toBe("newton_s_law");
    expect(byIn.get("7Bs.01")).toBe("7bs_01");
    expect(byIn.get("  ")).toBe("");
    expect(byIn.get("Énergie")).toBe("energie");
    expect(byIn.get("7/Biology")).toBe("7_biology");
    // Arabic input has no [a-z0-9] at all and must come out EMPTY, so a caller
    // can refuse to mint a topic with an empty key rather than a garbage one.
    expect(byIn.get("الخلية")).toBe("");
    for (const edge of ["gases", "glass", "forces", "bases", "physics", "mathematics"]) {
      expect(byIn.has(edge), `edge case ${edge} is in the table`).toBe(true);
    }
  });
});

describe("canonicalKey — properties the table implies", () => {
  it("is idempotent: a key is its own key", () => {
    for (const c of table.cases) {
      expect(canonicalKey(c.key)).toBe(c.key);
    }
  });

  it("only ever emits [a-z0-9_] with no leading, trailing or doubled underscore", () => {
    const inputs = [...table.cases.map((c) => c.in), "___x___", "a--b", "!!!", "Ünïcödé & Co."];
    for (const s of inputs) {
      const k = canonicalKey(s);
      expect(k).toMatch(/^([a-z0-9]+(_[a-z0-9]+)*)?$/);
    }
  });

  it("folds case and whitespace, so 'The  CELL' and 'cell' are one topic", () => {
    expect(canonicalKey("The  CELL")).toBe(canonicalKey("cell"));
    expect(canonicalKey("ACIDS, BASES & SALTS")).toBe(canonicalKey("acid base and salt"));
  });

  it("drops only ONE leading article, and only as a whole token", () => {
    expect(canonicalKey("The A Team")).toBe("a_team");
    expect(canonicalKey("Theory of Evolution")).toBe("theory_of_evolution"); // 'the' inside a word
    expect(canonicalKey("Anatomy")).toBe("anatomy"); // 'an' inside a word
  });

  it("never returns null or throws on odd input", () => {
    expect(canonicalKey(undefined as unknown as string)).toBe("");
    expect(canonicalKey(null as unknown as string)).toBe("");
  });
});

describe("singularToken — the step-6 plural fold", () => {
  it("drops an s after a consonant or an e", () => {
    expect(singularToken("cells")).toBe("cell");
    expect(singularToken("atoms")).toBe("atom");
    expect(singularToken("bases")).toBe("base");
    expect(singularToken("waves")).toBe("wave");
  });

  it("leaves ss, a vowel other than e, short tokens, digits and a lone s alone", () => {
    expect(singularToken("glass")).toBe("glass");
    expect(singularToken("gas")).toBe("gas");
    expect(singularToken("bus")).toBe("bus");
    expect(singularToken("this")).toBe("this");
    expect(singularToken("its")).toBe("its");
    expect(singularToken("7bs")).toBe("7bs");
    expect(singularToken("1990s")).toBe("1990s");
    expect(singularToken("s")).toBe("s");
    expect(singularToken("")).toBe("");
  });
});
