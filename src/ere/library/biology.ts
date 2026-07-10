// Biology anchor (design §5): structured part-whole pictorial diagrams +
// process/state animation. Stresses named sub-parts (`h.right_atrium`), named
// states (diastole/systole, blood-flow stages), and semantic steps (advance_flow).

import type { KnowledgeObject } from "../ko/types";

/** bio.heart — chambers + valves as addressable parts; flow as stepped states. */
export const HEART: KnowledgeObject = {
  id: "bio.heart",
  name: "Heart",
  subjects: ["biology"],
  tags: ["circulatory", "organ", "pumping"],
  difficulty: 3,
  tier: 1,
  parts: [
    // Renderer-agnostic heart silhouette as logical points (no SVG-path syntax).
    { id: "outline", name: "Heart outline", geometry: { kind: "curve", points: [[50, 30], [40, 20], [26, 16], [14, 26], [14, 40], [26, 58], [50, 86], [74, 58], [86, 40], [86, 26], [74, 16], [60, 20], [50, 30]] }, style: { stroke: "#B3401F", strokeWidth: 0.8 } },
    { id: "septum", name: "Septum", geometry: { kind: "line", from: [50, 24], to: [50, 84] }, style: { dashed: true, strokeWidth: 0.5 } },
    { id: "right_atrium", name: "Right atrium", geometry: { kind: "ellipse", c: [34, 40], rx: 12, ry: 9 }, anchors: [{ id: "c", at: [34, 40] }] },
    { id: "right_ventricle", name: "Right ventricle", geometry: { kind: "ellipse", c: [36, 64], rx: 13, ry: 12 }, anchors: [{ id: "c", at: [36, 64] }] },
    { id: "left_atrium", name: "Left atrium", geometry: { kind: "ellipse", c: [66, 40], rx: 12, ry: 9 }, anchors: [{ id: "c", at: [66, 40] }] },
    { id: "left_ventricle", name: "Left ventricle", geometry: { kind: "ellipse", c: [64, 64], rx: 13, ry: 12 }, anchors: [{ id: "c", at: [64, 64] }] },
    { id: "tricuspid", name: "Tricuspid valve", geometry: { kind: "line", from: [28, 52], to: [44, 52] }, hiddenByDefault: true },
    { id: "mitral", name: "Mitral valve", geometry: { kind: "line", from: [56, 52], to: [72, 52] }, hiddenByDefault: true },
  ],
  states: [
    {
      id: "flow.deox_enters_ra",
      description: "Deoxygenated blood enters the right atrium",
      partStyles: { right_atrium: { fill: "#CFE3FF", stroke: "#2B6CB0" } },
      labels: { right_atrium: "O₂-poor blood in" },
    },
    {
      id: "flow.ra_to_rv",
      description: "Blood moves right atrium → right ventricle",
      partStyles: { right_ventricle: { fill: "#CFE3FF", stroke: "#2B6CB0" } },
      visibleParts: ["outline", "septum", "right_atrium", "right_ventricle", "left_atrium", "left_ventricle", "tricuspid"],
      labels: { right_ventricle: "to lungs →" },
    },
    {
      id: "flow.oxygenated_return",
      description: "Oxygenated blood returns to the left side",
      partStyles: { left_atrium: { fill: "#FFD6D6", stroke: "#C53030" }, left_ventricle: { fill: "#FFD6D6", stroke: "#C53030" } },
      labels: { left_ventricle: "O₂-rich → body" },
    },
    { id: "diastole", description: "Chambers relax and fill" },
    { id: "systole", description: "Chambers contract and pump", partStyles: { left_ventricle: { fill: "#FFE0E0" }, right_ventricle: { fill: "#E0ECFF" } } },
  ],
  transitions: [
    { from: "*", to: "flow.deox_enters_ra", effect: "flow" },
    { from: "flow.deox_enters_ra", to: "flow.ra_to_rv", effect: "flow" },
    { from: "flow.ra_to_rv", to: "flow.oxygenated_return", effect: "flow" },
    { from: "diastole", to: "systole", effect: "interpolate", durationSec: 1.2 },
  ],
  steps: [
    {
      op: "advance_flow",
      description: "Advance blood flow one stage through the heart",
      apply: (props, _args, state) => {
        const order = ["flow.deox_enters_ra", "flow.ra_to_rv", "flow.oxygenated_return"];
        // Advance from wherever the board actually is (state OR the counter), so a
        // prior set_state can't be regressed by the next step.
        const cur = Math.max(state ? order.indexOf(state) : -1, (props.flowStage as number) ?? -1);
        const next = Math.min(order.length - 1, cur + 1);
        return { props: { flowStage: next }, state: order[next], emphasize: [] };
      },
    },
  ],
  animation: { drawOrder: ["outline", "septum", "right_atrium", "left_atrium", "right_ventricle", "left_ventricle", "tricuspid", "mitral"], strokeSecPerPart: 0.4 },
  renderHints: { props: ["flowStage"] },
  provenance: { source: "curated" },
};

