// SK B1 — the exporter's pure parts (tools/sk/export-lib.ts): unit derivation,
// the objective rewrite rule, node-code resolution, exercise → unit assignment,
// stamp-vs-insert, the topic_questions row shape and the auto-markable count.
import { describe, expect, it } from "vitest";
import {
  assignExerciseToUnit,
  autoMarkableShortfall,
  buildExport,
  contentHash,
  deriveBlocks,
  deriveExerciseWrites,
  deriveMaps,
  deriveUnits,
  firstClause,
  objectiveFromPurpose,
  resolveNodeCodes,
  toTopicQuestion,
  unitTitle,
  type ChapterDraft,
  type DraftExercise,
} from "../../tools/sk/export-lib";

const ITEM_A = "item:a48f35f1-5a12-44e2-851b-a27d7b7163ff";
const ITEM_B = "item:11c605d4-e276-401d-80ec-149bb220f1bc";

function draft(): ChapterDraft {
  return {
    chapter: { number: 2, title: "Seeing Cells: Microscopes and Magnification", node_codes: ["7Bs.01"] },
    work: { slug: "cells-structure-function-organisation", title: "Biology: Cells - Structure, Function and Organisation", curriculum: "cambridge_ls_science_0893" },
    plan: {
      chapter_title: "Seeing Cells: Microscopes and Magnification",
      sections: [
        {
          sid: "s1",
          heading: "Too small to see: why we need a microscope",
          purpose: "Show that all organisms are made of cells, and that cells are too small to see unaided, so a microscope is needed.",
          node_codes: ["7Bs.01"],
          source_refs: ["sec:topic:s1", "claim:topic:c1", "claim:topic:c2", ITEM_A],
        },
        {
          sid: "s2",
          heading: null,
          purpose: "Teach the names and jobs of the main parts of a light microscope, and the path of light to the eye.",
          node_codes: ["7Bs.01", "9Zz.99"],
          source_refs: ["sec:topic:s2", "claim:topic:c6", "claim:topic:c7", ITEM_B],
        },
      ],
    },
    sections: [
      {
        sid: "s1",
        heading: "Too small to see",
        blocks: [
          { type: "paragraph", text: "All living organisms are made of **cells**.", source_refs: ["claim:topic:c1"] },
          { type: "misconception", wrong: "Only animals and plants are made of cells.", right: "All living organisms are.", source_refs: ["misc:topic:m1"] },
        ],
      },
      { sid: "s2", heading: "Parts of a light microscope", blocks: [{ type: "key_idea", text: "Each part has a job.", source_refs: null }] },
      { sid: "s9", heading: "Not in the plan", blocks: [{ type: "paragraph", text: "orphan" }] },
    ],
    exercises: [
      { xid: "x1", tier: "guided", item_type: "mcq", stem: "Which statement is correct?", options: ["Only plants.", "All organisms.", "Neither."], answer: "b", marking_scheme: [{ point: "Selects B", marks: 1 }], marks: 1, source_item_id: ITEM_A, source_refs: ["claim:topic:c1", ITEM_A] },
      { xid: "x2", tier: "guided", item_type: "match", stem: "Match each part to its job.", pairs: [{ left: "Stage", right: "Holds the slide" }], answer: "Stage – holds the slide", marks: 1, source_item_id: ITEM_B, source_refs: ["claim:topic:c7", ITEM_B] },
      { xid: "x3", tier: "independent", item_type: "fill_blank", stem: "The ____ supports the slide.", answer: "stage", marks: 1, source_refs: ["claim:topic:c6"] },
      { xid: "x4", tier: "challenge", item_type: "short_answer", stem: "Explain why cells cannot be seen unaided.", answer: "They are smaller than 0.1 mm.", marks: 2, source_refs: ["claim:topic:c2", "claim:topic:c7"] },
      { xid: "x5", tier: "independent", item_type: "short_answer", stem: "No refs at all.", answer: "none", marks: 1, source_refs: [] },
    ],
  };
}

describe("units", () => {
  it("derives one unit per plan section, u1…uN in plan order", () => {
    const units = deriveUnits(draft());
    expect(units.map((u) => [u.unit_key, u.section_sid, u.sort_order])).toEqual([
      ["u1", "s1", 1],
      ["u2", "s2", 2],
    ]);
    expect(units[0].title).toBe("Too small to see: why we need a microscope"); // plan heading wins
    expect(units[1].title).toBe("Parts of a light microscope"); // falls back to the manuscript heading
    expect(units[1].node_codes).toEqual(["7Bs.01", "9Zz.99"]);
  });

  it("falls back to the purpose's first clause, verb stripped, when no heading exists", () => {
    expect(unitTitle({ sid: "s3", purpose: "Teach the step-by-step method for focusing, starting at low power." }, null)).toBe("Step-by-step method for focusing");
    expect(unitTitle({ sid: "s4", purpose: "Show that cells are small; then move on." }, null)).toBe("Cells are small");
    expect(firstClause("A, b; c.")).toBe("A");
  });
});

