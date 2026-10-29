/**
 * SK S3 slice C — the remediation ladder, pure (src/sk/remediation.ts) over
 * REAL production bank rows (./remediation-fixtures.ts): the rung order, the
 * answer never leaking before the reveal (exact text, key, and ≥ 60 %
 * content-word overlap), rung 1 naming the misconception WITHOUT its
 * correction, slide(k), the check question (a different item on the same
 * objective), non-mcq items, and the replay of the ladder state that gives
 * each attempt its hints_used.
 */
import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS } from "../grade";
import { factsFrom } from "../remediation-bank";
import { chosenKeyOf, contentOverlap, hintRung, ladderHistory, leaks, mentionsKey, misconceptionRung, OVERLAP_LIMIT, redact, remediation, stem, verificationItem, type RemediationFacts, type RungNo } from "../remediation";
import { CH5_ARTICLE_ROW, CH5_BANK_ROWS, ch5Manifest, GENES_MCQ, O2_KEY, RBC_AR, RBC_FILL, RBC_MCQ, RBC_SHORT, UNMAPPED_ITEM } from "./remediation-fixtures";

const row = (id: string) => CH5_BANK_ROWS.find((r) => r.id === id)! as unknown as Record<string, unknown>;
const facts = (id: string): RemediationFacts => factsFrom(row(id), row(id).article_id ? (CH5_ARTICLE_ROW as unknown as Record<string, unknown>) : null)!;
const M2_CORRECTION = "Mature mammalian red blood cells have no nucleus. This leaves room for haemoglobin, and haemoglobin is what makes them red.";
const RBC_EXPLANATION = "Losing the nucleus frees internal space so more haemoglobin fits, and each cell carries more oxygen.";

