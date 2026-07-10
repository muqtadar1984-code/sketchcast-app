// Scene-graph core types — the board's single source of truth. Geometry is
// LOGICAL, never pixels: renderers project it into their medium (SVG viewBox
// today; 3D transforms or AR anchors later). This file is the stable contract;
// extend it additively.

/** Semantic screen regions a renderer maps into its medium. */
export type Region =
  | "center"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/**
 * A logical, resolvable position — the single rule that keeps TAL
 * renderer-agnostic (see design §2.4). Priority order: relativeTo > region >
 * coord > flow. `coord` is a 0–100 grid, NOT pixels.
 */
export type LogicalPos =
  | { relativeTo: { id: string; anchor?: string; offset?: [number, number] } }
  | { region: Region }
  | { coord: [number, number] }
  | { flow: `below:${string}` | `right:${string}` | `above:${string}` | `left:${string}` };

/** Visual styling hints. Renderers interpret; the engine never assumes pixels. */
export type Style = {
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  opacity?: number;
  dashed?: boolean;
  fontSize?: number; // logical units (0–100 grid)
};

export type NodeKind = "object" | "primitive" | "group" | "arrow" | "connection" | "label";

/** Who mutated the board, and when — the substrate for assessment and replay. */
export type Provenance = {
  turn: number;
  actor: "tutor" | "student" | "system";
  actionId?: string;
};

/**
 * One node in the scene graph. `parts` gives knowledge objects internal,
 * addressable structure (`h.right_atrium`); part nodes carry their own logical
 * geometry copied from the KO definition at instantiation time.
 */
export type SceneNode = {
  id: string;
  kind: NodeKind;
  ref?: string; // library id when object/primitive ("bio.heart", "prim.arrow")
  parts?: SceneNode[];
  transform: { at: LogicalPos; scale?: number; rotate?: number; z?: number };
  state?: string; // current named KO state
  props?: Record<string, unknown>; // instance data (array values, vector magnitude…)
  style?: Style;
  visible: boolean; // placed-but-not-drawn nodes exist with visible=false
  /** Geometry for PART nodes and primitives (logical units). Objects compose parts. */
  geometry?: PrimitiveGeometry;
  /** Named anchor points (local 0–100 space) for relative positioning. */
  anchors?: Anchor[];
  meta: { subject?: string; tags?: string[]; label?: string };
  provenance: Provenance;
};

/**
 * The primitive kit's geometry payloads (design §4.2). Every renderer must be
 * able to draw these; Tier-2 composition builds "unknown" concepts out of them.
 * All coordinates are in the local 0–100 space of the owning object.
 */
export type PrimitiveGeometry =
  | { kind: "point"; at: [number, number] }
  | { kind: "line"; from: [number, number]; to: [number, number] }
  | { kind: "polyline"; points: [number, number][] }
  // ESCAPE HATCH — SVG-renderer-specific. `d` is SVG path syntax; non-SVG
  // renderers (3D/AR) may approximate or ignore it. Curated knowledge objects
  // MUST NOT use it (they use point-based curve/polygon for renderer-agnosticism).
  | { kind: "path"; d: string }
  | { kind: "circle"; c: [number, number]; r: number }
  | { kind: "ellipse"; c: [number, number]; rx: number; ry: number }
  | { kind: "rect"; at: [number, number]; w: number; h: number; rounded?: number }
  | { kind: "polygon"; points: [number, number][] }
  | { kind: "arc"; c: [number, number]; r: number; startDeg: number; endDeg: number }
  | { kind: "arrow"; from: [number, number]; to: [number, number] }
  | { kind: "vector"; from: [number, number]; dir: [number, number]; magnitude?: string }
  | { kind: "bracket"; from: [number, number]; to: [number, number]; depth?: number }
  | { kind: "axis"; origin: [number, number]; xLen: number; yLen: number; xLabel?: string; yLabel?: string }
  | { kind: "grid"; at: [number, number]; w: number; h: number; step: number }
  | { kind: "curve"; points: [number, number][] } // smooth plot through points
  | { kind: "marker"; at: [number, number]; glyph?: string }
  | { kind: "text"; at: [number, number]; text: string };

/** A named anchor point on an object/part, in its local 0–100 space. */
export type Anchor = { id: string; at: [number, number] };
