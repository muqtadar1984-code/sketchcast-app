/**
 * The question bank's pure logic (Phase 3, spec decisions 8 and 9): the item
 * vocabulary, the inline-edit validator (a mirror of the worker's — an MCQ
 * whose distractor lacks why_wrong, whose keyed answer is not an option, or
 * with duplicate options is refused), the maturity ladder, objective
 * coverage, near-duplicate detection, the regenerate hints, the blueprint
 * validators, the composer's largest-remainder arithmetic (a mirror of
 * catalogue/composer.py) and the page filters.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-questions.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  ANSWER_MODES,
  BLANK_RE,
  BLUEPRINT_PRESETS,
  COGNITIVE_LEVELS,
  DEFAULT_TARGET,
  DIAGRAM_LABELS,
  HINTS_MAX,
  ITEM_TYPES,
  MATCH_PAIRS,
  MATURITY_LADDER,
  MCQ_KEYS,
  OBJECTIVE_ITEM_TYPES,
  QUESTION_LIMITS,
  QUESTION_STATUSES,
  answerModeOf,
  answerSummary,
  applyQuestionFilters,
  canApproveQuestion,
  canCompose,
  canEditQuestion,
  canRejectQuestion,
  canRetireQuestion,
  composePlan,
  duplicateGroups,
  duplicateKey,
  largestRemainder,
  maturityFor,
  maturityRank,
  meetsMaturity,
  mmss,
  modeCounts,
  nextRung,
  objectiveCoverage,
  parseQuestionFilters,
  questionContentKey,
  questionEditOf,
  rejectedHints,
  seedOf,
  thinObjectives,
  validateBlueprint,
  validateBlueprintSpec,
  validateQuestionEdit,
  withQuestionFilter,
  type BlueprintSpec,
  type TopicQuestion,
} from "../catalogue/questions";

const article = {
  objectives: [{ id: "o1" }, { id: "o2" }],
  claims: [{ id: "c1" }],
  misconceptions: [{ id: "m1" }],
};

/** A valid MCQ edit — every test mutates one field of this. */
const mcq = () => ({
  item_type: "mcq",
  stem: "Which organelle controls the activities of the cell?",
  objective_ref: "o1",
  claim_ref: "c1",
  difficulty: 2,
  cognitive_level: "recall",
  marks: 1,
  est_seconds: 45,
  options: [
    { key: "A", text: "Nucleus" },
    { key: "B", text: "Cell wall" },
    { key: "C", text: "Vacuole" },
    { key: "D", text: "Cytoplasm" },
  ],
  answer: { key: "A" },
  distractor_rationale: {
    B: { why_wrong: "The wall gives shape and support, not control.", misconception_ref: "m1" },
    C: { why_wrong: "The vacuole stores water and solutes." },
    D: { why_wrong: "The cytoplasm is where reactions happen, not where they are directed." },
  },
  marking_scheme: [],
  explanation: "The nucleus holds the chromosomes.",
  tags: ["cells", "organelles"],
});

const shortAnswer = () => ({
  item_type: "short_answer",
  stem: "Explain why plant cells have a cell wall and animal cells do not.",
  objective_ref: "o2",
  difficulty: 3,
  cognitive_level: "understand",
  marks: 3,
  answer: { text: "Plants need rigid support; animals have skeletons or move." },
  marking_scheme: [
    { point: "Wall gives support / shape", marks: 1 },
    { point: "Plants cannot move to avoid stress", marks: 1 },
    { point: "Animal cells rely on other structures", marks: 1 },
  ],
});

const row = (over: Partial<TopicQuestion>): TopicQuestion => ({
  id: over.id ?? "q1",
  topic_id: "t1",
  article_id: "a1",
  objective_ref: "o1",
  claim_ref: null,
  language: "en",
  source_question_id: null,
  item_type: "mcq",
  answer_mode: "objective",
  difficulty: 2,
  cognitive_level: "recall",
  marks: 1,
  est_seconds: 45,
  stem: "Which organelle controls the activities of the cell?",
  options: null,
  distractor_rationale: null,
  answer: { key: "A" },
  marking_scheme: null,
  explanation: null,
  tags: [],
  content_hash: "x",
  status: "draft",
  reviewer_id: null,
  reviewed_at: null,
  notes: null,
  created_at: "2026-09-06T00:00:00Z",
  updated_at: "2026-09-06T00:00:00Z",
  ...over,
});

describe("the vocabulary matches the 0112 CHECK constraints", () => {
  it("lists the nine item types, two answer modes, six cognitive levels and four statuses", () => {
    expect([...ITEM_TYPES]).toEqual(["mcq", "true_false", "fill_blank", "match", "assertion_reason", "short_answer", "long_answer", "numerical", "diagram_label"]);
    expect([...ANSWER_MODES]).toEqual(["objective", "subjective"]);
    expect([...COGNITIVE_LEVELS]).toEqual(["recall", "understand", "apply", "analyse", "evaluate", "create"]);
    expect([...QUESTION_STATUSES]).toEqual(["draft", "approved", "rejected", "retired"]);
    expect(DEFAULT_TARGET).toBe(30);
  });

  it("derives answer_mode from the type: the five objective kinds, the four subjective ones", () => {
    expect([...OBJECTIVE_ITEM_TYPES].sort()).toEqual(["assertion_reason", "fill_blank", "match", "mcq", "true_false"]);
    for (const t of ["mcq", "true_false", "fill_blank", "match", "assertion_reason"] as const) expect(answerModeOf(t), t).toBe("objective");
    for (const t of ["short_answer", "long_answer", "numerical", "diagram_label"] as const) expect(answerModeOf(t), t).toBe("subjective");
  });

  it("status predicates: edit draft|approved, approve from draft only, reject draft|approved, retire anything not retired", () => {
    expect(canEditQuestion("draft")).toBe(true);
    expect(canEditQuestion("approved")).toBe(true);
    expect(canEditQuestion("rejected")).toBe(false);
    expect(canApproveQuestion("draft")).toBe(true);
    expect(canApproveQuestion("rejected")).toBe(false);
    expect(canApproveQuestion("approved")).toBe(false);
    expect(canRejectQuestion("approved")).toBe(true);
    expect(canRejectQuestion("retired")).toBe(false);
    expect(canRetireQuestion("rejected")).toBe(true);
    expect(canRetireQuestion("retired")).toBe(false);
  });
});

