// Shared test fixtures: a three-unit graph with every asset kind the planner
// reads, plus the real U4 segment from public/.
import { readFileSync } from "node:fs";
import type { Segment } from "../board/engine";
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
        { asset_id: "u2-main", kind: "explain", style: "main", segment: "/sk-s1/u4/segment.json", segment_id: "u2-seg", validation: "pass" },
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
        { asset_id: "u4-main", kind: "explain", style: "main", segment: "/sk-s1/u4/segment.json", segment_id: "u4-explain-main-s1", clip: "/sk-s1/u4/optionS.mp4", hitmap: "/sk-s1/u4/optionS.hitmap.json", validation: "pass" },
        { asset_id: "u4-visual", kind: "alt", style: "visual", segment: "/sk-s1/u4/segment.json", segment_id: "u4-visual-seg", validation: "pass" },
        { asset_id: "u4-demo", kind: "demo", segment: "/sk-s1/u4/segment.json", segment_id: "u4-demo-seg", validation: "pass" },
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
      assets: [{ asset_id: "u5-main", kind: "explain", style: "main", segment: "/sk-s1/u4/segment.json", segment_id: "u5-seg", validation: "pass" }],
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

export const U4_SEGMENT: Segment = JSON.parse(readFileSync(new URL("../../../public/sk-s1/u4/segment.json", import.meta.url), "utf-8")) as Segment;
export const U4_HITMAP = JSON.parse(readFileSync(new URL("../../../public/sk-s1/u4/optionS.hitmap.json", import.meta.url), "utf-8")) as { elements: Record<string, unknown>; asset: Record<string, { regions: Record<string, unknown> }> };
export const U4_HITMAP_TARGETS: string[] = [
  ...Object.keys(U4_HITMAP.elements),
  ...Object.entries(U4_HITMAP.asset).flatMap(([k, a]) => [k, ...Object.keys(a.regions).map((r) => `${k}.${r}`)]),
];