/** bio.animal_cell — organelles as parts; mitosis phases as states. */
export const ANIMAL_CELL: KnowledgeObject = {
  id: "bio.animal_cell",
  name: "Animal cell",
  subjects: ["biology"],
  tags: ["cell", "organelle", "mitosis"],
  difficulty: 2,
  tier: 1,
  parts: [
    { id: "membrane", name: "Cell membrane", geometry: { kind: "ellipse", c: [50, 50], rx: 46, ry: 38 } },
    { id: "cytoplasm", name: "Cytoplasm", geometry: { kind: "ellipse", c: [50, 50], rx: 44, ry: 36 }, style: { fill: "#F3FAF7", stroke: "none" } },
    { id: "nucleus", name: "Nucleus", geometry: { kind: "circle", c: [50, 50], r: 13 }, style: { fill: "#E7DAF5", stroke: "#7C4DB8" }, anchors: [{ id: "c", at: [50, 50] }] },
    { id: "nucleolus", name: "Nucleolus", geometry: { kind: "circle", c: [50, 50], r: 4 }, style: { fill: "#7C4DB8", stroke: "none" } },
    { id: "mitochondria", name: "Mitochondrion", geometry: { kind: "ellipse", c: [74, 34], rx: 9, ry: 5 }, style: { fill: "#FFE7CC", stroke: "#C77F2A" } },
    { id: "chromosomes", name: "Chromosomes", geometry: { kind: "polyline", points: [[44, 50], [48, 46], [48, 54], [52, 46], [52, 54], [56, 50]] }, hiddenByDefault: true, style: { stroke: "#C53030", strokeWidth: 0.9 } },
    { id: "spindle", name: "Spindle fibres", geometry: { kind: "line", from: [22, 50], to: [78, 50] }, hiddenByDefault: true, style: { dashed: true } },
  ],
  states: [
    { id: "interphase", description: "Normal cell; genetic material as chromatin", visibleParts: ["membrane", "cytoplasm", "nucleus", "nucleolus", "mitochondria"] },
    { id: "mitosis.prophase", description: "Chromosomes condense", visibleParts: ["membrane", "cytoplasm", "nucleus", "chromosomes", "mitochondria"], labels: { chromosomes: "chromosomes condense" } },
    { id: "mitosis.metaphase", description: "Chromosomes align on the spindle", visibleParts: ["membrane", "cytoplasm", "chromosomes", "spindle", "mitochondria"], labels: { spindle: "spindle forms" } },
    { id: "mitosis.anaphase", description: "Sister chromatids pulled apart", visibleParts: ["membrane", "cytoplasm", "chromosomes", "spindle", "mitochondria"] },
    { id: "mitosis.telophase", description: "Two nuclei reform", visibleParts: ["membrane", "cytoplasm", "nucleus", "mitochondria"] },
  ],
  transitions: [
    { from: "interphase", to: "mitosis.prophase", effect: "interpolate" },
    { from: "mitosis.prophase", to: "mitosis.metaphase", effect: "interpolate" },
    { from: "mitosis.metaphase", to: "mitosis.anaphase", effect: "interpolate" },
    { from: "mitosis.anaphase", to: "mitosis.telophase", effect: "interpolate" },
  ],
  steps: [
    {
      op: "mitose",
      description: "Advance mitosis one phase",
      apply: (props, _args, state) => {
        const phases = ["interphase", "mitosis.prophase", "mitosis.metaphase", "mitosis.anaphase", "mitosis.telophase"];
        // interphase (index 0) is the pre-step state; advance from state-or-counter.
        const cur = Math.max(state ? phases.indexOf(state) : 0, (props.phase as number) ?? 0);
        const next = Math.min(phases.length - 1, cur + 1);
        return { props: { phase: next }, state: phases[next] };
      },
    },
  ],
  animation: { drawOrder: ["membrane", "cytoplasm", "nucleus", "nucleolus", "mitochondria", "chromosomes", "spindle"], strokeSecPerPart: 0.35 },
  renderHints: { props: ["phase"] },
  provenance: { source: "curated" },
};