describe("objective rewrite rule", () => {
  it("rewrites 'Teach how to X' → 'Students can X'", () => {
    expect(objectiveFromPurpose("Teach how to prepare wet mounts of onion epidermis and cheek cells.")).toBe("Students can prepare wet mounts of onion epidermis and cheek cells.");
  });
  it("rewrites 'Teach the X' → 'Students can describe X'", () => {
    expect(objectiveFromPurpose("Teach the names and jobs of the main parts of a light microscope.")).toBe("Students can describe the names and jobs of the main parts of a light microscope.");
    expect(objectiveFromPurpose("Teach total magnification (eyepiece × objective) and resolution.")).toBe("Students can describe total magnification (eyepiece × objective) and resolution.");
  });
  it("rewrites 'Show that X' → 'Students can explain that X'", () => {
    expect(objectiveFromPurpose("Show that all organisms are made of cells, so a microscope is needed.")).toBe("Students can explain that all organisms are made of cells, so a microscope is needed.");
  });
  it("drops author-facing trailing clauses (confront the myth…, ; includes the extension box…)", () => {
    expect(objectiveFromPurpose("Teach the method for focusing, using only the fine focus knob at higher power, and confront the myth that the coarse knob can be used at any power.")).toBe(
      "Students can describe the method for focusing, using only the fine focus knob at higher power.",
    );
    expect(objectiveFromPurpose("Teach resolution, and why higher magnification is not always better; includes the one optional extension box if used.")).toBe(
      "Students can describe resolution, and why higher magnification is not always better.",
    );
  });
  it("is deterministic and keeps anything else as a lower-cased clause", () => {
    expect(objectiveFromPurpose("Compare plant and animal cells")).toBe("Students can compare plant and animal cells.");
    expect(objectiveFromPurpose("  Teach   how to   draw   cells.  ")).toBe(objectiveFromPurpose("Teach how to draw cells."));
  });
});

describe("node-code resolution", () => {
  const nodes = new Map([
    ["7Bs.01", "node-1"],
    ["7Bs.02", "node-2"],
  ]);
  it("resolves known codes and reports unknown ones without inventing them", () => {
    expect(resolveNodeCodes(["7Bs.01", "9Zz.99", "7Bs.01"], nodes)).toEqual({ resolved: [{ code: "7Bs.01", id: "node-1" }], missing: ["9Zz.99"] });
  });
  it("proposes one 'supports' row at 0.5 per resolved code per unit", () => {
    const { maps, missing } = deriveMaps(deriveUnits(draft()), nodes);
    expect(maps).toEqual([
      { unit_key: "u1", code: "7Bs.01", curriculum_node_id: "node-1", relation: "supports", map_confidence: 0.5 },
      { unit_key: "u2", code: "7Bs.01", curriculum_node_id: "node-1", relation: "supports", map_confidence: 0.5 },
    ]);
    expect(missing).toEqual([{ unit_key: "u2", code: "9Zz.99" }]);
  });
});

describe("blocks", () => {
  it("keeps every block of a planned section, in order, minus source_refs, under its unit", () => {
    const blocks = deriveBlocks(draft(), deriveUnits(draft()));
    expect(blocks.map((b) => [b.section_sid, b.block_index, b.block_type, b.unit_key])).toEqual([
      ["s1", 0, "paragraph", "u1"],
      ["s1", 1, "misconception", "u1"],
      ["s2", 0, "key_idea", "u2"],
    ]);
    expect(blocks[1].body).toEqual({ wrong: "Only animals and plants are made of cells.", right: "All living organisms are." });
    expect(blocks[1].source_refs).toEqual(["misc:topic:m1"]);
    expect(blocks[2].source_refs).toEqual([]); // null refs → empty array
    expect(blocks.some((b) => b.section_sid === "s9")).toBe(false); // an unplanned section is not a unit
  });
});

describe("exercise → unit", () => {
  const d = draft();
  const units = deriveUnits(d);
  it("follows the plan section that cites the exercise's refs; an item ref outweighs claims", () => {
    expect(assignExerciseToUnit(d.exercises[0], d.plan.sections, units)).toBe("u1");
    expect(assignExerciseToUnit(d.exercises[1], d.plan.sections, units)).toBe("u2");
    expect(assignExerciseToUnit(d.exercises[2], d.plan.sections, units)).toBe("u2");
  });
  it("breaks a tie towards the earlier section and leaves ref-less exercises unassigned", () => {
    expect(assignExerciseToUnit(d.exercises[3], d.plan.sections, units)).toBe("u1"); // c2 (s1) vs c7 (s2): tie → s1
    expect(assignExerciseToUnit(d.exercises[4], d.plan.sections, units)).toBeNull();
  });
  it("stamps an existing bank item and inserts the rest", () => {
    const writes = deriveExerciseWrites(d, units, new Set(["a48f35f1-5a12-44e2-851b-a27d7b7163ff"]));
    expect(writes.map((w) => [w.xid, w.action, w.source_item_id])).toEqual([
      ["x1", "stamp", "a48f35f1-5a12-44e2-851b-a27d7b7163ff"],
      ["x2", "insert", "11c605d4-e276-401d-80ec-149bb220f1bc"], // seeded from an item the target database does not have
      ["x3", "insert", null],
      ["x4", "insert", null],
      ["x5", "insert", null],
    ]);
  });
});

