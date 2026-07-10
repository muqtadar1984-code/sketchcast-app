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
    { id: "wire", name: "Wire loop", geometry: { kind: "rect", at: [18, 24], w: 64, h: 52, rounded: 2 }, style: { fill: "none", stroke: "#2A3340", strokeWidth: 0.8 } },
    // Two-cell battery on the left wire: alternating long-thin (+) / short-thick (−) plates.
    { id: "battery", name: "Battery", geometry: { kind: "line", from: [11, 44], to: [25, 44] }, style: { stroke: "#2A3340", strokeWidth: 0.6 }, anchors: [{ id: "c", at: [18, 50] }] },
    { id: "battery_short", name: "Battery terminal", geometry: { kind: "line", from: [15, 47.5], to: [21, 47.5] }, style: { stroke: "#2A3340", strokeWidth: 1.8 } },
    { id: "battery2", name: "Battery cell", geometry: { kind: "line", from: [11, 52], to: [25, 52] }, style: { stroke: "#2A3340", strokeWidth: 0.6 } },
    { id: "battery2_short", name: "Battery terminal", geometry: { kind: "line", from: [15, 55.5], to: [21, 55.5] }, style: { stroke: "#2A3340", strokeWidth: 1.8 } },
    // Filament lamp: glass circle + an × filament.
    { id: "bulb", name: "Bulb", geometry: { kind: "circle", c: [50, 24], r: 6.5 }, style: { fill: "#FFF6D6", stroke: "#C77F2A", strokeWidth: 0.9 }, anchors: [{ id: "c", at: [50, 24] }] },
    { id: "filament", name: "Filament", geometry: { kind: "path", d: "M45.6 19.6 L54.4 28.4 M54.4 19.6 L45.6 28.4" }, style: { stroke: "#C77F2A", strokeWidth: 0.8, fill: "none" } },
    // Switch: pivot + lever raised to a gap above the far contact (open by default).
    { id: "switch_contact", name: "Contact", geometry: { kind: "point", at: [82, 44] }, style: { fill: "#2A3340" } },
    { id: "switch_pivot", name: "Pivot", geometry: { kind: "point", at: [82, 58] }, style: { fill: "#2A3340" } },
    { id: "switch", name: "Switch", geometry: { kind: "line", from: [82, 58], to: [76, 46] }, style: { stroke: "#2A3340", strokeWidth: 1 }, anchors: [{ id: "c", at: [80, 50] }] },
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
  animation: { drawOrder: ["wire", "battery", "battery_short", "battery2", "battery2_short", "bulb", "filament", "switch_contact", "switch_pivot", "switch"] },
  renderHints: { props: ["closed"] },
  provenance: { source: "curated" },
  vqs: { approved: true, approvedBy: "arieb", golden: "phys.circuit.svg" },
};

export const PHYSICS: KnowledgeObject[] = [BLOCK, CIRCUIT];
