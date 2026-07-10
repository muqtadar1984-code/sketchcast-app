// Logical-position resolution (design §2.4). TAL and the scene graph never
// speak pixels; THIS module projects logical positions into the shared 0–100
// WORLD grid. 2D renderers consume world coords directly; a 3D/AR renderer
// would substitute its own projection of the same logical inputs.

import type { LogicalPos, Region, SceneNode } from "./types";
import type { SceneGraph } from "./graph";

/** Default footprint (world units) an object's 100×100 local box maps onto. */
export const DEFAULT_FOOTPRINT = 40;

const REGIONS: Record<Region, [number, number]> = {
  center: [50, 50],
  top: [50, 18],
  bottom: [50, 82],
  left: [18, 50],
  right: [82, 50],
  "top-left": [22, 22],
  "top-right": [78, 22],
  "bottom-left": [22, 78],
  "bottom-right": [78, 78],
};

/** Map a point in a node's LOCAL 0–100 space to world coords. */
export function worldFromLocal(node: SceneNode, center: [number, number], p: [number, number]): [number, number] {
  const scale = ((node.transform.scale ?? 1) * DEFAULT_FOOTPRINT) / 100;
  return [center[0] + (p[0] - 50) * scale, center[1] + (p[1] - 50) * scale];
}

/** Resolve a node's world CENTER (recursing through relative positions). */
export function nodeWorldCenter(graph: SceneGraph, id: string, seen: Set<string> = new Set()): [number, number] {
  const node = graph.nodes.get(id);
  if (!node || seen.has(id)) return REGIONS.center;
  seen.add(id);
  return resolveWorldPos(graph, node.transform.at, seen);
}

/** Resolve any LogicalPos to world coords on the 0–100 grid. */
export function resolveWorldPos(graph: SceneGraph, pos: LogicalPos, seen: Set<string> = new Set()): [number, number] {
  if ("coord" in pos) return pos.coord;
  if ("region" in pos) return REGIONS[pos.region] ?? REGIONS.center;
  if ("relativeTo" in pos) {
    const { id, anchor, offset } = pos.relativeTo;
    const targetCenter = nodeWorldCenter(graph, id, seen);
    let at = targetCenter;
    if (anchor) {
      const node = graph.nodes.get(id);
      const a =
        node?.anchors?.find((x) => x.id === anchor) ??
        // A part id can be used as an anchor: use the part's geometric centroid.
        partCentroidAnchor(node, anchor);
      if (node && a) at = worldFromLocal(node, targetCenter, a.at);
    }
    return [at[0] + (offset?.[0] ?? 0), at[1] + (offset?.[1] ?? 0)];
  }
  if ("flow" in pos) {
    const [dir, ref] = pos.flow.split(":") as [string, string];
    const base = nodeWorldCenter(graph, ref, seen);
    const gap = DEFAULT_FOOTPRINT * 0.85;
    if (dir === "below") return [base[0], base[1] + gap];
    if (dir === "above") return [base[0], base[1] - gap];
    if (dir === "left") return [base[0] - gap, base[1]];
    return [base[0] + gap, base[1]];
  }
  return REGIONS.center;
}

function partCentroidAnchor(node: SceneNode | undefined, partId: string): { id: string; at: [number, number] } | null {
  const part = node?.parts?.find((p) => p.id === partId);
  if (!part?.geometry) return null;
  return { id: partId, at: geometryCentroid(part.geometry) };
}

/** Centroid of a primitive geometry in local space — used for anchors,
 * label placement, and highlight targeting. */
export function geometryCentroid(g: NonNullable<SceneNode["geometry"]>): [number, number] {
  switch (g.kind) {
    case "point":
    case "marker":
    case "text":
      return g.at;
    case "line":
    case "arrow":
    case "bracket":
      return [(g.from[0] + g.to[0]) / 2, (g.from[1] + g.to[1]) / 2];
    case "vector":
      return [g.from[0] + g.dir[0] / 2, g.from[1] + g.dir[1] / 2];
    case "circle":
    case "arc":
      return g.c;
    case "ellipse":
      return g.c;
    case "rect":
      return [g.at[0] + g.w / 2, g.at[1] + g.h / 2];
    case "grid":
      return [g.at[0] + g.w / 2, g.at[1] + g.h / 2];
    case "polygon":
    case "polyline":
    case "curve": {
      const pts = g.points;
      const n = Math.max(1, pts.length);
      return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
    }
    case "axis":
      return g.origin;
    case "path":
      return [50, 50]; // paths are free-form; centroid defaults to local center
  }
}
