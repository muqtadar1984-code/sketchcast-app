// SK B5 — the Supabase item bank: topic_questions rows → RawQuestion, on
// fixture rows copied from the sk-b1 branch database (Chapter 2, 2026-10-27;
// explanation / rationale / tags trimmed, nothing else changed). Also the B5
// acceptance line "deterministic grades match the quiz grader": gradeItem on a
// mapped row gives exactly what scoreQuiz gives, and stripItem leaves no key.
import { describe, expect, it } from "vitest";
import { scoreQuiz, type RawQuestion } from "@/app/api/quiz/logic";
import { gradeItem } from "../grade";
import { stripItem } from "../items";
import { selectUnitItems } from "../items-select";
import { SupabaseItemBank, toRawQuestion, type TopicQuestionRow } from "../items-supabase";
import { skFakeDb } from "./fake-supabase";

const PRODUCT = "d7a8282a-1f23-4ae8-8008-40e3ae458c13";
const SLUG = "cells-structure-function-organisation";
const O = { u1: "8d583b3b-c092-4eed-8320-58f51b6888ad", u2: "96794bf7-f582-4e14-abc7-40b86e0e4b88", u3: "8d798fea-e468-4a74-927e-7df85e71af95", u4: "d8b69af0-fe88-4275-a076-054427d7d83e", u5: "e3eaa67d-5a4f-461a-9a7e-15e6af1e700d" };

