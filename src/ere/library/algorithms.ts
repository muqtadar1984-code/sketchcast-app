// Algorithms anchor (design §5): abstract discrete structures — addressable
// elements, pointers, step-wise state, ZERO realism. This is where dynamicParts
// + semantic steps (compare/swap) shine: the board's state IS the data, and a
// `step` mutates instance props that re-derive the drawn cells on fold.

import type { KnowledgeObject, Part } from "../ko/types";

const CELL_W = 16;
const CELL_H = 16;
const GAP = 2;

/** algo.array — indexed cells from props.values; compare/swap/set-pointer steps.
 * Cells and the pointer are addressable as arr[0], arr.ptr, etc. */
export const ARRAY: KnowledgeObject = {
  id: "algo.array",
  name: "Array",
  subjects: ["algorithms", "computer science"],
  tags: ["data-structure", "indexed", "sorting"],
  difficulty: 2,
  tier: 1,
  parts: [], // fully dynamic — the array's contents are its structure
  dynamicParts: (props): Part[] => {
    const values = Array.isArray(props.values) ? (props.values as number[]) : [];
    const compared = new Set((props.compared as number[]) ?? []);
    const n = values.length || 1;
    const totalW = n * CELL_W + (n - 1) * GAP;
    const x0 = 50 - totalW / 2;
    const parts: Part[] = [];
    values.forEach((v, i) => {
      const x = x0 + i * (CELL_W + GAP);
      const highlighted = compared.has(i);
      parts.push({
        id: String(i), // addressable as arr[0]
        name: `cell ${i}`,
        geometry: { kind: "rect", at: [x, 42], w: CELL_W, h: CELL_H, rounded: 1 },
        style: highlighted ? { fill: "#FFF1CC", stroke: "#C77F2A", strokeWidth: 0.8 } : { fill: "#F4F6F3" },
        anchors: [{ id: "c", at: [x + CELL_W / 2, 42 + CELL_H / 2] }],
      });
      parts.push({ id: `v${i}`, geometry: { kind: "text", at: [x + CELL_W / 2, 42 + CELL_H / 2 + 2], text: String(v) }, style: { fontSize: 5 } });
      parts.push({ id: `i${i}`, geometry: { kind: "text", at: [x + CELL_W / 2, 38], text: String(i) }, style: { fontSize: 2.6, fill: "#98A0A9" } });
    });
    const ptr = props.pointer as number | undefined;
    if (ptr !== undefined && ptr >= 0 && ptr < n) {
      const x = x0 + ptr * (CELL_W + GAP) + CELL_W / 2;
      parts.push({ id: "ptr", name: "pointer", geometry: { kind: "marker", at: [x, 63], glyph: "▲" }, style: { fill: "#0C8175" } });
    }
    return parts;
  },
  states: [
    { id: "unsorted", description: "Initial order" },
    { id: "sorting", description: "Mid-sort" },
    { id: "sorted", description: "Fully sorted" },
  ],
  transitions: [
    { from: "unsorted", to: "sorting", effect: "cut" },
    { from: "sorting", to: "sorted", effect: "cut" },
  ],
  steps: [
    {
      op: "compare",
      description: "Highlight two cells being compared",
      apply: (_props, args) => ({ props: { compared: [Number(args?.i ?? 0), Number(args?.j ?? 1)] }, state: "sorting", emphasize: [] }),
    },
    {
      op: "swap",
      description: "Swap two cells",
      apply: (props, args) => {
        const values = [...((props.values as number[]) ?? [])];
        const i = Number(args?.i ?? 0);
        const j = Number(args?.j ?? 1);
        if (i >= 0 && j >= 0 && i < values.length && j < values.length) {
          const tmp = values[i]!;
          values[i] = values[j]!;
          values[j] = tmp;
        }
        return { props: { values, compared: [] } };
      },
    },
    {
      op: "set_pointer",
      description: "Move the pointer to an index",
      apply: (_props, args) => ({ props: { pointer: Number(args?.i ?? 0) } }),
    },
    { op: "mark_sorted", description: "Mark the array sorted", apply: () => ({ props: { compared: [] }, state: "sorted" }) },
  ],
  animation: { drawOrder: ["*"] },
  renderHints: { props: ["values", "pointer", "compared"] },
  provenance: { source: "curated" },
};

/** algo.bst — nodes + edges from props.nodes; visit/insert steps. */
export const BST: KnowledgeObject = {
  id: "algo.bst",
  name: "Binary search tree",
  subjects: ["algorithms", "computer science"],
  tags: ["data-structure", "tree", "traversal"],
  difficulty: 3,
  tier: 1,
  parts: [],
  dynamicParts: (props): Part[] => {
    // nodes: [{ id, value, x, y }], edges: [[fromId, toId]]
    const nodes = (props.nodes as { id: string; value: number; x: number; y: number }[]) ?? [];
    const edges = (props.edges as [string, string][]) ?? [];
    const visited = new Set((props.visited as string[]) ?? []);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const parts: Part[] = [];
    for (const [a, b] of edges) {
      const na = byId.get(a);
      const nb = byId.get(b);
      if (na && nb) parts.push({ id: `e_${a}_${b}`, geometry: { kind: "line", from: [na.x, na.y], to: [nb.x, nb.y] }, style: { strokeWidth: 0.5 } });
    }
    for (const n of nodes) {
      const hot = visited.has(n.id);
      parts.push({ id: n.id, name: `node ${n.value}`, geometry: { kind: "circle", c: [n.x, n.y], r: 6 }, style: hot ? { fill: "#FFF1CC", stroke: "#C77F2A" } : { fill: "#F4F6F3" }, anchors: [{ id: "c", at: [n.x, n.y] }] });
      parts.push({ id: `v_${n.id}`, geometry: { kind: "text", at: [n.x, n.y + 2], text: String(n.value) }, style: { fontSize: 4 } });
    }
    return parts;
  },
  states: [{ id: "idle", description: "Static tree" }, { id: "traversing", description: "A traversal in progress" }],
  transitions: [{ from: "idle", to: "traversing", effect: "cut" }],
  steps: [
    {
      op: "visit",
      description: "Mark a node visited",
      apply: (props, args) => {
        const visited = [...((props.visited as string[]) ?? [])];
        const id = String(args?.id ?? "");
        if (id && !visited.includes(id)) visited.push(id);
        return { props: { visited }, state: "traversing" };
      },
    },
  ],
  animation: { drawOrder: ["*"] },
  renderHints: { props: ["nodes", "edges", "visited"] },
  provenance: { source: "curated" },
};

export const ALGORITHMS: KnowledgeObject[] = [ARRAY, BST];