describe("facts from the bank row", () => {
  it("reads keys, the answer, the rationale, the misconceptions and the objective key", () => {
    const f = facts(RBC_MCQ);
    expect(f).toMatchObject({ type: "mcq", answerKey: "B", answerTexts: ["More space is available for haemoglobin."], answerDisplay: "B. More space is available for haemoglobin.", objectiveKey: O2_KEY, rightRationale: null });
    expect(f.rationale.A).toEqual({ why_wrong: "Believes the nucleus is involved in making the cell red, when haemoglobin gives the colour.", misconception_ref: "m2" });
    expect(f.misconceptions.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(facts(UNMAPPED_ITEM).objectiveKey).toBeNull();
  });
  it("reads a note on the right option as its rationale (never a why_wrong)", () => {
    const r = { ...row(RBC_MCQ), distractor_rationale: { ...(row(RBC_MCQ).distractor_rationale as object), B: { why_right: "Without a nucleus the cell has extra room inside." } } };
    expect(factsFrom(r, CH5_ARTICLE_ROW as unknown as Record<string, unknown>)!.rightRationale).toBe("Without a nucleus the cell has extra room inside.");
  });
  it("maps a response to the option key (text or letter)", () => {
    const f = facts(RBC_MCQ);
    expect(chosenKeyOf(f, "The nucleus would make the cell too red.")).toBe("A");
    expect(chosenKeyOf(f, "c")).toBe("C");
    expect(chosenKeyOf(f, "something else")).toBeNull();
  });
});

describe("the content-word overlap check", () => {
  it("stems simply and ignores stop-words", () => {
    expect(["genes", "switches", "making", "switched", "glass", "cell"].map(stem)).toEqual(["gene", "switch", "mak", "switch", "glass", "cell"]);
    // The right option's content words: space, available, haemoglobin ("more", "is", "for" are stop-words).
    expect(contentOverlap(RBC_EXPLANATION, "More space is available for haemoglobin.")).toBeCloseTo(2 / 3);
    expect(contentOverlap("Think about what fills the cell.", "More space is available for haemoglobin.")).toBe(0);
  });
});

describe("the ladder on the real mcq", () => {
  const m = ch5Manifest();
  const f = facts(RBC_MCQ);

  it("attempt 1, option A → rung 1 NAMES misconception m2 — no correction", () => {
    const step = remediation(f, "A", 1, m);
    expect(step.rungs).toEqual([{ rung: 1, kind: "misconception", misconception: "Red blood cells have a nucleus like other cells and the nucleus makes them red." }]);
    expect(step.reveal).toBeNull();
    expect(step.state).toEqual({ served: [1], named: "m2", correctionShown: false });
    expect(JSON.stringify(step)).not.toContain("leaves room for haemoglobin");
  });
  it("an option with no misconception_ref → its why_wrong", () => {
    expect(remediation(f, "C", 1, m).rungs).toEqual([{ rung: 1, kind: "why_wrong", text: "Believes red blood cells divide, but without a nucleus they cannot." }]);
  });
  it("attempt 2 → the explanation overlaps the answer (2 of 3 content words), so the hint points to the section", () => {
    expect(leaks(RBC_EXPLANATION, f)).toBe(true);
    expect(remediation(f, "C", 2, m, { served: [1], named: "m2" }).rungs).toEqual([{ rung: 2, kind: "hint", from: "section", k: 1, key: "p1:s002", heading: "Red blood cells" }]);
  });
  it("a right-option rationale that passes the check comes before the section pointer", () => {
    const g: RemediationFacts = { ...f, rightRationale: "Think about what fills the inside of the cell once the nucleus has gone." };
    expect(hintRung(g, m)).toEqual({ rung: 2, kind: "hint", text: "Think about what fills the inside of the cell once the nucleus has gone.", from: "rationale" });
    expect(hintRung({ ...f, rightRationale: "There is more space for haemoglobin, which is available." }, m)).toMatchObject({ from: "section" });
  });
  it("attempt 3 → slide(k) carrying m2's correction, then the check question; the answer revealed", () => {
    const last = remediation(f, "D", MAX_ATTEMPTS, m, { served: [1, 2], named: "m2" });
    expect(last.final).toBe(true);
    expect(last.rungs).toEqual([
      { rung: 3, kind: "slide", k: 1, key: "p1:s002", heading: "Red blood cells", correction: M2_CORRECTION },
      { rung: 4, kind: "verify", itemId: RBC_FILL, via: "objective", item: null },
    ]);
    expect(last.reveal).toEqual({ answer: "B. More space is available for haemoglobin.", explanation: RBC_EXPLANATION, correction: null });
  });
  it("with no slide left to carry it, the reveal carries the correction", () => {
    const last = remediation(f, "A", MAX_ATTEMPTS, m, { served: [1, 2, 3], named: "m2" });
    expect(last.rungs.map((r) => r.rung)).toEqual([4]);
    expect(last.reveal?.correction).toBe(M2_CORRECTION);
  });
  it("replays the ladder state (hints_used of the next attempt)", () => {
    expect(ladderHistory(f, [], m)).toEqual({ served: [], named: null, correctionShown: false });
    expect(ladderHistory(f, ["A"], m)).toEqual({ served: [1], named: "m2", correctionShown: false });
    expect(ladderHistory(f, ["A", "C"], m).served).toEqual([1, 2]);
    // An answer that is no option: rung 1 cannot be named, so the hint comes first.
    expect(ladderHistory(f, [null, "A"], m)).toEqual({ served: [2, 1], named: "m2", correctionShown: false });
  });
});

describe("the answer never leaks before the reveal", () => {
  const corrections = CH5_ARTICLE_ROW.misconceptions.map((x) => x.correction);
  it("every real row × every choice × attempts 1–2: no answer text, no key, no ≥ 60 % content overlap; rung 1 never carries a correction", () => {
    const m = ch5Manifest();
    let checked = 0;
    for (const r of CH5_BANK_ROWS) {
      const f = facts(r.id);
      const choices = [...f.options.map((o) => o.key), null, "true", "false"];
      for (const c of choices) {
        for (const prior of [[], [1], [2], [1, 2]] as RungNo[][]) {
          for (let n = 1; n < MAX_ATTEMPTS; n++) {
            for (const rung of remediation(f, c, n, m, { served: prior, named: "m2" }).rungs) {
              const texts = Object.entries(rung).filter(([k, v]) => typeof v === "string" && !["kind", "from", "key", "itemId"].includes(k)).map(([, v]) => v as string);
              for (const t of texts) {
                checked++;
                for (const a of f.answerTexts) {
                  expect(t.toLowerCase()).not.toContain(a.toLowerCase());
                  expect(contentOverlap(t, a)).toBeLessThan(OVERLAP_LIMIT);
                }
                if (f.type === "mcq" && f.answerKey) expect(mentionsKey(t, f.answerKey)).toBe(false);
              }
              if (rung.rung === 1) for (const corr of corrections) expect(JSON.stringify(rung)).not.toContain(corr);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
  it("on every real row the hint either passes the overlap check or falls back", () => {
    const m = ch5Manifest();
    for (const r of CH5_BANK_ROWS) {
      const f = facts(r.id);
      const h = hintRung(f, m)!;
      if (h.from === "section") expect(f.explanation === null || leaks(f.explanation, f)).toBe(true);
      else for (const a of f.answerTexts) expect(contentOverlap(h.text, a)).toBeLessThan(OVERLAP_LIMIT);
    }
    expect(hintRung(facts(RBC_AR), m)).toMatchObject({ from: "explanation" }); // shares no content word with "Both A and R are true…"
  });
  it("a hint drops every sentence that names the right option or its key", () => {
    const f: RemediationFacts = { ...facts(RBC_MCQ), explanation: "The answer is B. More space is available for haemoglobin. Think about what fills the cell instead of a nucleus." };
    expect(hintRung(f)).toEqual({ rung: 2, kind: "hint", text: "Think about what fills the cell instead of a nucleus.", from: "explanation" });
    expect(redact("Option B is right.", f)).toBeNull();
    expect(leaks("(B) is it", f)).toBe(true);
    expect(leaks("a big cell", f)).toBe(false); // the word "a"/"big" is not key "B"
  });
  it("no explanation, rationale or section → no hint", () => {
    const fill = facts(RBC_FILL); // "Haemoglobin binds oxygen…" names the answer
    expect(hintRung(fill, ch5Manifest())).toEqual({ rung: 2, kind: "hint", from: "section", k: 1, key: "p1:s002", heading: "Red blood cells" });
    expect(hintRung(fill)).toBeNull();
  });
  it("a misconception whose text overlaps the answer falls back to why_wrong", () => {
    const f = facts(RBC_MCQ);
    const leaky: RemediationFacts = { ...f, misconceptions: f.misconceptions.map((x) => (x.id === "m2" ? { ...x, misconception: "Space for haemoglobin is available anyway." } : x)) };
    expect(misconceptionRung(leaky, "A")).toEqual({ rung: 1, kind: "why_wrong", text: "Believes the nucleus is involved in making the cell red, when haemoglobin gives the colour." });
  });
});

describe("non-mcq items", () => {
  it("skip rung 1 (no rationale) and still get the hint, slide(k) and a check question", () => {
    const m = ch5Manifest();
    const f = facts(RBC_FILL);
    expect(remediation(f, null, 1, m).rungs).toEqual([{ rung: 2, kind: "hint", from: "section", k: 1, key: "p1:s002", heading: "Red blood cells" }]);
    expect(remediation(f, null, 2, m, { served: [2] }).rungs).toEqual([{ rung: 3, kind: "slide", k: 1, key: "p1:s002", heading: "Red blood cells", correction: null }]);
    const last = remediation(f, null, 3, m, { served: [2, 3] });
    expect(last.rungs).toEqual([{ rung: 4, kind: "verify", itemId: RBC_MCQ, via: "objective", item: null }]);
    expect(last.reveal).toEqual({ answer: "haemoglobin", explanation: "Haemoglobin binds oxygen in the lungs and releases it in the tissues.", correction: null });
  });
  it("an item with a rationale for the chosen answer gets rung 1 (true/false)", () => {
    const f: RemediationFacts = { ...facts(UNMAPPED_ITEM), rationale: { FALSE: { why_wrong: "Every organ is built from several tissues working together." } } };
    expect(remediation(f, chosenKeyOf(f, false), 1, ch5Manifest()).rungs).toEqual([{ rung: 1, kind: "why_wrong", text: "Every organ is built from several tissues working together." }]);
  });
});

describe("the check question", () => {
  const m = ch5Manifest();
  it("is a different item on the same objective key, auto-marked types first", () => {
    expect(verificationItem(m, RBC_MCQ, O2_KEY)).toEqual({ itemId: RBC_FILL, via: "objective" });
    expect(verificationItem(m, RBC_FILL, O2_KEY)).toEqual({ itemId: RBC_MCQ, via: "objective" });
    expect(verificationItem(m, RBC_MCQ, O2_KEY, { exclude: [RBC_FILL] })).toEqual({ itemId: RBC_AR, via: "objective" });
    expect(verificationItem(m, RBC_MCQ, O2_KEY, { exclude: [RBC_FILL, RBC_AR] })).toEqual({ itemId: RBC_SHORT, via: "objective" });
  });
  it("is never the item itself, never another objective's; none left → null (the rung says so and offers the explanation)", () => {
    expect(verificationItem(m, GENES_MCQ, `${GENES_MCQ}:o1`)).toBeNull();
    const none = remediation(facts(GENES_MCQ), "A", 3, m, { served: [1, 2], named: "m1" });
    expect(none.rungs.at(-1)).toEqual({ rung: 4, kind: "verify", itemId: null, explanation: "Cells carry the same genes; differentiation switches different genes on and off, giving different proteins and structures." });
  });
  it("uses the bank rows' objective keys when given (not only objective_ref-mapped items)", () => {
    expect(verificationItem(m, RBC_MCQ, O2_KEY, { objectiveKeys: { [RBC_SHORT]: O2_KEY, [RBC_FILL]: null, [RBC_AR]: null } })).toEqual({ itemId: RBC_SHORT, via: "objective" });
  });
});

describe("the player's ladder helpers (client-safe, src/sk/kit-player.ts)", () => {
  it("slide(k) and a section hint → the section's position; the check question goes right after the current one, once", async () => {
    const { kitSegments } = await import("../kit-view");
    const { sectionForRung, withCheckItem } = await import("../kit-player");
    const segs = kitSegments(ch5Manifest());
    expect(sectionForRung(segs, { rung: 3, kind: "slide", k: 1, key: "p1:s002", heading: "Red blood cells", correction: null })).toBe(1);
    expect(sectionForRung(segs, { rung: 2, kind: "hint", from: "section", k: 2, key: "p1:s003", heading: "Tissues and organs" })).toBe(2);
    expect(sectionForRung(segs, { rung: 2, kind: "hint", text: "x", from: "explanation" })).toBe(-1);
    const a = { id: "a", type: "short" as const, prompt: "A", marks: 1 };
    const b = { id: "b", type: "short" as const, prompt: "B", marks: 1 };
    const c = { id: "c", type: "short" as const, prompt: "C", marks: 1 };
    expect(withCheckItem([a, b], 0, c).map((x) => x.id)).toEqual(["a", "c", "b"]);
    expect(withCheckItem([a, b], 0, b).map((x) => x.id)).toEqual(["a", "b"]);
  });
});
