// The renderer contract (design §7): a renderer is a pure function of
// (scene graph, time) that knows drawing, not education. Any medium that
// implements this interface — SVG/DOM today, 3D/AR/smartboard later, and the
// server-side raster→MP4 exporter — can execute the same TAL programs.

import type { LogicalPos } from "../scene/types";
import type { SceneNode } from "../scene/types";

export type DrawOpts = { durationSec?: number };
export type FocusOpts = { zoom?: number; region?: LogicalPos };
export type HighlightStyle = "marker" | "circle" | "underline" | "glow";
export type RemoveStyle = "erase" | "fade";

export interface Renderer {
  mount(container: unknown): void;
  place(node: SceneNode): void; // instantiate (invisible until drawn)
  draw(id: string, opts?: DrawOpts): Promise<void>; // stroke-reveal in draw order
  setState(id: string, state: string, opts?: DrawOpts): Promise<void>;
  step(id: string, op: string, args?: Record<string, unknown>): Promise<void>;
  move(id: string, to: LogicalPos, opts?: DrawOpts): Promise<void>;
  highlight(id: string | string[], style: HighlightStyle): void;
  focus(target?: string, opts?: FocusOpts): void;
  remove(id: string, style?: RemoveStyle): void;
  narrate(text: string): Promise<{ duration: number; wordTimings: number[] }>;
  now(): number;
}