describe("topic_questions row", () => {
  const ctx = { slug: "cells-structure-function-organisation", chapter: 2 };
  it("shapes an mcq like the bank (keyed options, {key} answer, objective mode)", () => {
    const r = toTopicQuestion(draft().exercises[0], ctx);
    expect(r.item_type).toBe("mcq");
    expect(r.answer_mode).toBe("objective");
    expect(r.options).toEqual([
      { key: "A", text: "Only plants." },
      { key: "B", text: "All organisms." },
      { key: "C", text: "Neither." },
    ]);
    expect(r.answer).toEqual({ key: "B" });
    expect(r.difficulty).toBe(2);
    expect(r.cognitive_level).toBe("understand");
    expect(r.tags).toEqual(["sk-book", "book:cells-structure-function-organisation", "ch:2", "xid:x1", "tier:guided"]);
    expect(JSON.parse(r.notes)).toEqual({ source: "book:cells-structure-function-organisation/2/x1", source_item_id: ITEM_A, source_refs: ["claim:topic:c1", ITEM_A] });
  });
  it("shapes match, fill_blank, true_false and numeric rows", () => {
    const m = toTopicQuestion(draft().exercises[1], ctx);
    expect(m.options).toEqual({ pairs: [{ left: "Stage", right: "Holds the slide" }] });
    expect(m.answer).toEqual({ pairs: [{ left: "Stage", right: "Holds the slide" }] });
    const f = toTopicQuestion(draft().exercises[2], ctx);
    expect(f.answer).toEqual({ text: "stage" });
    expect(f.difficulty).toBe(3);
    const tf: DraftExercise = { xid: "t", tier: "guided", item_type: "true_false", stem: "Cells are small.", answer: "True", marks: 1 };
    expect(toTopicQuestion(tf, ctx).answer).toEqual({ value: true });
    const num: DraftExercise = { xid: "n", tier: "challenge", item_type: "numeric", stem: "48 ÷ 800 = ?", answer: "0.06 mm", marks: 2 };
    const n = toTopicQuestion(num, ctx);
    expect(n.item_type).toBe("numerical");
    expect(n.answer_mode).toBe("subjective"); // the bank keeps numerical as subjective (prod rows)
    expect(n.cognitive_level).toBe("analyse");
    expect(n.marks).toBe(2);
  });
  it("refuses an item type the bank cannot hold", () => {
    expect(() => toTopicQuestion({ xid: "z", item_type: "essay", stem: "x", answer: "y" }, ctx)).toThrow(/essay/);
  });
  it("hashes deterministically on type + stem + answer", () => {
    expect(contentHash("mcq", "Which?", { key: "B" })).toBe(contentHash("mcq", "  Which?  ", { key: "B" }));
    expect(contentHash("mcq", "Which?", { key: "B" })).not.toBe(contentHash("mcq", "Which?", { key: "C" }));
    expect(contentHash("mcq", "Which?", { key: "B" })).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("auto-markable shortfall", () => {
  it("counts mcq/true_false/fill_blank/match/numeric per unit and reports the gap to 3", () => {
    const d = draft();
    const units = deriveUnits(d);
    const writes = deriveExerciseWrites(d, units, new Set());
    expect(autoMarkableShortfall(units, writes)).toEqual([
      { unit_key: "u1", auto_markable: 1, needed: 2, xids: ["x1"] },
      { unit_key: "u2", auto_markable: 2, needed: 1, xids: ["x2", "x3"] },
    ]);
  });
});

describe("buildExport", () => {
  it("assembles the whole plan", () => {
    const plan = buildExport(draft(), { nodesByCode: new Map([["7Bs.01", "node-1"]]), existingQuestionIds: new Set() }, "ch02-draft@abc1234");
    expect(plan.chapter).toBe(2);
    expect(plan.product).toEqual({
      slug: "cells-structure-function-organisation",
      title: "Biology: Cells - Structure, Function and Organisation",
      subject: "Biology",
      curriculum_code: "cambridge_ls_science_0893",
      languages: ["en"],
      manuscript_version: "ch02-draft@abc1234",
    });
    expect(plan.units).toHaveLength(2);
    expect(plan.objectives.map((o) => o.unit_key)).toEqual(["u1", "u2"]);
    expect(plan.maps).toHaveLength(2);
    expect(plan.missingCodes).toEqual([{ unit_key: "u2", code: "9Zz.99" }]);
    expect(plan.blocks).toHaveLength(3);
    expect(plan.exercises).toHaveLength(5);
    expect(plan.shortfall.map((s) => s.needed)).toEqual([2, 1]);
  });
});