/** bio.plant_cell — the ANIMAL_CELL's comparison partner: rigid wall, large
 * central vacuole, chloroplasts. Mirrors the animal cell's part naming so
 * side-by-side "plant vs animal" lessons label cleanly. */
export const PLANT_CELL: KnowledgeObject = {
  id: "bio.plant_cell",
  name: "Plant cell",
  subjects: ["biology"],
  tags: ["cell", "organelle", "photosynthesis"],
  difficulty: 2,
  tier: 1,
  parts: [
    { id: "cell_wall", name: "Cell wall", geometry: { kind: "rect", at: [6, 10], w: 88, h: 80, rounded: 4 }, style: { stroke: "#3F7A3F", strokeWidth: 1.2 } },
    { id: "membrane", name: "Cell membrane", geometry: { kind: "rect", at: [9, 13], w: 82, h: 74, rounded: 3 }, style: { stroke: "#6FA96F" } },
    { id: "cytoplasm", name: "Cytoplasm", geometry: { kind: "rect", at: [10, 14], w: 80, h: 72, rounded: 3 }, style: { fill: "#F1FAF0", stroke: "none" } },
    { id: "vacuole", name: "Large vacuole", geometry: { kind: "rect", at: [26, 30], w: 48, h: 40, rounded: 6 }, style: { fill: "#DCEEFB", stroke: "#5B9BD5" }, anchors: [{ id: "c", at: [50, 50] }] },
    { id: "nucleus", name: "Nucleus", geometry: { kind: "circle", c: [24, 30], r: 10 }, style: { fill: "#E7DAF5", stroke: "#7C4DB8" }, anchors: [{ id: "c", at: [24, 30] }] },
    { id: "nucleolus", name: "Nucleolus", geometry: { kind: "circle", c: [24, 30], r: 3 }, style: { fill: "#7C4DB8", stroke: "none" } },
    { id: "chloroplasts", name: "Chloroplasts", geometry: { kind: "ellipse", c: [72, 66], rx: 7, ry: 4 }, style: { fill: "#CDEBC5", stroke: "#3F7A3F" } },
    { id: "mitochondria", name: "Mitochondrion", geometry: { kind: "ellipse", c: [70, 26], rx: 8, ry: 4.5 }, style: { fill: "#FFE7CC", stroke: "#C77F2A" } },
  ],
  states: [
    { id: "labelled", description: "All organelles visible", visibleParts: ["cell_wall", "membrane", "cytoplasm", "vacuole", "nucleus", "nucleolus", "chloroplasts", "mitochondria"] },
  ],
  transitions: [],
  animation: { drawOrder: ["cell_wall", "membrane", "cytoplasm", "vacuole", "nucleus", "nucleolus", "chloroplasts", "mitochondria"], strokeSecPerPart: 0.32 },
  provenance: { source: "curated" },
};

export const BIOLOGY: KnowledgeObject[] = [HEART, ANIMAL_CELL, PLANT_CELL];