/** Rows as PostgREST returns them (the bank selects ITEM_COLUMNS). */
export const FIXTURES: TopicQuestionRow[] = [
  {
    id: "a48f35f1-5a12-44e2-851b-a27d7b7163ff",
    item_type: "mcq",
    answer_mode: "objective",
    marks: 1,
    stem: "Which statement about living organisms is correct?",
    options: [
      { key: "A", text: "Only plants and animals are made of cells." },
      { key: "B", text: "All living organisms are made of cells." },
      { key: "C", text: "Fungi and bacteria are not made of cells." },
      { key: "D", text: "Only large organisms are made of cells." },
    ],
    answer: { key: "B" },
    status: "approved",
    teaching_objective_id: O.u1,
    created_at: "2026-10-25T00:40:57.799526+00:00",
  },
  {
    id: "5788dd4a-a674-49fa-ab1d-e71d8d888c46",
    item_type: "true_false",
    answer_mode: "objective",
    marks: 1,
    stem: "A unicellular organism carries out all of its life processes within a single cell.",
    options: null,
    answer: { value: true },
    status: "approved",
    teaching_objective_id: O.u1,
    created_at: "2026-10-25T00:40:57.799526+00:00",
  },
  {
    id: "11c605d4-e276-401d-80ec-149bb220f1bc",
    item_type: "match",
    answer_mode: "objective",
    marks: 4,
    stem: "Match each microscope part to its function.",
    options: {
      pairs: [
        { left: "Eyepiece lens", right: "The lens looked through, commonly ×10" },
        { left: "Nosepiece", right: "Rotates to bring a chosen objective lens over the slide" },
        { left: "Stage clips", right: "Hold the slide in position" },
        { left: "Base", right: "Heavy foot that keeps the microscope stable" },
      ],
    },
    answer: {
      pairs: [
        { left: "Eyepiece lens", right: "The lens looked through, commonly ×10" },
        { left: "Nosepiece", right: "Rotates to bring a chosen objective lens over the slide" },
        { left: "Stage clips", right: "Hold the slide in position" },
        { left: "Base", right: "Heavy foot that keeps the microscope stable" },
      ],
    },
    status: "approved",
    teaching_objective_id: O.u2,
    created_at: "2026-10-25T00:40:57.799526+00:00",
  },
  {
    id: "a5c8ebbe-d00e-4951-81d0-b6fd3d1a55aa",
    item_type: "fill_blank",
    answer_mode: "objective",
    marks: 1,
    stem: "A thin piece of glass or plastic placed over the specimen to hold it flat and protect the objective lens is called a ____.",
    options: null,
    answer: { text: "coverslip" },
    status: "approved",
    teaching_objective_id: O.u4,
    created_at: "2026-10-25T00:40:57.799526+00:00",
  },
  {
    id: "342866a5-0c56-4787-8fcc-e340b8317ca0",
    item_type: "short_answer",
    answer_mode: "subjective",
    marks: 4,
    stem: "Describe two differences in how onion epidermal cells and human cheek cells appear under the microscope.",
    options: null,
    answer: { text: "Onion cells are regular and brick-shaped, fitting closely together, whereas cheek cells are irregular, rounded and flattened. Onion cells have a visible cell wall, but cheek cells have no cell wall, only a boundary membrane. Both show a nucleus." },
    status: "approved",
    teaching_objective_id: O.u4,
    created_at: "2026-10-25T00:40:57.799526+00:00",
  },
  {
    id: "71acf08b-bb44-4f23-a34c-018764526476",
    item_type: "mcq",
    answer_mode: "objective",
    marks: 1,
    stem: "A microscope has a ×10 eyepiece lens and a ×4 objective lens in use. What is the total magnification?",
    options: [
      { key: "A", text: "×14" },
      { key: "B", text: "×40" },
      { key: "C", text: "×6" },
      { key: "D", text: "×400" },
    ],
    answer: { key: "B" },
    status: "approved",
    teaching_objective_id: O.u5,
    created_at: "2026-10-25T00:40:57.799526+00:00",
  },
  {
    id: "1c37dd99-abb1-40f7-ac11-5d1c57f35e9a",
    item_type: "numerical",
    answer_mode: "subjective",
    marks: 3,
    stem: "A drawing of a cell is 52 mm long. The actual cell is 0.13 mm long. Calculate the magnification of the drawing.",
    options: null,
    answer: { unit: "×", value: 400, tolerance: 0 },
    status: "approved",
    teaching_objective_id: O.u5,
    created_at: "2026-10-25T00:40:58.079089+00:00",
  },
  {
    id: "906d5688-43c9-4b68-9c0a-7e9100a0dc2f",
    item_type: "numerical",
    answer_mode: "subjective",
    marks: 4,
    stem: "A student draws a cheek cell 48 mm wide at a stated magnification of ×800. Calculate the actual width of the cell in micrometres (µm).",
    options: null,
    answer: { unit: "µm", value: 60, tolerance: 0 },
    status: "approved",
    teaching_objective_id: O.u5,
    created_at: "2026-10-25T00:40:58.079089+00:00",
  },
  {
    id: "5dffb113-070a-4ed6-927f-01efbffd8bb2",
    item_type: "mcq",
    answer_mode: "objective",
    marks: 1,
    stem: "A student wants to see a cell more clearly and says that the highest magnification will always give the best view of a specimen. Which response is the most accurate?",
    options: [
      { key: "A", text: "Correct, because a bigger image is always easier to see clearly." },
      { key: "B", text: "Incorrect, because high power makes the image smaller." },
      { key: "C", text: "Correct, because the specimen never needs to be centred at high power." },
      { key: "D", text: "Incorrect, because higher power narrows the field of view and makes the image darker, so the specimen is harder to find and keep in view." },
    ],
    answer: { key: "D" },
    status: "draft",
    teaching_objective_id: O.u3,
    created_at: "2026-10-26T20:14:51.559161+00:00",
  },
];

const byId = (id: string) => FIXTURES.find((f) => f.id === id)!;

