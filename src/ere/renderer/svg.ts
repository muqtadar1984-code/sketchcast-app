// The SVG renderer — a PURE function of (scene graph, time) → SVG markup
// (design §7). It knows drawing, not education: no op names, no pedagogy, just
// nodes, geometry, states and events. Determinism: same graph + same events ⇒
// byte-identical output ⇒ snapshot tests. Stroke animation uses pathLength=1
// normalisation so draw-on timing is length-agnostic.

import type { PrimitiveGeometry, SceneNode, Style } from "../scene/types";
import type { BoardEvent } from "../scene/events";
import type { SceneGraph } from "../scene/graph";
import type { Library } from "../ko/library";
import { geometryCentroid, nodeWorldCenter, resolveWorldPos, worldFromLocal, DEFAULT_FOOTPRINT } from "../scene/layout";

export type RenderOpts = {
  /** Session-clock time. Omit for the final state; provide with `animate` for a
   * board that draws itself (draw events schedule CSS stroke animations). */
  time?: number;
  animate?: boolean;
  events?: readonly BoardEvent[]; // for draw timings + transient highlights
  width?: number;
  height?: number;
  background?: string;
};

const INK = "#14181F";
const ACCENT = "#0C8175";
const MARKER_YELLOW = "#FFB020";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

type Ctx = { graph: SceneGraph; lib: Library; opts: RenderOpts };

export function renderSvg(graph: SceneGraph, lib: Library, opts: RenderOpts = {}): string {
  const ctx: Ctx = { graph, lib, opts };
  const body: string[] = [];

  for (const id of graph.order) {
    const node = graph.nodes.get(id);
    if (!node || node.kind === "group") continue;
    body.push(renderNode(ctx, node));
  }
  body.push(renderHighlights(ctx));

  const anim = opts.animate ? animationCss(ctx) : "";
  const bg = opts.background ?? "#FCFCFA";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"` +
    (opts.width ? ` width="${opts.width}"` : "") +
    (opts.height ? ` height="${opts.height}"` : "") +
    ` font-family="ui-sans-serif, system-ui, sans-serif">` +
    `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">` +
    `<path d="M 0 1 L 9 5 L 0 9 z" fill="${INK}"/></marker>${anim}</defs>` +
    `<rect x="0" y="0" width="100" height="100" fill="${bg}"/>` +
    body.join("") +
    `</svg>`
  );
}

// ── node rendering ────────────────────────────────────────────────────────────

function renderNode(ctx: Ctx, node: SceneNode): string {
  if (node.kind === "arrow" || node.kind === "connection") return renderRelation(ctx, node);
  if (!node.visible && !hasVisiblePart(node)) return "";
  const center = nodeWorldCenter(ctx.graph, node.id);

  if (node.kind === "label") {
    const at = resolveWorldPos(ctx.graph, node.transform.at);
    const g = node.geometry;
    const text = g?.kind === "text" ? g.text : (node.meta.label ?? "");
    return textEl(at, text, node.style, node.id);
  }

  // Objects/primitives: render parts in the KO's draw order, applying the
  // current state's style patches / visibility / transient state labels.
  const ko = node.ref ? ctx.lib.get(node.ref) : undefined;
  const state = node.state ? ko?.states.find((s) => s.id === node.state) : undefined;
  const ordered = orderParts(node.parts ?? [], ko?.animation.drawOrder ?? ["*"]);
  const pieces: string[] = [];
  for (const part of ordered) {
    const stateStyle = state?.partStyles?.[part.id];
    const visibleInState = state?.visibleParts ? state.visibleParts.includes(part.id) : undefined;
    const hidden = part.props?.hiddenByDefault === true && visibleInState !== true;
    const visible = visibleInState ?? part.visible;
    if (!visible || hidden || !part.geometry) continue;
    pieces.push(geometryEl(ctx, node, center, part.geometry, { ...part.style, ...stateStyle }, `${node.id}.${part.id}`));
    const stateLabel = state?.labels?.[part.id];
    if (stateLabel) {
      const at = worldFromLocal(node, center, geometryCentroid(part.geometry));
      pieces.push(textEl([at[0], at[1] - 2], stateLabel, { fontSize: 3, fill: ACCENT }, `${node.id}.${part.id}.lbl`));
    }
  }
  if (node.meta.label && node.kind === "object") {
    pieces.push(textEl([center[0], center[1] + (DEFAULT_FOOTPRINT * (node.transform.scale ?? 1)) / 2 + 4], node.meta.label, { fontSize: 3.4 }, `${node.id}.name`));
  }
  return `<g data-id="${esc(node.id)}">${pieces.join("")}</g>`;
}

