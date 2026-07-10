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

/** bio.animal_cell — a detailed, textbook-style cell: an organic membrane, a
 * nucleus with nucleolus, two mitochondria with cristae, rough ER, Golgi,
 * ribosomes, a lysosome, a vacuole and centrioles. Mitosis phases as states keep
 * working (the core membrane/cytoplasm/nucleus/chromosomes/spindle parts are
 * preserved). Local 0–100 space; the whole cell fills ~4–96. */
const ANIMAL_ORGANELLES = [
  "cytoplasm", "membrane", "er", "golgi", "nucleus", "nucleolus", "dna",
  "mito1", "mito1_cristae", "mito2", "mito2_cristae", "lysosome", "vacuole",
  "centriole1", "centriole2", "ribo1", "ribo2", "ribo3", "ribo4", "ribo5",
];
export const ANIMAL_CELL: KnowledgeObject = {
  id: "bio.animal_cell",
  name: "Animal cell",
  subjects: ["biology"],
  tags: ["cell", "organelle", "mitosis"],
  difficulty: 2,
  tier: 1,
  parts: [
    // Organic blob: cytoplasm fill + membrane rim share the same outline.
    { id: "cytoplasm", name: "Cytoplasm", geometry: { kind: "curve", points: [[50, 5], [70, 8], [85, 19], [93, 36], [94, 55], [86, 74], [70, 89], [50, 95], [30, 90], [14, 77], [6, 57], [7, 35], [17, 17], [34, 7], [50, 5]] }, style: { fill: "#63D6BC", stroke: "none" } },
    { id: "membrane", name: "Cell membrane", geometry: { kind: "curve", points: [[50, 5], [70, 8], [85, 19], [93, 36], [94, 55], [86, 74], [70, 89], [50, 95], [30, 90], [14, 77], [6, 57], [7, 35], [17, 17], [34, 7], [50, 5]] }, style: { fill: "none", stroke: "#2E9E86", strokeWidth: 1.1 } },
    // Rough ER — folded membrane C-loops left of the nucleus.
    { id: "er", name: "Endoplasmic reticulum", geometry: { kind: "path", d: "M22 40 Q13 50 22 60 M25 39 Q15 50 25 61 M28 40 Q19 50 28 60" }, style: { stroke: "#6E86C7", strokeWidth: 0.7, fill: "none" } },
    // Golgi — stacked flattened sacs, lower right.
    { id: "golgi", name: "Golgi apparatus", geometry: { kind: "path", d: "M58 74 Q66 69 74 74 M59 77 Q66 72 73 77 M60 80 Q66 76 72 80 M61 83 Q66 80 71 83" }, style: { stroke: "#E0706B", strokeWidth: 0.7, fill: "none" } },
    { id: "nucleus", name: "Nucleus", geometry: { kind: "circle", c: [46, 47], r: 14 }, style: { fill: "#F3B6C4", stroke: "#D2718B", strokeWidth: 0.9 }, anchors: [{ id: "c", at: [46, 47] }] },
    { id: "nucleolus", name: "Nucleolus", geometry: { kind: "circle", c: [48, 49], r: 4.5 }, style: { fill: "#C43D5F", stroke: "none" } },
    { id: "dna", name: "Chromatin", geometry: { kind: "polyline", points: [[44, 49], [46, 46], [48, 50], [50, 46], [52, 50], [54, 47]] }, style: { stroke: "#7A1F3A", strokeWidth: 0.6 } },
    { id: "mito1", name: "Mitochondrion", geometry: { kind: "ellipse", c: [72, 30], rx: 9, ry: 5 }, style: { fill: "#C9DCEC", stroke: "#6E8FB0" }, anchors: [{ id: "c", at: [72, 30] }] },
    { id: "mito1_cristae", name: "Cristae", geometry: { kind: "polyline", points: [[65, 30], [67, 27], [69, 31], [71, 27], [73, 31], [75, 27], [77, 30]] }, style: { stroke: "#E0894C", strokeWidth: 0.6 } },
    { id: "mito2", name: "Mitochondrion", geometry: { kind: "ellipse", c: [30, 73], rx: 9, ry: 5 }, style: { fill: "#C9DCEC", stroke: "#6E8FB0" } },
    { id: "mito2_cristae", name: "Cristae", geometry: { kind: "polyline", points: [[23, 73], [25, 70], [27, 74], [29, 70], [31, 74], [33, 70], [35, 73]] }, style: { stroke: "#E0894C", strokeWidth: 0.6 } },
    { id: "lysosome", name: "Lysosome", geometry: { kind: "circle", c: [26, 32], r: 4 }, style: { fill: "#F4C542", stroke: "#C99A1E" }, anchors: [{ id: "c", at: [26, 32] }] },
    { id: "vacuole", name: "Vacuole", geometry: { kind: "ellipse", c: [78, 58], rx: 6, ry: 5 }, style: { fill: "#F3B4C6", stroke: "#D98CA6" }, anchors: [{ id: "c", at: [78, 58] }] },
    { id: "centriole1", name: "Centriole", geometry: { kind: "rect", at: [20, 56], w: 3, h: 8, rounded: 1 }, style: { fill: "#DA4A3F", stroke: "#A82D25" } },
    { id: "centriole2", name: "Centriole", geometry: { kind: "rect", at: [24, 58], w: 8, h: 3, rounded: 1 }, style: { fill: "#DA4A3F", stroke: "#A82D25" } },
    { id: "ribo1", name: "Ribosome", geometry: { kind: "point", at: [38, 30] }, style: { fill: "#3B4B66" } },
    { id: "ribo2", name: "Ribosome", geometry: { kind: "point", at: [58, 34] }, style: { fill: "#3B4B66" } },
    { id: "ribo3", name: "Ribosome", geometry: { kind: "point", at: [66, 52] }, style: { fill: "#3B4B66" } },
    { id: "ribo4", name: "Ribosome", geometry: { kind: "point", at: [44, 68] }, style: { fill: "#3B4B66" } },
    { id: "ribo5", name: "Ribosome", geometry: { kind: "point", at: [55, 62] }, style: { fill: "#3B4B66" } },
    { id: "chromosomes", name: "Chromosomes", geometry: { kind: "polyline", points: [[42, 47], [46, 43], [46, 51], [50, 43], [50, 51], [54, 47]] }, hiddenByDefault: true, style: { stroke: "#C53030", strokeWidth: 0.9 } },
    { id: "spindle", name: "Spindle fibres", geometry: { kind: "line", from: [20, 47], to: [72, 47] }, hiddenByDefault: true, style: { dashed: true } },
  ],
  states: [
    { id: "interphase", description: "Normal cell; genetic material as chromatin", visibleParts: [...ANIMAL_ORGANELLES] },
    { id: "mitosis.prophase", description: "Chromosomes condense", visibleParts: ["cytoplasm", "membrane", "nucleus", "chromosomes", "mito1", "mito1_cristae", "mito2", "mito2_cristae"], labels: { chromosomes: "chromosomes condense" } },
    { id: "mitosis.metaphase", description: "Chromosomes align on the spindle", visibleParts: ["cytoplasm", "membrane", "chromosomes", "spindle", "mito1", "mito2"], labels: { spindle: "spindle forms" } },
    { id: "mitosis.anaphase", description: "Sister chromatids pulled apart", visibleParts: ["cytoplasm", "membrane", "chromosomes", "spindle", "mito1", "mito2"] },
    { id: "mitosis.telophase", description: "Two nuclei reform", visibleParts: ["cytoplasm", "membrane", "nucleus", "mito1", "mito2"] },
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
  animation: { drawOrder: [...ANIMAL_ORGANELLES], strokeSecPerPart: 0.18 },
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
    // Rigid wall band + membrane + cytoplasm.
    { id: "cell_wall", name: "Cell wall", geometry: { kind: "rect", at: [6, 8], w: 88, h: 84, rounded: 5 }, style: { fill: "#B7D99F", stroke: "#3F7A3F", strokeWidth: 1.3 } },
    { id: "cytoplasm", name: "Cytoplasm", geometry: { kind: "rect", at: [9, 11], w: 82, h: 78, rounded: 4 }, style: { fill: "#EAF7E1", stroke: "none" } },
    { id: "membrane", name: "Cell membrane", geometry: { kind: "rect", at: [9, 11], w: 82, h: 78, rounded: 4 }, style: { fill: "none", stroke: "#6FA96F", strokeWidth: 0.6 } },
    // Large central vacuole pushes everything to the rim.
    { id: "vacuole", name: "Large vacuole", geometry: { kind: "rect", at: [27, 27], w: 46, h: 47, rounded: 10 }, style: { fill: "#CFE7F7", stroke: "#7FB4D8", strokeWidth: 0.7 }, anchors: [{ id: "c", at: [50, 50] }] },
    { id: "nucleus", name: "Nucleus", geometry: { kind: "circle", c: [20, 25], r: 9 }, style: { fill: "#F3B6C4", stroke: "#D2718B", strokeWidth: 0.9 }, anchors: [{ id: "c", at: [20, 25] }] },
    { id: "nucleolus", name: "Nucleolus", geometry: { kind: "circle", c: [20, 25], r: 3 }, style: { fill: "#C43D5F", stroke: "none" } },
    { id: "chloro1", name: "Chloroplast", geometry: { kind: "ellipse", c: [80, 30], rx: 7, ry: 4.5 }, style: { fill: "#77C265", stroke: "#3F7A3F" }, anchors: [{ id: "c", at: [80, 30] }] },
    { id: "grana1", name: "Grana", geometry: { kind: "path", d: "M77 30 h6 M77 28.4 h6 M77 31.6 h6" }, style: { stroke: "#2E6B2E", strokeWidth: 0.5, fill: "none" } },
    { id: "chloro2", name: "Chloroplast", geometry: { kind: "ellipse", c: [81, 55], rx: 7, ry: 4.5 }, style: { fill: "#77C265", stroke: "#3F7A3F" } },
    { id: "grana2", name: "Grana", geometry: { kind: "path", d: "M78 55 h6 M78 53.4 h6 M78 56.6 h6" }, style: { stroke: "#2E6B2E", strokeWidth: 0.5, fill: "none" } },
    { id: "chloro3", name: "Chloroplast", geometry: { kind: "ellipse", c: [48, 82], rx: 7, ry: 4.5 }, style: { fill: "#77C265", stroke: "#3F7A3F" } },
    { id: "chloro4", name: "Chloroplast", geometry: { kind: "ellipse", c: [22, 62], rx: 7, ry: 4.5 }, style: { fill: "#77C265", stroke: "#3F7A3F" } },
    { id: "mito", name: "Mitochondrion", geometry: { kind: "ellipse", c: [72, 82], rx: 6.5, ry: 4 }, style: { fill: "#C9DCEC", stroke: "#6E8FB0" }, anchors: [{ id: "c", at: [72, 82] }] },
    { id: "mito_cristae", name: "Cristae", geometry: { kind: "polyline", points: [[67, 82], [69, 80], [71, 83], [73, 80], [75, 83], [77, 82]] }, style: { stroke: "#E0894C", strokeWidth: 0.5 } },
    { id: "golgi", name: "Golgi apparatus", geometry: { kind: "path", d: "M60 18 Q66 14 72 18 M61 21 Q66 17 71 21 M62 24 Q66 21 70 24" }, style: { stroke: "#E0706B", strokeWidth: 0.7, fill: "none" } },
    { id: "er", name: "Endoplasmic reticulum", geometry: { kind: "path", d: "M30 16 Q24 24 30 32 M33 16 Q26 24 33 32" }, style: { stroke: "#6E86C7", strokeWidth: 0.7, fill: "none" } },
    { id: "ribo1", name: "Ribosome", geometry: { kind: "point", at: [16, 46] }, style: { fill: "#3B4B66" } },
    { id: "ribo2", name: "Ribosome", geometry: { kind: "point", at: [44, 18] }, style: { fill: "#3B4B66" } },
    { id: "ribo3", name: "Ribosome", geometry: { kind: "point", at: [86, 44] }, style: { fill: "#3B4B66" } },
    { id: "ribo4", name: "Ribosome", geometry: { kind: "point", at: [34, 84] }, style: { fill: "#3B4B66" } },
  ],
  states: [
    {
      id: "labelled",
      description: "All organelles visible",
      visibleParts: ["cell_wall", "cytoplasm", "membrane", "vacuole", "nucleus", "nucleolus", "chloro1", "grana1", "chloro2", "grana2", "chloro3", "chloro4", "mito", "mito_cristae", "golgi", "er", "ribo1", "ribo2", "ribo3", "ribo4"],
    },
  ],
  transitions: [],
  animation: {
    drawOrder: ["cell_wall", "cytoplasm", "membrane", "vacuole", "nucleus", "nucleolus", "chloro1", "grana1", "chloro2", "grana2", "chloro3", "chloro4", "mito", "mito_cristae", "golgi", "er", "ribo1", "ribo2", "ribo3", "ribo4"],
    strokeSecPerPart: 0.16,
  },
  provenance: { source: "curated" },
};

export const BIOLOGY: KnowledgeObject[] = [HEART, ANIMAL_CELL, PLANT_CELL];
