/**
 * SK S3 slice C — the remediation ladder, pure (src/sk/remediation.ts) over
 * REAL production bank rows (./remediation-fixtures.ts): the rung order, the
 * answer never leaking before the reveal, slide(k), the check question (a
 * different item on the same objective), non-mcq items, and the replay of
 * served rungs that gives each attempt its hints_used.
 */
import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS } from "../grade";
import { factsFrom } from "../remediation-bank";
import { chosenKeyOf, hintRung, ladderHistory, leaks, mentionsKey, misconceptionRung, redact, remediation, verificationItem, type RemediationFacts } from "../remediation";
import { CH5_ARTICLE_ROW, CH5_BANK_ROWS, ch5Manifest, GENES_MCQ, O2_KEY, RBC_AR, RBC_FILL, RBC_MCQ, RBC_SHORT, UNMAPPED_ITEM } from "./remediation-fixtures";

const row = (id: string) => CH5_BANK_ROWS.find((r) => r.id === id)! as unknown as Record<string, unknown>;
const facts = (id: string): RemediationFacts => factsFrom(row(id), row(id).article_id ? (CH5_ARTICLE_ROW as unknown as Record<string, unknown>) : null)!;

describe("facts from the bank row", () => {
  it("reads keys, the answer, the rationale, the misconceptions and the objective key", () => {
    const f = facts(RBC_MCQ);
    expect(f).toMatchObject({ type: "mcq", answerKey: "B", answerTexts: ["More space is available for haemoglobin."], answerDisplay: "B. More space is available for haemoglobin.", objectiveKey: O2_KEY });
    expect(f.rationale.A).toEqual({ why_wrong: "Believes the nucleus is involved in making the cell red, when haemoglobin gives the colour.", misconception_ref: "m2" });
    expect(f.misconceptions.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(f.objectiveText).toBe("Explain how the structure of a red blood cell is related to its function of carrying oxygen.");
    expect(facts(UNMAPPED_ITEM).objectiveKey).toBeNull();
  });
  it("maps a response to the option key (text or letter)", () => {
    const f = facts(RBC_MCQ);
    expect(chosenKeyOf(f, "The nucleus would make the cell too red.")).toBe("A");
    expect(chosenKeyOf(f, "c")).toBe("C");
    expect(chosenKeyOf(f, "something else")).toBeNull();
  });
});

describe("the ladder on the real mcq", () => {
  const m = ch5Manifest();
  const f = facts(RBC_MCQ);

  it("attempt 1, option A → rung 1 names misconception m2 from the article", () => {
    const step = remediation(f, "A", 1, m);
    expect(step).toEqual({
      final: false,
      reveal: null,
      rungs: [{ rung: 1, kind: "misconception", misconception: "Red blood cells have a nucleus like other cells and the nucleus makes them red.", correction: "Mature mammalian red blood cells have no nucleus. This leaves room for haemoglobin, and haemoglobin is what makes them red." }],
    });
  });
  it("an option with no misconception_ref → its why_wrong", () => {
    expect(remediation(f, "C", 1, m).rungs).toEqual([{ rung: 1, kind: "why_wrong", text: "Believes red blood cells divide, but without a nucleus they cannot." }]);
  });
  it("attempt 2 → the hint; attempt 3 → slide(k) and the check question, with the answer revealed", () => {
    expect(remediation(f, "C", 2, m, { served: [1] }).rungs).toEqual([{ rung: 2, kind: "hint", text: "Losing the nucleus frees internal space so more haemoglobin fits, and each cell carries more oxygen.", from: "explanation" }]);
    const last = remediation(f, "D", MAX_ATTEMPTS, m, { served: [1, 2] });
    expect(last.final).toBe(true);
    expect(last.rungs).toEqual([
      { rung: 3, kind: "slide", k: 1, key: "p1:s002", heading: "Red blood cells" },
      { rung: 4, kind: "verify", itemId: RBC_FILL, via: "objective", item: null },
    ]);
    expect(last.reveal).toEqual({ answer: "B. More space is available for haemoglobin.", explanation: "Losing the nucleus frees internal space so more haemoglobin fits, and each cell carries more oxygen." });
  });
  it("replays the rungs served so far (hints_used of the next attempt)", () => {
    expect(ladderHistory(f, [], m)).toEqual([]);
    expect(ladderHistory(f, ["A"], m)).toEqual([1]);
    expect(ladderHistory(f, ["A", "C"], m)).toEqual([1, 2]);
    // An answer that is no option: rung 1 cannot be named, so the hint comes first.
    expect(ladderHistory(f, [null, "A"], m)).toEqual([2, 1]);
  });
});

describe("the answer never leaks before the reveal", () => {
  it("no rung before the last attempt carries the right option's text or key — every real row, every choice", () => {
    const m = ch5Manifest();
    for (const r of CH5_BANK_ROWS) {
      const f = facts(r.id);
      const choices = [...f.options.map((o) => o.key), null, "true", "false"];
      for (const c of choices) {
        for (let n = 1; n < MAX_ATTEMPTS; n++) {
          for (const rung of remediation(f, c, n, m, { served: n === 2 ? [1] : [] }).rungs) {
            const text = JSON.stringify(rung);
            for (const a of f.answerTexts) expect(text.toLowerCase()).not.toContain(a.toLowerCase());
            if (f.type === "mcq" && f.answerKey) for (const s of Object.values(rung).filter((v): v is string => typeof v === "string" && v !== rung.kind)) expect(mentionsKey(s, f.answerKey)).toBe(false);
          }
        }
      }
    }
  });
  it("a hint drops every sentence that names the right option or its key", () => {
    const f: RemediationFacts = { ...facts(RBC_MCQ), explanation: "The answer is B. More space is available for haemoglobin. Think about what fills the cell instead of a nucleus." };
    expect(hintRung(f)).toEqual({ rung: 2, kind: "hint", text: "Think about what fills the cell instead of a nucleus.", from: "explanation" });
    expect(redact("Option B is right.", f)).toBeNull();
    expect(leaks("(B) is it", f)).toBe(true);
    expect(leaks("a big cell", f)).toBe(false); // the word "a"/"big" is not key "B"
  });
  it("when nothing of the explanation survives, the hint is the objective; when nothing survives at all, no hint", () => {
    const fill = facts(RBC_FILL); // "Haemoglobin binds oxygen…" names the answer
    expect(hintRung(fill)).toEqual({ rung: 2, kind: "hint", text: "Explain how the structure of a red blood cell is related to its function of carrying oxygen.", from: "objective" });
    expect(hintRung({ ...fill, objectiveText: "What is haemoglobin?" })).toBeNull();
  });
  it("a misconception whose correction would give the answer away falls back to why_wrong", () => {
    const f = facts(RBC_MCQ);
    const leaky: RemediationFacts = { ...f, misconceptions: f.misconceptions.map((x) => (x.id === "m2" ? { ...x, correction: "More space is available for haemoglobin." } : x)) };
    expect(misconceptionRung(leaky, "A")).toEqual({ rung: 1, kind: "why_wrong", text: "Believes the nucleus is involved in making the cell red, when haemoglobin gives the colour." });
  });
});

describe("non-mcq items", () => {
  it("skip rung 1 (no rationale) and still get the hint, slide(k) and a check question", () => {
    const m = ch5Manifest();
    const f = facts(RBC_FILL);
    expect(remediation(f, null, 1, m).rungs.map((r) => r.rung)).toEqual([2]);
    expect(remediation(f, null, 2, m, { served: [2] }).rungs).toEqual([{ rung: 3, kind: "slide", k: 1, key: "p1:s002", heading: "Red blood cells" }]);
    const last = remediation(f, null, 3, m, { served: [2, 3] });
    expect(last.rungs).toEqual([{ rung: 4, kind: "verify", itemId: RBC_MCQ, via: "objective", item: null }]);
    expect(last.reveal).toEqual({ answer: "haemoglobin", explanation: "Haemoglobin binds oxygen in the lungs and releases it in the tissues." });
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
    const none = remediation(facts(GENES_MCQ), "A", 3, m, { served: [1, 2] });
    expect(none.rungs.at(-1)).toEqual({ rung: 4, kind: "verify", itemId: null, explanation: "Cells carry the same genes; differentiation switches different genes on and off, giving different proteins and structures." });
  });
  it("uses the bank rows' objective keys when given (not only objective_ref-mapped items)", () => {
    expect(verificationItem(m, RBC_MCQ, O2_KEY, { objectiveKeys: { [RBC_SHORT]: O2_KEY, [RBC_FILL]: null, [RBC_AR]: null } })).toEqual({ itemId: RBC_SHORT, via: "objective" });
  });
});

describe("the player's ladder helpers (client-safe, src/sk/kit-player.ts)", () => {
  it("slide(k) → the section's position; the check question goes right after the current one, once", async () => {
    const { kitSegments } = await import("../kit-view");
    const { sectionForRung, withCheckItem } = await import("../kit-player");
    const segs = kitSegments(ch5Manifest());
    expect(sectionForRung(segs, { rung: 3, kind: "slide", k: 1, key: "p1:s002", heading: "Red blood cells" })).toBe(1);
    expect(sectionForRung(segs, { rung: 2, kind: "hint", text: "x", from: "explanation" })).toBe(-1);
    const a = { id: "a", type: "short" as const, prompt: "A", marks: 1 };
    const b = { id: "b", type: "short" as const, prompt: "B", marks: 1 };
    const c = { id: "c", type: "short" as const, prompt: "C", marks: 1 };
    expect(withCheckItem([a, b], 0, c).map((x) => x.id)).toEqual(["a", "c", "b"]);
    expect(withCheckItem([a, b], 0, b).map((x) => x.id)).toEqual(["a", "b"]);
  });
});
