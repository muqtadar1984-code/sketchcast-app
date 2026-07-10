// The primitive kit (design §4.2) — the atomic drawables every renderer must
// support, and the alphabet Tier-2 composition writes with. Each primitive is a
// uniform one-part KnowledgeObject whose geometry derives from instance props,
// so `place prim.vector props:{dir:"down",mag:"mg"}` Just Works.

import type { KnowledgeObject, Part } from "./types";
import type { PrimitiveGeometry } from "../scene/types";

const DIRS: Record<string, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

function prim(
  id: string,
  name: string,
  build: (props: Record<string, unknown>) => Part[],
): KnowledgeObject {
  return {
    id: `prim.${id}`,
    name,
    subjects: ["*"],
    tags: ["primitive"],
    difficulty: 1,
    tier: 2,
    parts: [],
    dynamicParts: build,
    states: [],
    transitions: [],
    animation: { drawOrder: ["*"] },
    provenance: { source: "curated" },
  };
}

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const pt = (v: unknown, d: [number, number]): [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number") ? (v as [number, number]) : d;

const g = (id: string, geometry: PrimitiveGeometry, extra?: Partial<Part>): Part => ({ id, geometry, ...extra });

/** All primitives, ready to register. Geometry is in LOCAL 0–100 space. */
export const PRIMITIVES: KnowledgeObject[] = [
  prim("point", "Point", (p) => [g("dot", { kind: "point", at: pt(p.at, [50, 50]) })]),

  prim("line", "Line", (p) => [g("line", { kind: "line", from: pt(p.from, [10, 50]), to: pt(p.to, [90, 50]) })]),

  prim("polyline", "Polyline", (p) => [
    g("poly", { kind: "polyline", points: (p.points as [number, number][]) ?? [[10, 60], [50, 40], [90, 60]] }),
  ]),

  prim("path", "Path", (p) => [g("path", { kind: "path", d: str(p.d, "M 10 50 L 90 50") })]),

  prim("circle", "Circle", (p) => [g("c", { kind: "circle", c: pt(p.c, [50, 50]), r: num(p.r, 35) })]),

  prim("ellipse", "Ellipse", (p) => [
    g("e", { kind: "ellipse", c: pt(p.c, [50, 50]), rx: num(p.rx, 40), ry: num(p.ry, 25) }),
  ]),

  prim("rect", "Rectangle", (p) => [
    g("r", { kind: "rect", at: pt(p.at, [15, 25]), w: num(p.w, 70), h: num(p.h, 50), rounded: num(p.rounded, 0) }),
  ]),

  prim("polygon", "Polygon", (p) => [
    g("poly", { kind: "polygon", points: (p.points as [number, number][]) ?? [[50, 10], [90, 80], [10, 80]] }),
  ]),

  prim("arc", "Arc", (p) => [
    g("a", { kind: "arc", c: pt(p.c, [50, 50]), r: num(p.r, 35), startDeg: num(p.start, 0), endDeg: num(p.end, 180) }),
  ]),

  prim("arrow", "Arrow", (p) => [g("a", { kind: "arrow", from: pt(p.from, [10, 50]), to: pt(p.to, [90, 50]) })]),

  // vector = arrow + magnitude (design: the physics workhorse)
  prim("vector", "Vector", (p) => {
    const dir = typeof p.dir === "string" ? (DIRS[p.dir] ?? DIRS.right!) : pt(p.dir, [1, 0]);
    const len = num(p.len, 32);
    const d: [number, number] = [dir![0] * len, dir![1] * len];
    const parts: Part[] = [g("shaft", { kind: "vector", from: [50, 50], dir: d, magnitude: str(p.mag) })];
    const label = str(p.label) || str(p.mag);
    if (label) {
      parts.push(
        g("tag", { kind: "text", at: [50 + d[0] / 2 + 8, 50 + d[1] / 2], text: label }, { style: { fontSize: 4 } }),
      );
    }
    return parts;
  }),

  prim("bracket", "Bracket", (p) => [
    g("b", { kind: "bracket", from: pt(p.from, [10, 20]), to: pt(p.to, [10, 80]), depth: num(p.depth, 6) }),
  ]),

  prim("axis", "Axes", (p) => [
    g("ax", {
      kind: "axis",
      origin: pt(p.origin, [15, 85]),
      xLen: num(p.xLen, 75),
      yLen: num(p.yLen, 70),
      xLabel: str(p.xLabel, "x"),
      yLabel: str(p.yLabel, "y"),
    }),
  ]),

  prim("grid", "Grid", (p) => [
    // step clamped positive so a bad prop can never make the grid loop unbounded.
    g("grid", { kind: "grid", at: pt(p.at, [10, 10]), w: Math.max(1, num(p.w, 80)), h: Math.max(1, num(p.h, 80)), step: Math.max(0.5, num(p.step, 10)) }),
  ]),

  prim("curve", "Curve", (p) => [
    g("curve", { kind: "curve", points: (p.points as [number, number][]) ?? [[10, 80], [40, 30], [70, 55], [90, 20]] }),
  ]),

  prim("marker", "Marker", (p) => [g("m", { kind: "marker", at: pt(p.at, [50, 50]), glyph: str(p.glyph, "▲") })]),

  prim("label", "Label", (p) => [
    g("t", { kind: "text", at: pt(p.at, [50, 50]), text: str(p.text, "…") }, { style: { fontSize: num(p.size, 4) } }),
  ]),
];