describe("toRawQuestion maps the worker's row shapes to the quiz's item type", () => {
  it("mcq: option texts in order; the keyed answer becomes the option text", () => {
    const q = toRawQuestion(byId("a48f35f1-5a12-44e2-851b-a27d7b7163ff"));
    expect(q).toEqual({ id: "a48f35f1-5a12-44e2-851b-a27d7b7163ff", type: "mcq", prompt: "Which statement about living organisms is correct?", options: ["Only plants and animals are made of cells.", "All living organisms are made of cells.", "Fungi and bacteria are not made of cells.", "Only large organisms are made of cells."], answer: "All living organisms are made of cells.", marks: 1 });
  });
  it("true_false: answer.value", () => {
    expect(toRawQuestion(byId("5788dd4a-a674-49fa-ab1d-e71d8d888c46"))).toMatchObject({ type: "true_false", answer: true, marks: 1 });
  });
  it("match: the answer's pairs", () => {
    const q = toRawQuestion(byId("11c605d4-e276-401d-80ec-149bb220f1bc"))!;
    expect(q.type).toBe("match");
    if (q.type === "match") expect(q.pairs.map((p) => p.left)).toEqual(["Eyepiece lens", "Nosepiece", "Stage clips", "Base"]);
    expect(q.marks).toBe(4);
  });
  it("fill_blank: answer.text", () => {
    expect(toRawQuestion(byId("a5c8ebbe-d00e-4951-81d0-b6fd3d1a55aa"))).toMatchObject({ type: "fill_blank", answer: "coverslip" });
  });
  it("numerical → fill_blank with the value as the key and the unit as an accepted spelling", () => {
    expect(toRawQuestion(byId("1c37dd99-abb1-40f7-ac11-5d1c57f35e9a"))).toMatchObject({ type: "fill_blank", answer: "400", accept: ["400 ×", "400×"], marks: 3 });
    expect(toRawQuestion(byId("906d5688-43c9-4b68-9c0a-7e9100a0dc2f"))).toMatchObject({ type: "fill_blank", answer: "60", accept: ["60 µm", "60µm"], marks: 4 });
  });
  it("short_answer → short (never auto-marked)", () => {
    expect(toRawQuestion(byId("342866a5-0c56-4787-8fcc-e340b8317ca0"))).toMatchObject({ type: "short", marks: 4 });
  });
  it("refuses rows it cannot grade rather than guessing", () => {
    const mcq = byId("a48f35f1-5a12-44e2-851b-a27d7b7163ff");
    expect(toRawQuestion({ ...mcq, answer: { key: "Z" } })).toBeNull(); // key not among the options
    expect(toRawQuestion({ ...mcq, options: [{ key: "A", text: "only one" }] })).toBeNull();
    expect(toRawQuestion({ ...byId("5788dd4a-a674-49fa-ab1d-e71d8d888c46"), answer: { value: "maybe" } })).toBeNull();
    expect(toRawQuestion({ ...byId("1c37dd99-abb1-40f7-ac11-5d1c57f35e9a"), answer: { value: "four hundred" } })).toBeNull();
    expect(toRawQuestion({ ...byId("11c605d4-e276-401d-80ec-149bb220f1bc"), answer: {}, options: null })).toBeNull();
    expect(toRawQuestion({ ...mcq, item_type: "diagram_label_video" })).toBeNull();
    expect(toRawQuestion({ ...mcq, stem: "  " })).toBeNull();
  });
});

describe("deterministic grades match the quiz grader (B5 acceptance)", () => {
  const key: Record<string, unknown> = {
    "a48f35f1-5a12-44e2-851b-a27d7b7163ff": "b", // a spoken/typed option letter
    "5788dd4a-a674-49fa-ab1d-e71d8d888c46": "true",
    "11c605d4-e276-401d-80ec-149bb220f1bc": ["The lens looked through, commonly ×10", "Rotates to bring a chosen objective lens over the slide", "Hold the slide in position", "Heavy foot that keeps the microscope stable"],
    "a5c8ebbe-d00e-4951-81d0-b6fd3d1a55aa": "Coverslip ",
    "71acf08b-bb44-4f23-a34c-018764526476": "×40",
    "1c37dd99-abb1-40f7-ac11-5d1c57f35e9a": "400",
    "906d5688-43c9-4b68-9c0a-7e9100a0dc2f": "60 µm",
    "5dffb113-070a-4ed6-927f-01efbffd8bb2": "D",
  };
  const wrong: Record<string, unknown> = {
    "a48f35f1-5a12-44e2-851b-a27d7b7163ff": "a",
    "5788dd4a-a674-49fa-ab1d-e71d8d888c46": "false",
    "11c605d4-e276-401d-80ec-149bb220f1bc": ["Hold the slide in position", "Hold the slide in position", "Hold the slide in position", "Hold the slide in position"],
    "a5c8ebbe-d00e-4951-81d0-b6fd3d1a55aa": "slide",
    "71acf08b-bb44-4f23-a34c-018764526476": "×14",
    "1c37dd99-abb1-40f7-ac11-5d1c57f35e9a": "0.0025",
    "906d5688-43c9-4b68-9c0a-7e9100a0dc2f": "0.06",
    "5dffb113-070a-4ed6-927f-01efbffd8bb2": "A",
  };
  for (const row of FIXTURES.filter((f) => f.item_type !== "short_answer")) {
    it(`${row.item_type} ${row.id.slice(0, 8)}: the key earns full marks, a wrong answer none, exactly as scoreQuiz says`, () => {
      const q = toRawQuestion(row)!;
      const right = gradeItem(q, key[row.id], { attemptNo: 1, hintsUsed: 0 });
      expect(right).toMatchObject({ outcome: "correct", score: q.marks, max: q.marks, independent: true, grader: "deterministic" });
      const bad = gradeItem(q, wrong[row.id], { attemptNo: 1, hintsUsed: 0 });
      expect(bad).toMatchObject({ outcome: row.item_type === "match" ? "partial" : "incorrect", independent: false });
      // The same mark the quiz paper gives (scoreQuiz is the authority; gradeItem coerces first).
      const paper = (r: unknown) => scoreQuiz([q], { [q.id]: coerce(q, r) });
      expect(right.score).toBe(paper(key[row.id]).auto);
      expect(bad.score).toBe(paper(wrong[row.id]).auto);
    });
  }
  it("a short answer is never auto-marked: needs_review, 0 marks, not independent, teacher grader", () => {
    const q = toRawQuestion(byId("342866a5-0c56-4787-8fcc-e340b8317ca0"))!;
    expect(gradeItem(q, "brick-shaped with a cell wall", { attemptNo: 1, hintsUsed: 0 })).toMatchObject({ outcome: "needs_review", score: 0, max: 4, independent: false, grader: "teacher" });
  });
  it("stripItem leaves no key on any mapped item", () => {
    for (const row of FIXTURES) {
      const s = stripItem(toRawQuestion(row)!) as Record<string, unknown>;
      expect(s).not.toHaveProperty("answer");
      expect(s).not.toHaveProperty("accept");
      expect(s).not.toHaveProperty("pairs");
      expect(JSON.stringify(s)).not.toContain('"answer"');
    }
  });
});

