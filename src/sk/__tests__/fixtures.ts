// Shared test fixtures: a three-unit graph with every asset kind the planner
// reads, the one-unit U4 stand-in graph and the packager's Chapter 2 graph
// (both inline since S3 slice E retired the files under public/), plus the U4
// segment and hit map (./segment-fixtures).
import { parseGraph } from "../graph";
import type { BankItem } from "../items";
import type { TeachingGraph } from "../types";

export const GRAPH_JSON = {
  graph_id: "g-test",
  product_id: "test-product",
  chapter: 2,
  version: 3,
  language: "en",
  status: "draft",
  units: [
    {
      unit_key: "u2",
      teaching_objective_id: "to-u2",
      title: "Parts of a microscope",
      prereqs: [],
      order: 2,
      assets: [
        { asset_id: "u2-main", kind: "explain", style: "main", segment: "/lessons/u4/segment.json", segment_id: "u2-seg", validation: "pass" },
        { asset_id: "u2-check", kind: "check", item_ids: ["ch2-u4-c1", "ch2-u4-c2", "ch2-u4-c3"] },
      ],
      figures: ["light_microscope"],
    },
    {
      unit_key: "u4",
      teaching_objective_id: "to-u4",
      title: "Total magnification",
      prereqs: ["u2"],
      order: 4,
      assets: [
        { asset_id: "u4-main", kind: "explain", style: "main", segment: "/lessons/u4/segment.json", segment_id: "u4-explain-main-s1", clip: "/lessons/u4/optionS.mp4", hitmap: "/lessons/u4/optionS.hitmap.json", validation: "pass" },
        { asset_id: "u4-visual", kind: "alt", style: "visual", segment: "/lessons/u4/segment.json", segment_id: "u4-visual-seg", validation: "pass" },
        { asset_id: "u4-demo", kind: "demo", segment: "/lessons/u4/segment.json", segment_id: "u4-demo-seg", validation: "pass" },
        { asset_id: "u4-practice", kind: "practice", item_ids: ["ch2-u4-p1", "ch2-u4-p2"] },
        { asset_id: "u4-check", kind: "check", item_ids: ["ch2-u4-c1", "ch2-u4-c2", "ch2-u4-c3"] },
      ],
      figures: ["light_microscope"],
    },
    {
      unit_key: "u5",
      teaching_objective_id: "to-u5",
      title: "Actual size",
      prereqs: ["u4"],
      order: 5,
      assets: [{ asset_id: "u5-main", kind: "explain", style: "main", segment: "/lessons/u4/segment.json", segment_id: "u5-seg", validation: "pass" }],
      figures: [],
    },
  ],
};

export const graph = (): TeachingGraph => parseGraph(JSON.parse(JSON.stringify(GRAPH_JSON)));

/** B4.1: a unit's bank items, deliberately scrambled — the selector's order
 * (approved → draft, easy → hard, unknown difficulty last, then id) must not
 * depend on the order the bank returned them. Checkable: q-a1, q-a3, q-ax,
 * q-d2; q-un is unmapped (practice only); q-sh is a short answer (never). */
export const BANK_SCRAMBLED: BankItem[] = [
  { id: "q-d2", type: "mcq", prompt: "q-d2", options: ["a", "b"], answer: "a", marks: 1, status: "draft", difficulty: 2, teachingObjectiveId: "to-1" },
  { id: "q-a3", type: "true_false", prompt: "q-a3", answer: true, marks: 1, status: "approved", difficulty: 3, teachingObjectiveId: "to-1" },
  { id: "q-sh", type: "short", prompt: "q-sh", answer: "x", marks: 2, status: "approved", difficulty: 2, teachingObjectiveId: "to-1" },
  { id: "q-ax", type: "mcq", prompt: "q-ax", options: ["a", "b"], answer: "a", marks: 1, status: "approved", teachingObjectiveId: "to-1" },
  { id: "q-un", type: "mcq", prompt: "q-un", options: ["a", "b"], answer: "a", marks: 1, status: "approved", difficulty: 1, teachingObjectiveId: null },
  { id: "q-a1", type: "fill_blank", prompt: "q-a1", answer: "400", marks: 1, status: "approved", difficulty: 1, teachingObjectiveId: "to-1" },
];

export { U4_HITMAP, U4_HITMAP_TARGETS, U4_SEGMENT } from "./segment-fixtures";

/** The hand-written one-unit stand-in (POC): U4 with its clip, hit map,
 * practice and check items. Its product has no sk_book_products row. */
export const STANDIN_GRAPH_JSON = {
  graph_id: "graph-ch2-poc",
  product_id: "sk-poc-biology",
  chapter: 2,
  version: 1,
  language: "en",
  status: "draft",
  units: [
    {
      unit_key: "u4",
      teaching_objective_id: "to-ch2-u4-total-magnification",
      title: "Total magnification",
      prereqs: [],
      order: 4,
      assets: [
        { asset_id: "u4-explain-main", kind: "explain", style: "main", segment: "/lessons/u4/segment.json", segment_id: "u4-explain-main-s1", clip: "/lessons/u4/optionS.mp4", hitmap: "/lessons/u4/optionS.hitmap.json", origin: "prepared", validation: "pass" },
        { asset_id: "u4-practice", kind: "practice", item_ids: ["ch2-u4-p1", "ch2-u4-p2"] },
        { asset_id: "u4-check", kind: "check", item_ids: ["ch2-u4-c1", "ch2-u4-c2", "ch2-u4-c3"] },
      ],
      figures: ["light_microscope"],
    },
  ],
};
export const standinGraph = (): TeachingGraph => parseGraph(JSON.parse(JSON.stringify(STANDIN_GRAPH_JSON)));

/** The B3 packager's Chapter 2 graph for the cells book: six sections, each one
 * prepared explain asset whose paths are relative to the graph (resolved by
 * parseGraph's baseUri), each with a female and a male clip. */
const CELLS_SECTIONS: [string, string, string[]][] = [
  ["s1", "Too small to see: why we need a microscope", []],
  ["s2", "Parts of a light microscope", ["light_microscope"]],
  ["s3", "Using the microscope safely and focusing", []],
  ["s4", "Making a temporary slide", ["onion_cell_slide"]],
  ["s5", "Magnification and actual size", []],
  ["s6", "Drawing what you see", []],
];
export const CELLS_GRAPH_JSON = {
  graph_id: "cells-structure-function-organisation-ch02-v1",
  product: "cells-structure-function-organisation",
  chapter: 2,
  version: 1,
  language: "en",
  status: "draft",
  units: CELLS_SECTIONS.map(([key, title, figures], i) => ({
    unit_key: key,
    title,
    order: i,
    prereqs: i ? [CELLS_SECTIONS[i - 1]![0]] : [],
    assets: [
      {
        asset_id: `${key}-explain-main`,
        kind: "explain",
        style: "main",
        segment: `${key}/explain-main/segment.json`,
        origin: "prepared",
        clip: `${key}/explain-main/clip.mp4`,
        hitmap: `${key}/explain-main/hitmap.json`,
        clips: { female: `${key}/explain-main/clip.mp4`, male: `${key}/explain-main/clip-male.mp4` },
      },
    ],
    figures: figures.map((asset_key) => ({ ref: `fig:${asset_key}`, asset_key })),
  })),
};
/** Where the tests pretend the packaged chapter is served from. */
export const CELLS_BASE = "/lessons/ch02/";
export const cellsGraph = (): TeachingGraph => parseGraph(JSON.parse(JSON.stringify(CELLS_GRAPH_JSON)), CELLS_BASE);
