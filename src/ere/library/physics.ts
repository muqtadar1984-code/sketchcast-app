// Physics anchor (design §5): quantitative — coordinate frames, vectors,
// parametric motion, plots. Free-body diagrams are composed from a block +
// prim.vector (Tier-2 composition, no generation), which is the point: the
// "unknown" concept is a combination of known parts.

import type { KnowledgeObject } from "../ko/types";

/** phys.block — a labelled mass; anchors for hanging force vectors off it. */
export const BLOCK: KnowledgeObject = {
  id: "phys.block",
  name: "Block",
  subjects: ["physics"],
  tags: ["mechanics", "mass", "free-body"],
  difficulty: 1,
  tier: 1,
  parts: [
    { id: "body", name: "Mass", geometry: { kind: "rect", at: [35, 40], w: 30, h: 24, rounded: 1.5 }, style: { fill: "#EEF2F0" } },
    { id: "com", name: "Centre of mass", geometry: { kind: "point", at: [50, 52] } },
  ],
  anchors: [
    { id: "center", at: [50, 52] },
    { id: "top", at: [50, 40] },
    { id: "bottom", at: [50, 64] },
    { id: "left", at: [35, 52] },
    { id: "right", at: [65, 52] },
  ],
  states: [
    { id: "at_rest", description: "Balanced forces" },
    { id: "accelerating", description: "Net force present", partStyles: { body: { fill: "#FFF4E0" } } },
  ],
  transitions: [{ from: "at_rest", to: "accelerating", effect: "cut" }],
  animation: { drawOrder: ["body", "com"] },
  provenance: { source: "curated" },
};

/** phys.circuit — a graph of components + wires; switch/current as states. */
export const CIRCUIT: KnowledgeObject = {
  id: "phys.circuit",
  name: "Simple circuit",
  subjects: ["physics"],
  tags: ["electricity", "circuit", "graph"],
  difficulty: 3,
  tier: 1,
  parts: [
    { id: "wire", name: "Wire loop", geometry: { kind: "rect", at: [18, 24], w: 64, h: 52, rounded: 2 }, style: { fill: "none", strokeWidth: 0.7 } },
    { id: "battery", name: "Battery", geometry: { kind: "line", from: [18, 44], to: [18, 56] }, style: { strokeWidth: 1.4 }, anchors: [{ id: "c", at: [18, 50] }] },
    { id: "battery_short", name: "Battery terminal", geometry: { kind: "line", from: [15, 46], to: [15, 54] } },
    { id: "bulb", name: "Bulb", geometry: { kind: "circle", c: [50, 24], r: 6 }, style: { fill: "#FFFBEA" }, anchors: [{ id: "c", at: [50, 24] }] },
    { id: "switch", name: "Switch", geometry: { kind: "line", from: [76, 40], to: [82, 32] }, anchors: [{ id: "c", at: [80, 40] }] },
  ],
  states: [
    { id: "open", description: "Switch open — no current, bulb off", partStyles: { switch: { stroke: "#B3401F" }, bulb: { fill: "#FFFFFF" } } },
    { id: "closed", description: "Switch closed — current flows, bulb lit", partStyles: { switch: { stroke: "#0C8175" }, bulb: { fill: "#FFE9A8", stroke: "#C77F2A" } }, labels: { bulb: "lit" } },
  ],
  transitions: [{ from: "open", to: "closed", effect: "interpolate" }],
  steps: [
    {
      op: "toggle",
      description: "Open/close the switch",
      apply: (props) => {
        const closed = !(props.closed as boolean);
        return { props: { closed }, state: closed ? "closed" : "open" };
      },
    },
  ],
  animation: { drawOrder: ["wire", "battery", "battery_short", "bulb", "switch"] },
  renderHints: { props: ["closed"] },
  provenance: { source: "curated" },
};

export const PHYSICS: KnowledgeObject[] = [BLOCK, CIRCUIT];