describe("validateQuestionEdit — the worker validator's rules", () => {
  it("accepts a well-formed MCQ and normalises it (keys upper-cased, answer_mode derived)", () => {
    const input = mcq();
    (input.options[1] as { key: string }).key = "b";
    (input.distractor_rationale as Record<string, unknown>).b = (input.distractor_rationale as Record<string, unknown>).B;
    const v = validateQuestionEdit(input, article);
    expect(v.ok, v.errors.join(" | ")).toBe(true);
    if (!v.ok) return;
    expect(v.item.answer_mode).toBe("objective");
    expect((v.item.options as { key: string }[]).map((o) => o.key)).toEqual(["A", "B", "C", "D"]);
    expect(v.item.answer).toEqual({ key: "A" });
    expect(Object.keys(v.item.distractor_rationale!).sort()).toEqual(["B", "C", "D"]);
    expect(v.item.distractor_rationale!.B.misconception_ref).toBe("m1");
    expect(v.item.tags).toEqual(["cells", "organelles"]);
  });

  it("refuses an MCQ whose keyed answer is not among the options", () => {
    const v = validateQuestionEdit({ ...mcq(), answer: { key: "E" } }, article);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/answer\.key "E" is not one of the options/);
  });

  it("refuses an MCQ with duplicate options — by text (case-folded) and by key", () => {
    const byText = mcq();
    byText.options[2].text = "nucleus";
    const v1 = validateQuestionEdit(byText, article);
    expect(v1.ok).toBe(false);
    expect(v1.errors.join("\n")).toMatch(/duplicate option text/);
    const byKey = mcq();
    byKey.options[3].key = "C";
    const v2 = validateQuestionEdit(byKey, article);
    expect(v2.ok).toBe(false);
    expect(v2.errors.join("\n")).toMatch(/duplicate key "C"/);
  });

  it("refuses an MCQ whose distractor lacks why_wrong, and one with the wrong number of options", () => {
    const missing = mcq();
    delete (missing.distractor_rationale as Record<string, unknown>).C;
    const v = validateQuestionEdit(missing, article);
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("distractor C has no why_wrong.");
    const three = mcq();
    three.options = three.options.slice(0, 3);
    const v3 = validateQuestionEdit(three, article);
    expect(v3.ok).toBe(false);
    expect(v3.errors.join("\n")).toMatch(/exactly 4 options/);
  });

  it("a distractor's misconception_ref must be one of the article's misconceptions", () => {
    const input = mcq();
    (input.distractor_rationale as Record<string, { misconception_ref?: string }>).C.misconception_ref = "m9";
    const v = validateQuestionEdit(input, article);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/misconception_ref "m9"/);
  });

  it("objective_ref is required and must resolve; claim_ref must resolve when given", () => {
    const none = validateQuestionEdit({ ...mcq(), objective_ref: "" }, article);
    expect(none.errors.join("\n")).toMatch(/objective_ref is required/);
    const bad = validateQuestionEdit({ ...mcq(), objective_ref: "o9" }, article);
    expect(bad.errors.join("\n")).toMatch(/objective_ref "o9"/);
    const claim = validateQuestionEdit({ ...mcq(), claim_ref: "c9" }, article);
    expect(claim.errors.join("\n")).toMatch(/claim_ref "c9"/);
    const noClaim = validateQuestionEdit({ ...mcq(), claim_ref: "" }, article);
    expect(noClaim.ok).toBe(true);
    if (noClaim.ok) expect(noClaim.item.claim_ref).toBeNull();
  });

  it("bounds difficulty 1..5, marks 1..50, est_seconds 10..3600, and knows the cognitive levels", () => {
    expect(validateQuestionEdit({ ...mcq(), difficulty: 6 }, article).errors.join()).toMatch(/difficulty/);
    expect(validateQuestionEdit({ ...mcq(), difficulty: "3" }, article).ok).toBe(true);
    expect(validateQuestionEdit({ ...mcq(), marks: 0 }, article).errors.join()).toMatch(/marks/);
    expect(validateQuestionEdit({ ...mcq(), marks: QUESTION_LIMITS.marks + 1 }, article).errors.join()).toMatch(/marks/);
    expect(validateQuestionEdit({ ...mcq(), est_seconds: 5 }, article).errors.join()).toMatch(/est_seconds/);
    const blank = validateQuestionEdit({ ...mcq(), est_seconds: "" }, article);
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.item.est_seconds).toBeNull();
    expect(validateQuestionEdit({ ...mcq(), cognitive_level: "remember" }, article).errors.join()).toMatch(/cognitive_level/);
  });

  it("refuses raw HTML in the stem or the explanation, and an unknown item_type outright", () => {
    expect(validateQuestionEdit({ ...mcq(), stem: "Which <b>organelle</b>?" }, article).errors).toContain("stem may not contain HTML tags.");
    expect(validateQuestionEdit({ ...mcq(), stem: "Is 3 < 4 or 4 < 3?" }, article).ok).toBe(true);
    expect(validateQuestionEdit({ ...mcq(), explanation: "<script>" }, article).errors).toContain("explanation may not contain HTML tags.");
    const v = validateQuestionEdit({ ...mcq(), item_type: "essay" }, article);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/item_type must be one of/);
  });

  it("true_false wants answer.value as a boolean (or 'true'/'false')", () => {
    const base = { ...shortAnswer(), item_type: "true_false", marks: 1, marking_scheme: [] };
    expect(validateQuestionEdit({ ...base, answer: { value: true } }, article).ok).toBe(true);
    const coerced = validateQuestionEdit({ ...base, answer: { value: "false" } }, article);
    expect(coerced.ok).toBe(true);
    if (coerced.ok) expect(coerced.item.answer).toEqual({ value: false });
    expect(validateQuestionEdit({ ...base, answer: { value: "maybe" } }, article).errors).toContain("answer.value must be true or false.");
  });

  it("a subjective item needs a marking scheme that adds up to its marks; an objective item may omit one", () => {
    const ok = validateQuestionEdit(shortAnswer(), article);
    expect(ok.ok, ok.errors.join(" | ")).toBe(true);
    if (ok.ok) {
      expect(ok.item.answer_mode).toBe("subjective");
      expect(ok.item.options).toBeNull();
      expect(ok.item.distractor_rationale).toBeNull();
    }
    const none = validateQuestionEdit({ ...shortAnswer(), marking_scheme: [] }, article);
    expect(none.errors.join("\n")).toMatch(/needs a marking scheme/);
    const over = shortAnswer();
    over.marking_scheme[0].marks = 2;
    expect(validateQuestionEdit(over, article).errors.join("\n")).toMatch(/adds up to 4, but the item is worth 3 marks/);
    const zero = shortAnswer();
    zero.marking_scheme[0].marks = 0;
    expect(validateQuestionEdit(zero, article).errors.join("\n")).toMatch(/marks must be a positive number/);
    expect(validateQuestionEdit({ ...shortAnswer(), answer: {} }, article).errors).toContain("answer.text is required for a short answer.");
    expect(validateQuestionEdit({ ...shortAnswer(), answer: { text: "  " } }, article).errors).toContain("answer.text is required for a short answer.");
    // the worker's TEXT_MAX
    expect(QUESTION_LIMITS.answer_text).toBe(2000);
    expect(validateQuestionEdit({ ...shortAnswer(), answer: { text: "x".repeat(2001) } }, article).errors.join()).toMatch(/answer\.text is longer than 2000/);
  });

  // ── the per-type mirror of the worker's validate_item ──

  it("MCQ option keys are A–D and nothing else (a key the worker refuses would print as 'E)' on the worksheet)", () => {
    expect([...MCQ_KEYS]).toEqual(["A", "B", "C", "D"]);
    const opts = mcq().options;
    const e = validateQuestionEdit({ ...mcq(), options: [opts[0], opts[1], opts[2], { key: "E", text: "Ribosome" }], answer: { key: "E" } }, article);
    expect(e.ok).toBe(false);
    expect(e.errors.join("\n")).toMatch(/key "E" is not one of A, B, C, D/);
    const one = validateQuestionEdit({ ...mcq(), options: [opts[0], opts[1], opts[2], { key: "1", text: "Ribosome" }] }, article);
    expect(one.errors.join("\n")).toMatch(/key "1" is not one of/);
    // lower-case keys are upper-cased and the stored list is in key order
    const shuffled = validateQuestionEdit({ ...mcq(), options: [opts[2], opts[0], opts[3], { key: "b", text: "Cell wall" }] }, article);
    expect(shuffled.ok, shuffled.errors.join(" | ")).toBe(true);
    if (shuffled.ok) expect((shuffled.item.options as { key: string }[]).map((o) => o.key)).toEqual(["A", "B", "C", "D"]);
  });

  it("assertion–reason follows the MCQ option rules — exactly 4 keyed A–D, unique texts, answer among them — with why_wrong optional", () => {
    const ar = {
      ...shortAnswer(),
      item_type: "assertion_reason",
      marks: 1,
      marking_scheme: [],
      options: [
        { key: "a", text: "Both A and R are true and R explains A" },
        { key: "b", text: "Both true, R does not explain A" },
        { key: "c", text: "A true, R false" },
        { key: "d", text: "A false, R true" },
      ],
      answer: { key: "c", note: "The reason is false." },
    };
    const v = validateQuestionEdit(ar, article);
    expect(v.ok, v.errors.join(" | ")).toBe(true);
    if (v.ok) {
      expect(v.item.answer).toEqual({ key: "C" });
      expect(v.item.answer_mode).toBe("objective");
      // no rationale given: stored as null, the worker's shape
      expect(v.item.distractor_rationale).toBeNull();
    }
    expect(validateQuestionEdit({ ...ar, answer: { key: "e" } }, article).errors.join()).toMatch(/answer\.key "E"/);
    // finding (b): one option and a text answer used to pass — refused now
    const thin = validateQuestionEdit({ ...ar, options: [{ key: "A", text: "x" }], answer: { text: "yes" } }, article);
    expect(thin.ok).toBe(false);
    expect(thin.errors.join("\n")).toMatch(/exactly 4 options keyed A–D are required \(got 1\)/);
    expect(thin.errors.join("\n")).toMatch(/answer\.key is required for an assertion–reason item/);
    // a key outside A–D on an assertion–reason option (the row editor used to accept "E")
    const e = validateQuestionEdit({ ...ar, options: [...ar.options.slice(0, 3), { key: "E", text: "Neither" }] }, article);
    expect(e.errors.join("\n")).toMatch(/key "E" is not one of A, B, C, D/);
    // a rationale, when given, is bounded and its misconception must resolve
    const withWhy = validateQuestionEdit({ ...ar, distractor_rationale: { A: { why_wrong: "R is false.", misconception_ref: "m1" }, B: { why_wrong: "", misconception_ref: "m9" } } }, article);
    expect(withWhy.ok, withWhy.errors.join(" | ")).toBe(true);
    if (withWhy.ok) expect(withWhy.item.distractor_rationale).toEqual({ A: { why_wrong: "R is false.", misconception_ref: "m1" } });
    const badRef = validateQuestionEdit({ ...ar, distractor_rationale: { A: { why_wrong: "R is false.", misconception_ref: "m9" } } }, article);
    expect(badRef.errors.join("\n")).toMatch(/misconception_ref "m9"/);
    // duplicate texts are refused as on an MCQ
    const dup = validateQuestionEdit({ ...ar, options: [...ar.options.slice(0, 3), { key: "d", text: "A TRUE, R false" }] }, article);
    expect(dup.errors.join("\n")).toMatch(/duplicate option text/);
  });

  it("fill_blank: the stem must show its blank and answer.text is required; accept[] is kept", () => {
    const fb = { ...shortAnswer(), item_type: "fill_blank", marks: 1, marking_scheme: [], stem: "The ______ controls the cell.", answer: { text: "nucleus", accept: ["Nucleus", " nucleus ", "the nucleus"] } };
    const ok = validateQuestionEdit(fb, article);
    expect(ok.ok, ok.errors.join(" | ")).toBe(true);
    if (ok.ok) expect(ok.item.answer).toEqual({ text: "nucleus", accept: ["Nucleus", "nucleus", "the nucleus"] });
    for (const stem of ["Fill in: … controls the cell.", "The ... controls the cell."]) expect(BLANK_RE.test(stem), stem).toBe(true);
    // finding (c): a stem edited to remove its blank prints a statement with nothing to fill
    const noBlank = validateQuestionEdit({ ...fb, stem: "The nucleus controls the cell." }, article);
    expect(noBlank.ok).toBe(false);
    expect(noBlank.errors.join("\n")).toMatch(/must show the blank/);
    expect(validateQuestionEdit({ ...fb, stem: "The _ controls the cell." }, article).errors.join("\n")).toMatch(/must show the blank/);
    expect(validateQuestionEdit({ ...fb, answer: { text: "" } }, article).errors.join("\n")).toMatch(/answer\.text is required/);
    expect(validateQuestionEdit({ ...fb, answer: { text: "nucleus", accept: "Nucleus" } }, article).errors.join("\n")).toMatch(/answer\.accept must be a list/);
    const plain = validateQuestionEdit({ ...fb, answer: { text: "nucleus" } }, article);
    if (plain.ok) expect(plain.item.answer).toEqual({ text: "nucleus" });
  });

  it("match: 3–8 {left, right} pairs with unique sides, read from options.pairs / answer.pairs, stored as the worker's {pairs} on both", () => {
    expect(MATCH_PAIRS).toEqual({ min: 3, max: 8 });
    const pairs = [
      { left: "Nucleus", right: "Controls the cell" },
      { left: "Mitochondrion", right: "Releases energy" },
      { left: "Ribosome", right: "Makes proteins" },
    ];
    const base = { ...shortAnswer(), item_type: "match", marks: 3, marking_scheme: [] };
    const ok = validateQuestionEdit({ ...base, options: { pairs }, answer: { pairs } }, article);
    expect(ok.ok, ok.errors.join(" | ")).toBe(true);
    if (ok.ok) {
      expect(ok.item.options).toEqual({ pairs });
      expect(ok.item.answer).toEqual({ pairs });
      expect(ok.item.answer_mode).toBe("objective");
    }
    // from answer.pairs alone (the editor's answer JSON) is enough
    expect(validateQuestionEdit({ ...base, options: null, answer: { pairs } }, article).ok).toBe(true);
    // finding (d): 2 pairs, duplicate rights, junk rows were stored unchecked
    const two = validateQuestionEdit({ ...base, options: { pairs: pairs.slice(0, 2) }, answer: { pairs: pairs.slice(0, 2) } }, article);
    expect(two.ok).toBe(false);
    expect(two.errors.join("\n")).toMatch(/3 to 8 pairs \(got 2\)/);
    const dupRight = validateQuestionEdit({ ...base, options: { pairs: [...pairs.slice(0, 2), { left: "Ribosome", right: "releases energy" }] } }, article);
    expect(dupRight.errors.join("\n")).toMatch(/duplicate left or right/);
    const junk = validateQuestionEdit({ ...base, options: { pairs: [...pairs, { left: "Vacuole" }] } }, article);
    expect(junk.errors.join("\n")).toMatch(/pairs #4: both left and right are required/);
    expect(validateQuestionEdit({ ...base, options: { left: ["a"], right: ["b"] }, answer: { text: "x" } }, article).errors.join("\n")).toMatch(/needs options\.pairs/);
    const nine = validateQuestionEdit({ ...base, options: { pairs: Array.from({ length: 9 }, (_, i) => ({ left: `L${i}`, right: `R${i}` })) } }, article);
    expect(nine.errors.join("\n")).toMatch(/3 to 8 pairs \(got 9\)/);
  });

  it("numerical: answer.value is a finite number; unit and tolerance optional and typed", () => {
    const base = { ...shortAnswer(), item_type: "numerical", stem: "How long is the cell in micrometres?", marks: 3 };
    const ok = validateQuestionEdit({ ...base, answer: { value: "12.5", unit: "µm", tolerance: -0.5 } }, article);
    expect(ok.ok, ok.errors.join(" | ")).toBe(true);
    if (ok.ok) expect(ok.item.answer).toEqual({ value: 12.5, unit: "µm", tolerance: 0.5 });
    const bare = validateQuestionEdit({ ...base, answer: { value: 3 } }, article);
    if (bare.ok) expect(bare.item.answer).toEqual({ value: 3, unit: "", tolerance: null });
    // finding (d): {value: "abc"} was stored unchecked
    const abc = validateQuestionEdit({ ...base, answer: { value: "abc" } }, article);
    expect(abc.ok).toBe(false);
    expect(abc.errors.join("\n")).toMatch(/answer\.value must be a number/);
    expect(validateQuestionEdit({ ...base, answer: { text: "twelve" } }, article).errors.join("\n")).toMatch(/answer\.value must be a number/);
    expect(validateQuestionEdit({ ...base, answer: { value: 3, tolerance: "lots" } }, article).errors.join("\n")).toMatch(/tolerance must be a number/);
    expect(validateQuestionEdit({ ...base, answer: { value: 3, unit: "x".repeat(41) } }, article).errors.join("\n")).toMatch(/unit is longer than 40/);
  });

  it("diagram_label: a figure key and 2–8 labels; with the article's figures the key and every label must be real; the scheme is one mark per label", () => {
    expect(DIAGRAM_LABELS).toEqual({ min: 2, max: 8 });
    const withFigures = { ...article, figures: [{ figure_key: "plant_cell", caption: "A plant cell", labels: ["Nucleus", "Cell wall", "Vacuole"] }] };
    const base = { ...shortAnswer(), item_type: "diagram_label", stem: "Label the parts.", marks: 1, marking_scheme: [] };
    const ok = validateQuestionEdit({ ...base, options: { figure_key: "plant_cell" }, answer: { labels: ["Nucleus", { label: "Vacuole" }, "nucleus"] } }, withFigures);
    expect(ok.ok, ok.errors.join(" | ")).toBe(true);
    if (ok.ok) {
      expect(ok.item.options).toEqual({ figure_key: "plant_cell", caption: "A plant cell" });
      expect(ok.item.answer).toEqual({ labels: [{ n: 1, label: "Nucleus" }, { n: 2, label: "Vacuole" }] });
      // derived: one mark per label, marks follow (the worker's derivation)
      expect(ok.item.marking_scheme).toEqual([{ point: "Nucleus", marks: 1 }, { point: "Vacuole", marks: 1 }]);
      expect(ok.item.marks).toBe(2);
    }
    // shape only, without figures: still 2–8 labels and a key
    const shape = validateQuestionEdit({ ...base, options: { figure_key: "plant_cell" }, answer: { labels: ["Nucleus"] } }, article);
    expect(shape.ok).toBe(false);
    expect(shape.errors.join("\n")).toMatch(/2 to 8 labels \(got 1\)/);
    expect(validateQuestionEdit({ ...base, options: {}, answer: { labels: ["a", "b"] } }, article).errors.join("\n")).toMatch(/names its figure/);
    // with figures: an unknown figure, an unknown label
    expect(validateQuestionEdit({ ...base, options: { figure_key: "animal_cell" }, answer: { labels: ["Nucleus", "Vacuole"] } }, withFigures).errors.join("\n")).toMatch(/"animal_cell" is not a rendered, labelled figure/);
    expect(validateQuestionEdit({ ...base, options: { figure_key: "plant_cell" }, answer: { labels: ["Nucleus", "Chloroplast"] } }, withFigures).errors.join("\n")).toMatch(/"Chloroplast" is not one of the labels on figure "plant_cell"/);
    // a given scheme is checked against marks as for any subjective item
    const given = validateQuestionEdit({ ...base, marks: 4, marking_scheme: [{ point: "Nucleus", marks: 2 }, { point: "Vacuole", marks: 2 }], options: { figure_key: "plant_cell" }, answer: { labels: ["Nucleus", "Vacuole"] } }, withFigures);
    expect(given.ok, given.errors.join(" | ")).toBe(true);
    if (given.ok) expect(given.item.marks).toBe(4);
  });

  it("long_answer wants answer.text like short_answer", () => {
    const la = { ...shortAnswer(), item_type: "long_answer", marks: 3 };
    expect(validateQuestionEdit(la, article).ok).toBe(true);
    expect(validateQuestionEdit({ ...la, answer: { value: 3 } }, article).errors).toContain("answer.text is required for a long answer.");
  });

  it("names every problem at once", () => {
    const v = validateQuestionEdit({ ...mcq(), stem: "", difficulty: 0, marks: 0 }, article);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("questionContentKey and questionEditOf", () => {
  it("keys an item by type and canonicalKey(stem) — what the route sha1s, as the worker does", () => {
    expect(questionContentKey("mcq", "The Cells of plants!")).toBe("mcq|cell_of_plant");
    expect(questionContentKey("mcq", "cells of plants")).toBe(questionContentKey("mcq", "The Cells of plants!"));
    expect(questionContentKey("short_answer", "cells of plants")).not.toBe(questionContentKey("mcq", "cells of plants"));
  });

  it("questionEditOf starts an editor from a stored row, tolerating odd jsonb shapes", () => {
    // jsonb carries what the worker wrote — a stringly "2" is tolerated, junk rows dropped
    const oddScheme = [{ point: "p", marks: "2" }] as unknown as TopicQuestion["marking_scheme"];
    const e = questionEditOf(row({ options: [{ key: "A", text: "x" }, { junk: 1 }], marking_scheme: oddScheme, tags: ["a"] }));
    expect(e.options).toEqual([{ key: "A", text: "x" }]);
    expect(e.marking_scheme).toEqual([{ point: "p", marks: 2 }]);
    expect(e.objective_ref).toBe("o1");
    const m = questionEditOf(row({ item_type: "match", options: { left: ["a"], right: ["b"] } }));
    expect(m.options).toEqual({ left: ["a"], right: ["b"] });
  });

  it("answerSummary reads the answer per type", () => {
    expect(answerSummary(row({ item_type: "mcq", answer: { key: "B" } }))).toBe("B");
    expect(answerSummary(row({ item_type: "true_false", answer: { value: false } }))).toBe("false");
    expect(answerSummary(row({ item_type: "short_answer", answer: { text: "Because." } }))).toBe("Because.");
    expect(answerSummary(row({ item_type: "numerical", answer: { value: 3.2, unit: "m" } }))).toBe('{"value":3.2,"unit":"m"}');
    expect(answerSummary(row({ item_type: "numerical", answer: {} }))).toBe("—");
  });
});

describe("the maturity ladder (0112 topic_bank_maturity)", () => {
  it("has the six rungs at 0 / 10 / 20 / 30 / 50 / 100 approved items", () => {
    expect(MATURITY_LADDER.map((s) => [s.rung, s.min])).toEqual([
      ["none", 0],
      ["basic", 10],
      ["good", 20],
      ["strong", 30],
      ["assessment", 50],
      ["exam_ready", 100],
    ]);
    expect(maturityFor(0)).toBe("none");
    expect(maturityFor(9)).toBe("none");
    expect(maturityFor(10)).toBe("basic");
    expect(maturityFor(29)).toBe("good");
    expect(maturityFor(30)).toBe("strong");
    expect(maturityFor(50)).toBe("assessment");
    expect(maturityFor(250)).toBe("exam_ready");
  });

  it("nextRung says how many more approvals reach the next rung; the top has no next", () => {
    expect(nextRung(0)).toEqual({ current: "none", next: "basic", needed: 10 });
    expect(nextRung(7)).toEqual({ current: "none", next: "basic", needed: 3 });
    expect(nextRung(10)).toEqual({ current: "basic", next: "good", needed: 10 });
    expect(nextRung(45)).toEqual({ current: "strong", next: "assessment", needed: 5 });
    expect(nextRung(100)).toEqual({ current: "exam_ready", next: null, needed: 0 });
    expect(nextRung(-3)).toEqual({ current: "none", next: "basic", needed: 10 });
  });

  it("maturityRank orders the rungs and meetsMaturity compares them; unknown reads as none", () => {
    expect(maturityRank("none")).toBe(0);
    expect(maturityRank("exam_ready")).toBe(5);
    expect(maturityRank("banana")).toBe(0);
    expect(maturityRank(null)).toBe(0);
    expect(meetsMaturity("good", "basic")).toBe(true);
    expect(meetsMaturity("basic", "good")).toBe(false);
    expect(meetsMaturity(null, "basic")).toBe(false);
  });
});

describe("objectiveCoverage", () => {
  const objectives = [
    { id: "o1", text: "Parts of a cell" },
    { id: "o2", text: "Plant vs animal" },
    { id: "o3", text: "Microscopes" },
  ];

  it("counts approved and draft items per objective in article order; rejected and retired do not count", () => {
    const rows = objectiveCoverage(
      [
        row({ id: "1", objective_ref: "o1", status: "approved" }),
        row({ id: "2", objective_ref: "o1", status: "draft" }),
        row({ id: "3", objective_ref: "o2", status: "rejected" }),
        row({ id: "4", objective_ref: "o2", status: "retired" }),
        row({ id: "5", objective_ref: "o2", status: "approved" }),
      ],
      objectives,
    );
    expect(rows.map((r) => [r.id, r.approved, r.draft, r.total])).toEqual([
      ["o1", 1, 1, 2],
      ["o2", 1, 0, 1],
      ["o3", 0, 0, 0],
    ]);
    expect(thinObjectives(rows).map((r) => r.id)).toEqual(["o2", "o3"]);
  });

  it("gathers items with an unknown or missing objective in a trailing 'No objective' row — only when there are any", () => {
    const none = objectiveCoverage([row({ objective_ref: "o1" })], objectives);
    expect(none.at(-1)!.id).toBe("o3");
    const rows = objectiveCoverage([row({ id: "1", objective_ref: "gone", status: "draft" }), row({ id: "2", objective_ref: null, status: "approved" })], objectives);
    expect(rows.at(-1)).toEqual({ id: null, text: "No objective", approved: 1, draft: 1, total: 2 });
    // the orphan row is never a "thin objective" (nothing to write for it)
    expect(thinObjectives(rows).some((r) => r.id === null)).toBe(false);
  });
});

describe("near-duplicate detection", () => {
  it("keys a stem by its first 8 words, canonicalKey'd", () => {
    // canonicalKey folds the simple plurals: controls → control, activities → activitie
    expect(duplicateKey("Which organelle controls the activities of the cell? Explain.")).toBe("which_organelle_control_the_activitie_of_the_cell");
    expect(duplicateKey("  which ORGANELLE controls the activities of the cell   ")).toBe(duplicateKey("Which organelle controls the activities of the cell? Explain."));
    expect(duplicateKey("")).toBe("");
  });

  it("groups two or more non-retired items sharing a key, in order of first appearance", () => {
    const groups = duplicateGroups([
      row({ id: "a", stem: "Name the organelle that controls the cell and say why." }),
      row({ id: "b", stem: "Where is the cell wall found?" }),
      row({ id: "c", stem: "Name the organelle that controls the cell, and explain why." }),
      row({ id: "d", stem: "Where is the cell wall found?", status: "retired" }),
      row({ id: "e", stem: "Where is the cell wall found?", status: "rejected" }),
    ]);
    expect(groups).toEqual([
      { key: "name_the_organelle_that_control_the_cell_and", ids: ["a", "c"] },
      { key: "where_is_the_cell_wall_found", ids: ["b", "e"] },
    ]);
  });
});

describe("rejectedHints", () => {
  it("prefixes the member's hints with the rejected items' notes and stems, capped at 4000", () => {
    const h = rejectedHints([row({ stem: "Bad stem one", notes: "too easy" }), row({ stem: "Bad   stem\ntwo", notes: null })], "Focus on osmosis.");
    expect(h).toBe("Previously rejected items — avoid these or fix what the notes say:\n- too easy: Bad stem one\n- Bad stem two\n\nFocus on osmosis.");
    expect(rejectedHints([], "Just this.")).toBe("Just this.");
    expect(rejectedHints([], "")).toBe("");
    const long = rejectedHints(Array.from({ length: 200 }, (_, i) => row({ stem: `Stem number ${i} ${"x".repeat(60)}`, notes: "no" })), "tail");
    expect(long.length).toBeLessThanOrEqual(HINTS_MAX);
  });
});

describe("blueprint validation", () => {
  const spec = () => ({ preset: "standard", objective_ratio: 0.5, difficulty_mix: { "2": 0.3, "3": 0.5, "4": 0.2 }, count: 10, total_marks: 20 });

  it("accepts the seeded presets' shape and keeps the weights as given", () => {
    const v = validateBlueprintSpec(spec());
    expect(v.ok, v.errors.join(" | ")).toBe(true);
    if (v.ok) expect(v.spec).toEqual({ preset: "standard", objective_ratio: 0.5, difficulty_mix: { "2": 0.3, "3": 0.5, "4": 0.2 }, count: 10, total_marks: 20 });
    expect([...BLUEPRINT_PRESETS]).toEqual(["remedial", "standard", "challenge", "custom"]);
  });

  it("refuses a bad preset, a ratio outside 0..1, a mix that does not sum to 1 (±0.01), unknown difficulty keys, and out-of-range count / total_marks", () => {
    expect(validateBlueprintSpec({ ...spec(), preset: "hard" }).errors.join()).toMatch(/preset/);
    expect(validateBlueprintSpec({ ...spec(), objective_ratio: 1.2 }).errors.join()).toMatch(/objective_ratio/);
    expect(validateBlueprintSpec({ ...spec(), difficulty_mix: { "1": 0.5, "2": 0.4 } }).errors.join()).toMatch(/adds up to 0\.9/);
    expect(validateBlueprintSpec({ ...spec(), difficulty_mix: { "1": 0.5, "2": 0.495 } }).ok).toBe(true);
    expect(validateBlueprintSpec({ ...spec(), difficulty_mix: { "6": 1 } }).errors.join()).toMatch(/unknown difficulty "6"/);
    expect(validateBlueprintSpec({ ...spec(), difficulty_mix: { "1": 0 } }).errors.join()).toMatch(/at least one positive weight/);
    expect(validateBlueprintSpec({ ...spec(), difficulty_mix: { "1": -1, "2": 2 } }).errors.join()).toMatch(/non-negative/);
    expect(validateBlueprintSpec({ ...spec(), count: 0 }).errors.join()).toMatch(/count/);
    expect(validateBlueprintSpec({ ...spec(), count: 61 }).errors.join()).toMatch(/count/);
    expect(validateBlueprintSpec({ ...spec(), total_marks: 201 }).errors.join()).toMatch(/total_marks/);
    expect(validateBlueprintSpec("nope").errors).toEqual(["spec must be an object."]);
    // a zero weight on a valid key is dropped, not stored
    const z = validateBlueprintSpec({ ...spec(), difficulty_mix: { "1": 0, "2": 1 } });
    expect(z.ok && z.spec.difficulty_mix).toEqual({ "2": 1 });
  });

  it("validateBlueprint checks name, scope and min_maturity around the spec", () => {
    const ok = validateBlueprint({ name: "  Standard · 50/50  ", scope: "worksheet", min_maturity: "basic", spec: spec() });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.blueprint.name).toBe("Standard · 50/50");
    const bad = validateBlueprint({ name: "", scope: "quiz", min_maturity: "none", spec: { ...spec(), count: 0 } });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join("\n")).toMatch(/name is required/);
    expect(bad.errors.join("\n")).toMatch(/scope must be one of/);
    expect(bad.errors.join("\n")).toMatch(/min_maturity must be one of/);
    expect(bad.errors.join("\n")).toMatch(/count/);
  });
});

describe("the composer arithmetic (mirror of catalogue/composer.py)", () => {
  it("largestRemainder: floors, then hands the leftovers to the largest fractions, ties by position", () => {
    expect(largestRemainder(10, [{ key: "1", weight: 0.5 }, { key: "2", weight: 0.4 }, { key: "3", weight: 0.1 }])).toEqual({ "1": 5, "2": 4, "3": 1 });
    // 10 × {0.3, 0.5, 0.2} = 3 / 5 / 2 exactly
    expect(largestRemainder(10, [{ key: "2", weight: 0.3 }, { key: "3", weight: 0.5 }, { key: "4", weight: 0.2 }])).toEqual({ "2": 3, "3": 5, "4": 2 });
    // 7 × {0.3, 0.5, 0.2} = 2.1 / 3.5 / 1.4 → floors 2/3/1 (6), one left → the .5
    expect(largestRemainder(7, [{ key: "2", weight: 0.3 }, { key: "3", weight: 0.5 }, { key: "4", weight: 0.2 }])).toEqual({ "2": 2, "3": 4, "4": 1 });
    // a tie on the fraction goes to the EARLIER bucket: 5 × {0.5, 0.5} = 2.5 / 2.5 → 3 / 2
    expect(largestRemainder(5, [{ key: "objective", weight: 0.5 }, { key: "subjective", weight: 0.5 }])).toEqual({ objective: 3, subjective: 2 });
    // weights need not sum to 1; zero weights never receive a leftover
    expect(largestRemainder(3, [{ key: "a", weight: 0 }, { key: "b", weight: 2 }, { key: "c", weight: 2 }])).toEqual({ a: 0, b: 2, c: 1 });
    expect(largestRemainder(0, [{ key: "a", weight: 1 }])).toEqual({ a: 0 });
    expect(largestRemainder(4, [{ key: "a", weight: 0 }])).toEqual({ a: 0 });
    // the buckets always add up to the total
    for (const total of [1, 3, 9, 11, 17, 60]) {
      const r = largestRemainder(total, [{ key: "1", weight: 0.5 }, { key: "2", weight: 0.4 }, { key: "3", weight: 0.1 }]);
      expect(Object.values(r).reduce((a, b) => a + b, 0), String(total)).toBe(total);
    }
  });

  it("composePlan splits the count by objective_ratio, then each mode by difficulty_mix, listing only non-zero buckets", () => {
    const remedial5050: BlueprintSpec = { preset: "remedial", objective_ratio: 0.5, difficulty_mix: { "1": 0.5, "2": 0.4, "3": 0.1 }, count: 10, total_marks: 20 };
    // 5 objective: 2.5/2/0.5 → floors 2/2/0, two left → "1" (.5) then "3" (.5) by position
    expect(composePlan(remedial5050)).toEqual({ objective: { "1": 3, "2": 2 }, subjective: { "1": 3, "2": 2 } });
    const allObjective: BlueprintSpec = { ...remedial5050, objective_ratio: 1 };
    expect(composePlan(allObjective)).toEqual({ objective: { "1": 5, "2": 4, "3": 1 }, subjective: {} });
    const fortySixty: BlueprintSpec = { preset: "standard", objective_ratio: 0.4, difficulty_mix: { "2": 0.3, "3": 0.5, "4": 0.2 }, count: 10, total_marks: 20 };
    // 4 objective: 1.2/2/0.8 → 1/2/0 +1 → "4"; 6 subjective: 1.8/3/1.2 → 1/3/1 +1 → "2"
    expect(composePlan(fortySixty)).toEqual({ objective: { "2": 1, "3": 2, "4": 1 }, subjective: { "2": 2, "3": 3, "4": 1 } });
    // every plan fills exactly `count`
    const sum = (p: ReturnType<typeof composePlan>) => Object.values(p).flatMap((m) => Object.values(m)).reduce((a, b) => a + (b ?? 0), 0);
    for (const count of [1, 2, 7, 11, 23, 60]) expect(sum(composePlan({ ...fortySixty, count })), String(count)).toBe(count);
  });

  it("modeCounts tallies APPROVED items per mode and difficulty only", () => {
    expect(
      modeCounts([
        row({ answer_mode: "objective", difficulty: 2, status: "approved" }),
        row({ answer_mode: "objective", difficulty: 2, status: "approved" }),
        row({ answer_mode: "objective", difficulty: 2, status: "draft" }),
        row({ answer_mode: "subjective", difficulty: 3, status: "approved" }),
        row({ answer_mode: "subjective", difficulty: 9, status: "approved" }),
      ]),
    ).toEqual({ objective: { "2": 2 }, subjective: { "3": 1 } });
  });

  it("canCompose passes when every bucket is covered and lists every short bucket otherwise — never pads", () => {
    const spec: BlueprintSpec = { preset: "standard", objective_ratio: 0.5, difficulty_mix: { "2": 0.3, "3": 0.5, "4": 0.2 }, count: 10, total_marks: 20 };
    // plan: objective 1.5/2.5/1 → 1/2/1 +1 → "2"(.5) before "3"(.5) → {2:2,3:2,4:1}; same for subjective
    const enough = { objective: { "2": 2, "3": 2, "4": 1 }, subjective: { "2": 5, "3": 5, "4": 5 } };
    expect(canCompose(spec, enough)).toEqual({ ok: true, reasons: [], plan: { objective: { "2": 2, "3": 2, "4": 1 }, subjective: { "2": 2, "3": 2, "4": 1 } } });
    const short = canCompose(spec, { objective: { "2": 2, "3": 1 }, subjective: { "2": 2, "3": 2, "4": 1 } });
    expect(short.ok).toBe(false);
    expect(short.reasons).toEqual(["objective difficulty 3: need 2, have 1", "objective difficulty 4: need 1, have 0"]);
    // an oversupply elsewhere does not rescue a short bucket
    expect(canCompose(spec, { objective: { "2": 50 }, subjective: { "2": 50, "3": 50, "4": 50 } }).ok).toBe(false);
  });

  it("canCompose checks the maturity rung first when asked, and still lists the buckets", () => {
    const spec: BlueprintSpec = { preset: "challenge", objective_ratio: 1, difficulty_mix: { "3": 0.3, "4": 0.5, "5": 0.2 }, count: 10, total_marks: 20 };
    const r = canCompose(spec, { objective: {}, subjective: {} }, { have: "basic", need: "good" });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toBe("bank maturity is basic; this blueprint needs good");
    expect(r.reasons.slice(1)).toEqual(["objective difficulty 3: need 3, have 0", "objective difficulty 4: need 5, have 0", "objective difficulty 5: need 2, have 0"]);
    expect(canCompose(spec, { objective: { "3": 3, "4": 5, "5": 2 }, subjective: {} }, { have: "strong", need: "good" }).ok).toBe(true);
  });
});

describe("the questions page filters", () => {
  it("parses type / difficulty / status from searchParams, falling back on junk", () => {
    expect(parseQuestionFilters({})).toEqual({ type: "", difficulty: 0, status: "" });
    expect(parseQuestionFilters({ type: "mcq", difficulty: "3", status: "draft" })).toEqual({ type: "mcq", difficulty: 3, status: "draft" });
    expect(parseQuestionFilters({ type: "essay", difficulty: "9", status: "Approved" })).toEqual({ type: "", difficulty: 0, status: "" });
  });

  it("builds a querystring and filters the items", () => {
    const f = parseQuestionFilters({ type: "mcq" });
    expect(withQuestionFilter(f, { difficulty: 2 })).toBe("?type=mcq&difficulty=2");
    expect(withQuestionFilter(f, { type: "" })).toBe("");
    const items = [row({ id: "a", item_type: "mcq", difficulty: 2, status: "draft" }), row({ id: "b", item_type: "short_answer", difficulty: 2, status: "approved" })];
    expect(applyQuestionFilters(items, { type: "mcq", difficulty: 0, status: "" }).map((q) => q.id)).toEqual(["a"]);
    expect(applyQuestionFilters(items, { type: "", difficulty: 2, status: "approved" }).map((q) => q.id)).toEqual(["b"]);
    expect(applyQuestionFilters(items, { type: "", difficulty: 0, status: "" })).toHaveLength(2);
  });
});

describe("small helpers", () => {
  it("mmss zero-pads minutes and seconds", () => {
    expect(mmss(0)).toBe("00:00");
    expect(mmss(125)).toBe("02:05");
    expect(mmss(3600)).toBe("60:00");
    expect(mmss(null)).toBe("00:00");
  });

  it("seedOf keeps a typed whole number, draws one from the clock when blank, and refuses junk", () => {
    expect(seedOf("42")).toBe(42);
    expect(seedOf(7)).toBe(7);
    expect(seedOf("", 1000)).toBe(1000);
    expect(seedOf(undefined, 2147483648)).toBe(1);
    expect(seedOf("abc")).toBeNull();
    expect(seedOf(-1)).toBeNull();
    expect(seedOf(2147483648)).toBeNull();
  });
});