function renderRelation(ctx: Ctx, node: SceneNode): string {
  if (!node.visible) return "";
  const { from, to, label } = node.props as { from: string; to: string; label?: string };
  const a = targetWorldPoint(ctx, from);
  const b = targetWorldPoint(ctx, to);
  if (!a || !b) return "";
  // shorten toward the target so arrowheads don't bury themselves in shapes
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const pad = Math.min(4, len / 4);
  const b2: [number, number] = [b[0] - (dx / len) * pad, b[1] - (dy / len) * pad];
  const head = node.kind === "arrow" ? ` marker-end="url(#arr)"` : "";
  const dash = node.kind === "connection" ? ` stroke-dasharray="2 1.4"` : "";
  const lbl = label ? textEl([(a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2 - 2], label, { fontSize: 3 }, `${node.id}.lbl`) : "";
  return (
    `<g data-id="${esc(node.id)}"><line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b2[0])}" y2="${f(b2[1])}"` +
    ` stroke="${INK}" stroke-width="0.6"${head}${dash} pathLength="1"/>${lbl}</g>`
  );
}

/** World point of a target: node center, or part centroid for "h.right_atrium". */
function targetWorldPoint(ctx: Ctx, target: string): [number, number] | null {
  const hit = ctx.graph.resolveTarget(target);
  if (!hit) return null;
  const center = nodeWorldCenter(ctx.graph, hit.node.id);
  if (hit.part?.geometry) return worldFromLocal(hit.node, center, geometryCentroid(hit.part.geometry));
  return center;
}

function hasVisiblePart(node: SceneNode): boolean {
  return (node.parts ?? []).some((p) => p.visible || hasVisiblePart(p));
}

function orderParts(parts: SceneNode[], drawOrder: string[]): SceneNode[] {
  if (drawOrder.length === 1 && drawOrder[0] === "*") return parts;
  const rank = new Map(drawOrder.map((id, i) => [id, i]));
  return [...parts].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
}

// ── geometry → SVG ────────────────────────────────────────────────────────────

function geometryEl(
  ctx: Ctx,
  node: SceneNode,
  center: [number, number],
  g: PrimitiveGeometry,
  style: Style | undefined,
  key: string,
): string {
  const W = (p: [number, number]) => worldFromLocal(node, center, p);
  const k = ((node.transform.scale ?? 1) * DEFAULT_FOOTPRINT) / 100; // local→world scale factor
  const s = strokeAttrs(style);
  const id = ` data-part="${esc(key)}" class="sk-stroke"`;

  switch (g.kind) {
    case "point": {
      const [x, y] = W(g.at);
      return `<circle${id} cx="${f(x)}" cy="${f(y)}" r="0.8" fill="${style?.fill ?? INK}" stroke="none"/>`;
    }
    case "line": {
      const [x1, y1] = W(g.from);
      const [x2, y2] = W(g.to);
      return `<line${id} x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"${s} pathLength="1"/>`;
    }
    case "polyline":
    case "polygon":
    case "curve": {
      const pts = g.points.map(W);
      if (g.kind === "curve") return `<path${id} d="${smoothPath(pts)}"${s} fill="none" pathLength="1"/>`;
      const attr = pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");
      return `<${g.kind === "polygon" ? "polygon" : "polyline"}${id} points="${attr}"${s} pathLength="1"/>`;
    }
    case "path": {
      // Path data is local: translate+scale via a transform (keeps `d` untouched).
      const [ox, oy] = W([0, 0]);
      return `<path${id} d="${esc(g.d)}" transform="translate(${f(ox)} ${f(oy)}) scale(${f(k)})"${strokeAttrs(style, 0.6 / k)} pathLength="1"/>`;
    }
    case "circle": {
      const [cx, cy] = W(g.c);
      return `<circle${id} cx="${f(cx)}" cy="${f(cy)}" r="${f(g.r * k)}"${s} pathLength="1"/>`;
    }
    case "ellipse": {
      const [cx, cy] = W(g.c);
      return `<ellipse${id} cx="${f(cx)}" cy="${f(cy)}" rx="${f(g.rx * k)}" ry="${f(g.ry * k)}"${s} pathLength="1"/>`;
    }
    case "rect": {
      const [x, y] = W(g.at);
      const r = g.rounded ? ` rx="${f(g.rounded * k)}"` : "";
      return `<rect${id} x="${f(x)}" y="${f(y)}" width="${f(g.w * k)}" height="${f(g.h * k)}"${r}${s} pathLength="1"/>`;
    }
    case "arc": {
      const [cx, cy] = W(g.c);
      const r = g.r * k;
      const rad = (d: number) => ((d - 90) * Math.PI) / 180;
      const p1 = [cx + r * Math.cos(rad(g.startDeg)), cy + r * Math.sin(rad(g.startDeg))];
      const p2 = [cx + r * Math.cos(rad(g.endDeg)), cy + r * Math.sin(rad(g.endDeg))];
      const large = Math.abs(g.endDeg - g.startDeg) > 180 ? 1 : 0;
      return `<path${id} d="M ${f(p1[0]!)} ${f(p1[1]!)} A ${f(r)} ${f(r)} 0 ${large} 1 ${f(p2[0]!)} ${f(p2[1]!)}"${s} fill="none" pathLength="1"/>`;
    }
    case "arrow":
    case "vector": {
      const from = W(g.kind === "arrow" ? g.from : g.from);
      const to = g.kind === "arrow" ? W(g.to) : W([g.from[0] + g.dir[0], g.from[1] + g.dir[1]]);
      return `<line${id} x1="${f(from[0])}" y1="${f(from[1])}" x2="${f(to[0])}" y2="${f(to[1])}"${s} marker-end="url(#arr)" pathLength="1"/>`;
    }
    case "bracket": {
      const a = W(g.from);
      const b = W(g.to);
      const d = (g.depth ?? 6) * k;
      const horiz = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
      const path = horiz
        ? `M ${f(a[0])} ${f(a[1] - d)} L ${f(a[0])} ${f(a[1])} L ${f(b[0])} ${f(b[1])} L ${f(b[0])} ${f(b[1] - d)}`
        : `M ${f(a[0] + d)} ${f(a[1])} L ${f(a[0])} ${f(a[1])} L ${f(b[0])} ${f(b[1])} L ${f(b[0] + d)} ${f(b[1])}`;
      return `<path${id} d="${path}"${s} fill="none" pathLength="1"/>`;
    }
    case "axis": {
      const o = W(g.origin);
      const xEnd = W([g.origin[0] + g.xLen, g.origin[1]]);
      const yEnd = W([g.origin[0], g.origin[1] - g.yLen]);
      return (
        `<g${id}><line x1="${f(o[0])}" y1="${f(o[1])}" x2="${f(xEnd[0])}" y2="${f(xEnd[1])}"${s} marker-end="url(#arr)" pathLength="1"/>` +
        `<line x1="${f(o[0])}" y1="${f(o[1])}" x2="${f(yEnd[0])}" y2="${f(yEnd[1])}"${s} marker-end="url(#arr)" pathLength="1"/>` +
        (g.xLabel ? textEl([xEnd[0] + 2, xEnd[1] + 2], g.xLabel, { fontSize: 3 }, `${key}.x`) : "") +
        (g.yLabel ? textEl([yEnd[0] - 2, yEnd[1] - 1], g.yLabel, { fontSize: 3 }, `${key}.y`) : "") +
        `</g>`
      );
    }
    case "grid": {
      const [x, y] = W(g.at);
      const w = g.w * k;
      const h = g.h * k;
      const step = g.step * k;
      if (step <= 0 || w <= 0 || h <= 0) return ""; // never loop unbounded (defensive; primitive also clamps)
      const lines: string[] = [];
      for (let gx = 0; gx <= w + 1e-6; gx += step)
        lines.push(`<line x1="${f(x + gx)}" y1="${f(y)}" x2="${f(x + gx)}" y2="${f(y + h)}"/>`);
      for (let gy = 0; gy <= h + 1e-6; gy += step)
        lines.push(`<line x1="${f(x)}" y1="${f(y + gy)}" x2="${f(x + w)}" y2="${f(y + gy)}"/>`);
      return `<g${id} stroke="${style?.stroke ?? "#D8DBD5"}" stroke-width="0.2">${lines.join("")}</g>`;
    }
    case "marker": {
      const [x, y] = W(g.at);
      return textEl([x, y], g.glyph ?? "▲", { fontSize: 4, fill: style?.stroke ?? MARKER_YELLOW }, key);
    }
    case "text": {
      const [x, y] = W(g.at);
      return textEl([x, y], g.text, style, key);
    }
  }
}

function strokeAttrs(style: Style | undefined, baseWidth = 0.6): string {
  const stroke = style?.stroke ?? INK;
  const width = style?.strokeWidth ?? baseWidth;
  const fill = style?.fill ?? "none";
  const dash = style?.dashed ? ` stroke-dasharray="1.6 1.2"` : "";
  const op = style?.opacity !== undefined ? ` opacity="${style.opacity}"` : "";
  return ` stroke="${stroke}" stroke-width="${width}" fill="${fill}" stroke-linecap="round" stroke-linejoin="round"${dash}${op}`;
}

function textEl(at: [number, number], text: string, style: Style | undefined, key: string): string {
  let size = style?.fontSize ?? 4;
  const fill = style?.fill ?? INK;

  // POSITION-AWARE wrapping: the usable width is how far the anchor is from the
  // nearer canvas edge (text-anchor="middle" grows both ways), so a label at
  // x=20 wraps sooner than one at x=50 — long text can never clip off-canvas
  // or run across the board into a neighbour (the "smudged text" defect).
  const avail = Math.max(24, 2 * Math.min(at[0], 100 - at[0]) - 4);
  let lines = wrapText(text, maxChars(avail, size));
  if (lines.length > 4) {
    // Too tall — one font step down, re-wrap (still capped below).
    size = Math.max(2.6, size * 0.72);
    lines = wrapText(text, maxChars(avail, size));
  }
  if (lines.length > 6) lines = [...lines.slice(0, 5), lines[5]!.replace(/\s*\S*$/, "") + "…"];

  if (lines.length === 1) {
    return `<text data-part="${esc(key)}" x="${f(at[0])}" y="${f(at[1])}" font-size="${f(size)}" fill="${fill}" text-anchor="middle">${esc(lines[0]!)}</text>`;
  }
  // Multi-line: centre the BLOCK on the anchor so labels near the bottom edge
  // don't grow past y=100.
  const lh = size * 1.15;
  const y0 = at[1] - ((lines.length - 1) / 2) * lh;
  const spans = lines
    .map((ln, i) => `<tspan x="${f(at[0])}" y="${f(y0 + i * lh)}">${esc(ln)}</tspan>`)
    .join("");
  return `<text data-part="${esc(key)}" font-size="${f(size)}" fill="${fill}" text-anchor="middle">${spans}</text>`;
}

/** Approximate character budget for one line: avg glyph width ≈ 0.55 × font size. */
function maxChars(avail: number, size: number): number {
  return Math.max(6, Math.floor(avail / (0.55 * size)));
}

/** Word-wrap honouring explicit \n (SVG collapses raw newlines to spaces, so
 * they must become real line breaks here); hard-breaks over-long words. */
function wrapText(text: string, max: number): string[] {
  const out: string[] = [];
  for (const seg of text.split("\n")) {
    let line = "";
    for (const word of seg.split(/\s+/).filter(Boolean)) {
      const w = word.length > max ? word.slice(0, max - 1) + "…" : word;
      if (!line) line = w;
      else if (line.length + 1 + w.length <= max) line += ` ${w}`;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line); // keep empty segments: "a\n\nb" preserves the gap
  }
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out.length ? out : [""];
}

function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M ${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    d += ` Q ${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` T ${f(last[0])} ${f(last[1])}`;
  return d;
}

// ── transient highlights + draw-on animation ─────────────────────────────────

function renderHighlights(ctx: Ctx): string {
  const { events, time } = ctx.opts;
  if (!events) return "";
  const active = events.filter(
    (e) => e.type === "highlight" && (time === undefined || (e.ts <= time && time < ((e.payload?.until as number) ?? e.ts + 2.5))),
  );
  const out: string[] = [];
  for (const e of active) {
    const { targets, style } = e.payload as { targets: string[]; style: string };
    for (const t of targets) {
      const p = targetWorldPoint(ctx, t);
      if (!p) continue;
      if (style === "circle" || style === "glow")
        out.push(`<ellipse cx="${f(p[0])}" cy="${f(p[1])}" rx="7" ry="5" fill="none" stroke="${MARKER_YELLOW}" stroke-width="0.9" opacity="0.9"/>`);
      else if (style === "underline")
        out.push(`<line x1="${f(p[0] - 5)}" y1="${f(p[1] + 3)}" x2="${f(p[0] + 5)}" y2="${f(p[1] + 3)}" stroke="${MARKER_YELLOW}" stroke-width="1.1" opacity="0.9"/>`);
      else
        out.push(`<rect x="${f(p[0] - 6)}" y="${f(p[1] - 4)}" width="12" height="8" fill="${MARKER_YELLOW}" opacity="0.28" rx="1.5"/>`);
    }
  }
  return out.join("");
}

/** Draw-on CSS: each drawn object's strokes animate dashoffset 1→0 starting at
 * its `object.drawn` event time (pathLength=1 makes timing length-agnostic). */
function animationCss(ctx: Ctx): string {
  const events = ctx.opts.events ?? [];
  const rules: string[] = [];
  for (const e of events) {
    if (e.type !== "object.drawn" || !e.target) continue;
    const dur = ((e.payload?.duration as number) ?? 1).toFixed(2);
    const sel = `g[data-id="${cssEscape(e.target)}"] .sk-stroke`;
    rules.push(
      `${sel}{stroke-dasharray:1;stroke-dashoffset:1;animation:skdraw ${dur}s linear ${e.ts.toFixed(2)}s forwards;}`,
    );
  }
  if (!rules.length) return "";
  return `<style>@keyframes skdraw{to{stroke-dashoffset:0;}}${rules.join("")}</style>`;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