/** What gradeItem feeds the scorer (letters → option text, spoken booleans, match arrays). */
function coerce(q: RawQuestion, r: unknown): unknown {
  if (q.type === "mcq" && typeof r === "string" && /^[a-h]$/i.test(r.trim())) return q.options[r.trim().toLowerCase().charCodeAt(0) - 97];
  if (q.type === "true_false") return r === "true" ? true : r === "false" ? false : r;
  if (q.type === "match" && Array.isArray(r)) return Object.fromEntries(r.map((v, i) => [i, v]));
  return r;
}

describe("SupabaseItemBank", () => {
  function bank() {
    const db = skFakeDb();
    db.seed("sk_book_products", [{ id: PRODUCT, slug: SLUG, status: "draft" }]);
    db.seed(
      "teaching_objectives",
      Object.entries(O).map(([unit_key, id]) => ({ id, product_id: PRODUCT, chapter: 2, unit_key, status: "draft" })),
    );
    db.seed("topic_questions", [...FIXTURES, { ...byId("71acf08b-bb44-4f23-a34c-018764526476"), id: "99999999-9999-4999-8999-999999999999", status: "rejected" }]);
    return { db, bank: new SupabaseItemBank(db) };
  }
  it("get: approved and draft items by id; null for rejected, unknown, non-uuid or ungradeable", async () => {
    const { bank: b } = bank();
    expect((await b.get("a48f35f1-5a12-44e2-851b-a27d7b7163ff"))?.type).toBe("mcq");
    expect((await b.get("5dffb113-070a-4ed6-927f-01efbffd8bb2"))?.type).toBe("mcq"); // draft
    expect(await b.get("99999999-9999-4999-8999-999999999999")).toBeNull(); // rejected
    expect(await b.get("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await b.get("ch2-u4-c1")).toBeNull(); // the stand-in bank's ids never reach this one
    expect((await new SupabaseItemBank(bank().db, { statuses: ["approved"] }).get("5dffb113-070a-4ed6-927f-01efbffd8bb2"))).toBeNull();
  });
  it("listForUnit: product slug → objective → that unit's items, oldest first; unknown unit → []", async () => {
    const { bank: b } = bank();
    const u5 = await b.listForUnit(SLUG, 2, "u5");
    expect(u5.map((q) => q.id)).toEqual(["71acf08b-bb44-4f23-a34c-018764526476", "1c37dd99-abb1-40f7-ac11-5d1c57f35e9a", "906d5688-43c9-4b68-9c0a-7e9100a0dc2f"]);
    expect((await b.listForUnit(PRODUCT, 2, "u1")).map((q) => q.type)).toEqual(["mcq", "true_false"]);
    expect(await b.listForUnit(SLUG, 2, "u9")).toEqual([]);
    expect(await b.listForUnit("no-such-book", 2, "u1")).toEqual([]);
    expect(await b.objectiveForUnit(SLUG, 2, "u3")).toEqual({ id: O.u3, status: "draft" });
  });
  it("live fix 2026-10-27: a graph's section key (s1) resolves through sk_book_units to the exporter's unit key (u1)", async () => {
    const { db, bank: b } = bank();
    // The exporter keys objectives u1…; the packager keys the graph by manuscript section s1…; sk_book_units holds both.
    db.seed("sk_book_units", [
      { product_id: PRODUCT, chapter: 2, unit_key: "u1", section_sid: "s1", title: "Too small to see", sort_order: 1 },
      { product_id: PRODUCT, chapter: 2, unit_key: "u5", section_sid: "s5", title: "Magnification", sort_order: 5 },
    ]);
    expect(await b.objectiveForUnit(SLUG, 2, "s1")).toEqual({ id: O.u1, status: "draft" });
    expect((await b.listForUnit(SLUG, 2, "s5")).map((q) => q.id)).toEqual((await b.listForUnit(SLUG, 2, "u5")).map((q) => q.id));
    expect(await b.listForUnit(SLUG, 2, "s9")).toEqual([]); // no such section
    expect(await b.listForUnit(SLUG, 2, "u1")).toHaveLength(2); // the unit key still works directly
    // A chapter with no sk_book_units rows (older exports) behaves as before: unknown key → nothing.
    expect(await new SupabaseItemBank(bank().db).listForUnit(SLUG, 2, "s1")).toEqual([]);
  });
  it("B4.1: listForUnit carries status, difficulty and objective; selectUnitItems picks from the real rows", async () => {
    const { db, bank: b } = bank();
    db.seed("topic_questions", [{ ...byId("a48f35f1-5a12-44e2-851b-a27d7b7163ff"), id: "0afd1b8e-6f3c-4b3e-9f1a-1234567890ab", difficulty: 2, status: "draft" }]);
    const u1 = await b.listForUnit(SLUG, 2, "u1");
    expect(u1.map((q) => [q.id.slice(0, 8), q.status, q.difficulty, q.teachingObjectiveId])).toEqual([
      ["a48f35f1", "approved", undefined, O.u1],
      ["5788dd4a", "approved", undefined, O.u1],
      ["0afd1b8e", "draft", 2, O.u1],
    ]);
    expect(JSON.stringify(stripItem(u1[0]!))).not.toContain("teachingObjectiveId"); // metadata never leaves the server either
    // u5: an mcq and two numericals (→ fill_blank) — all three checkable, nothing left for practice.
    expect(selectUnitItems(await b.listForUnit(SLUG, 2, "u5"))).toMatchObject({ check: ["1c37dd99-abb1-40f7-ac11-5d1c57f35e9a", "71acf08b-bb44-4f23-a34c-018764526476", "906d5688-43c9-4b68-9c0a-7e9100a0dc2f"], practice: [] });
    // u4: one fill_blank + one short answer → no check (fewer than 2 checkable), the fill_blank practises.
    expect(selectUnitItems(await b.listForUnit(SLUG, 2, "u4"))).toMatchObject({ check: [], practice: ["a5c8ebbe-d00e-4951-81d0-b6fd3d1a55aa"] });
    // u1 with the draft row: approved first, then the draft.
    expect(selectUnitItems(u1).check).toEqual(["5788dd4a-a674-49fa-ab1d-e71d8d888c46", "a48f35f1-5a12-44e2-851b-a27d7b7163ff", "0afd1b8e-6f3c-4b3e-9f1a-1234567890ab"]);
  });
  it("objectiveFor: the item's teaching objective, null when unmapped", async () => {
    const { db, bank: b } = bank();
    db.seed("topic_questions", [{ id: "0befcb64-f7ad-4a05-a161-19dd809c7115", item_type: "short_answer", marks: 4, stem: "x", options: null, answer: { text: "y" }, status: "draft", teaching_objective_id: null }]);
    expect(await b.objectiveFor("a48f35f1-5a12-44e2-851b-a27d7b7163ff")).toBe(O.u1);
    expect(await b.objectiveFor("0befcb64-f7ad-4a05-a161-19dd809c7115")).toBeNull();
    expect(await b.objectiveFor("nope")).toBeNull();
  });
});
