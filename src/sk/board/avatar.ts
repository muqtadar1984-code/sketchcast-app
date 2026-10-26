// SK board — the avatar (contracts §1.4 AvatarProvider, client side).
//
// The avatar never has its own clock: the runtime calls `frame(t, …)` with
// the board's clock, and the gestures come from the segment manifest (the
// packager's `gestures_for`: `point` at a hit-map element, `write` while a
// line is written, with `until`) or from a live aside. Three gestures:
//   point   the forearm aims at the target's world box (hit map, region or a
//           node the overlay drew) — measured as the time from the cue until
//           the arm settles (§5.3: ≤ 1 s);
//   write   the hand follows the PEN while the overlay writes (the pen's
//           world position is passed in) — measured as hand-to-pen distance
//           (§5.3: ≤ 40 px); for a clip-written line (no live pen) the hand
//           aims at the line's hit box;
//   listen  on barge-in the head turns to the student and the arm rests.
//
// Two implementations behind one interface: `RigAvatar` (the SK characters,
// A for female voices, B for male — founder's choice 2026-10-27; cut into
// layers by tools/sk-s1/make_rig.py) and `StubAvatar` for runs without a rig.
// All nodes go through `dom.ts` (allow-listed tags/attributes, local images).

import { activeGesture, regionBox, toBoard, wordAt, type AssetFixture, type Box, type Gesture, type Marks } from "./engine";
import { el, setAttr, setImageHref } from "./dom";

const INK = "#14181F";
const ACCENT = "#0C8175";

/** The SK character rig (tools/sk-s1/make_rig.py): cut-out layers of one
 * illustration with pivots in SOURCE pixels. */
export type Rig = {
  character?: string;
  /** Drawn pointing to the viewer's right → mirrored so SK points LEFT at the board. */
  flip?: boolean;
  w: number;
  h: number;
  frame: { x0: number; y0: number; x1: number; y1: number };
  head: { x0: number; y0: number; x1: number; y1: number; pivot: [number, number] };
  arm: { x0: number; y0: number; x1: number; y1: number; pivot: [number, number]; fingertip: [number, number] };
  mouth: { cx: number; cy: number; w: number; h: number };
  eyes: { cx: number; cy: number; w: number; h: number }[];
  skin: string;
  lip: string;
};

/** Which rig a voice gets: A (Malay woman teacher, teal tudung) for female
 * voices, B (Indian man teacher, glasses) for male. */
export const rigBaseFor = (voiceGender: string | undefined): string => (voiceGender === "male" ? "/sk-s1/sk-b/" : "/sk-s1/sk-a/");

export type Placed = Record<string, { box: Box; asset: AssetFixture }>;
export type GestureHit = { t: number; kind: string; target?: string; arriveMs: number };
/** Hand-to-pen distance sampled while a `write` gesture follows the live pen (world px). */
export type WriteSample = { t: number; target?: string; distancePx: number };

export type AvatarMeasure = { gestureHits: GestureHit[]; writeSamples: WriteSample[]; listenLatencyMs: number[] };
export type Pen = { x: number; y: number } | null;

export interface AvatarLike {
  /** Barge-in: turn to the student (and record how long the pose took to land). */
  listen(on: boolean): void;
  frame(t: number, marks: Marks, gestures: Gesture[], placed: Placed, hitBoxes: Record<string, Box>, m: AvatarMeasure, pen?: Pen): void;
}

/** The target box of the active gesture, in world units, or null. Shared by
 * both avatars so the stub and the rig point at the same thing. */
export function gestureTarget(active: Gesture, placed: Placed, hitBoxes: Record<string, Box>): { box: Box; placedAsset: boolean } | null {
  const [asId, ...rest] = active.target!.split(".");
  const p = placed[asId!];
  if (p) return { box: toBoard(p.box, p.asset, regionBox(p.asset, rest.join(".") || undefined)), placedAsset: true };
  if (hitBoxes[active.target!]) return { box: hitBoxes[active.target!]!, placedAsset: false };
  const node = document.querySelector(`[data-id="${CSS.escape(active.target!)}"]`) as SVGGraphicsElement | null;
  if (!node) return null;
  const bb = node.getBBox();
  return { box: { x: bb.x, y: bb.y, w: bb.width, h: bb.height }, placedAsset: false };
}

// ── SK rig: cut-out layers of the chosen illustration, animated ────────────
// Body static (with a breathing bob); head tilts/nods about the neck; the
// pointing forearm rotates about the elbow to aim at the gesture target; the
// mouth is a vector overlay driven by the word marks (visemes in B3); eyes
// blink. All rig geometry is in SOURCE pixels inside one scaled group.
export class RigAvatar implements AvatarLike {
  private readonly root: SVGGElement;
  private readonly headG: SVGGElement;
  private readonly armG: SVGGElement;
  private readonly mouthSkin: SVGEllipseElement;
  private readonly mouthOpen: SVGEllipseElement;
  private readonly lids: SVGEllipseElement[];
  private readonly k: number; // world units per source px
  private readonly fx: 1 | -1; // -1 = mirrored horizontally
  private readonly ax: number; // world x of source x=0 (world x = ax + fx·k·sx)
  private readonly ay: number;
  private readonly restArm = 34; // degrees: forearm lowered when idle
  private armDeg = 34;
  private headDeg = 0;
  private listening = false;
  private listenReq: number | null = null;
  private lastKey = "";
  private pending: { deg: number; t0: number; g: Gesture } | null = null;
  private nextBlink = 2500;

  constructor(layer: SVGGElement, W: number, H: number, private readonly rig: Rig, base: string, heightFrac: number) {
    const fh = rig.frame.y1 - rig.frame.y0;
    this.k = (H * heightFrac) / fh;
    this.fx = rig.flip ? -1 : 1;
    // Bottom-right, flush with the bottom edge; a margin on the right. A
    // mirrored figure maps source x1→left edge, x0→right edge.
    const right = W - 2 * (H / 100);
    this.ax = rig.flip ? right + rig.frame.x0 * this.k : right - rig.frame.x1 * this.k;
    this.ay = H - rig.frame.y1 * this.k;
    this.root = el("g", { "data-id": "sk", transform: `translate(${this.ax.toFixed(2)} ${this.ay.toFixed(2)}) scale(${(this.k * this.fx).toFixed(5)} ${this.k.toFixed(5)})` });
    const img = (name: string, b: { x0: number; y0: number; x1: number; y1: number }) => {
      const i = el("image", { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 });
      setImageHref(i, base + name);
      return i;
    };
    const body = img("body.png", rig.frame);
    this.headG = el("g");
    this.headG.appendChild(img("head.png", rig.head));
    // Mouth overlay: a skin patch hides the drawn (closed) mouth, the dark
    // ellipse opens with speech. Hidden entirely while silent so the original
    // smile shows.
    const m = rig.mouth;
    this.mouthSkin = el("ellipse", { cx: m.cx, cy: m.cy, rx: m.w / 2 + 4, ry: m.h / 2 + 6, fill: rig.skin, opacity: 0 });
    this.mouthOpen = el("ellipse", { cx: m.cx, cy: m.cy + 2, rx: m.w / 2 - 6, ry: 2, fill: rig.lip, opacity: 0 });
    this.lids = rig.eyes.map((e) => el("ellipse", { cx: e.cx, cy: e.cy, rx: e.w / 2 + 3, ry: e.h / 2 + 3, fill: rig.skin, opacity: 0 }));
    this.headG.append(this.mouthSkin, this.mouthOpen, ...this.lids);
    this.armG = el("g");
    this.armG.appendChild(img("arm.png", rig.arm));
    this.root.append(body, this.headG, this.armG);
    layer.appendChild(this.root);
    this.setArm(this.restArm);
  }

  private setArm(deg: number) {
    const [px, py] = this.rig.arm.pivot;
    setAttr(this.armG, "transform", `rotate(${deg.toFixed(2)} ${px} ${py})`);
  }
  private setHead(deg: number, dy = 0) {
    const [px, py] = this.rig.head.pivot;
    setAttr(this.headG, "transform", `translate(0 ${dy.toFixed(2)}) rotate(${deg.toFixed(2)} ${px} ${py})`);
  }

  listen(on: boolean): void {
    if (on && !this.listening) this.listenReq = performance.now();
    this.listening = on;
  }

  /** Forearm rotation (deg, clockwise positive) that aims the fingertip at a world point. */
  private aimAt(wx: number, wy: number): number {
    const [ex, ey] = this.rig.arm.pivot;
    const [fx, fy] = this.rig.arm.fingertip;
    const tx = ((wx - this.ax) / this.k) * this.fx; // into (possibly mirrored) rig space
    const ty = (wy - this.ay) / this.k;
    const want = Math.atan2(ty - ey, tx - ex);
    const have = Math.atan2(fy - ey, fx - ex);
    let deg = ((want - have) * 180) / Math.PI;
    while (deg > 180) deg -= 360;
    while (deg < -180) deg += 360;
    return Math.max(-40, Math.min(70, deg));
  }

  /** World position of the fingertip for the current arm angle. */
  fingertip(): { x: number; y: number } {
    const [ex, ey] = this.rig.arm.pivot;
    const [fx, fy] = this.rig.arm.fingertip;
    const r = (this.armDeg * Math.PI) / 180;
    const dx = fx - ex;
    const dy = fy - ey;
    const sx = ex + dx * Math.cos(r) - dy * Math.sin(r);
    const sy = ey + dx * Math.sin(r) + dy * Math.cos(r);
    return { x: this.ax + this.fx * this.k * sx, y: this.ay + this.k * sy };
  }

  frame(t: number, marks: Marks, gestures: Gesture[], placed: Placed, hitBoxes: Record<string, Box>, m: AvatarMeasure, pen: Pen = null): void {
    // Mouth from the word marks (visemes replace this in B3).
    const w = wordAt(marks.words, t);
    const open = w ? 5 + 7 * Math.abs(Math.sin((t - w.t0) / 48)) : 0;
    setAttr(this.mouthSkin, "opacity", w ? "1" : "0");
    setAttr(this.mouthOpen, "opacity", w ? "1" : "0");
    setAttr(this.mouthOpen, "ry", open.toFixed(1));
    setAttr(this.mouthOpen, "rx", (this.rig.mouth.w / 2 - 6 - open * 0.6).toFixed(1));
    // Blink every 3–5 s for ~120 ms (wall clock, so it also blinks while paused).
    const now = performance.now();
    if (now > this.nextBlink) {
      const on = now < this.nextBlink + 120;
      for (const l of this.lids) setAttr(l, "opacity", on ? "1" : "0");
      if (!on) this.nextBlink = now + 3000 + Math.random() * 2000;
    }
    // Arm: aim at the active gesture's target; rest when none or listening.
    let targetDeg = this.restArm;
    const active = activeGesture(gestures, t);
    let following: Gesture | null = null;
    if (active?.target && !this.listening && active.kind !== "listen" && active.kind !== "idle" && active.kind !== "think") {
      let aim: [number, number] | null = null;
      if (active.kind === "write" && pen) {
        aim = [pen.x, pen.y];
        following = active;
      } else {
        const r = gestureTarget(active, placed, hitBoxes);
        if (r) {
          const b = r.box;
          aim = active.kind === "point" ? [b.x + b.w + 1.5 * (this.k * 40), b.y + b.h / 2] : [b.x + b.w, b.y + b.h];
        }
      }
      if (aim) {
        targetDeg = this.aimAt(aim[0], aim[1]);
        const key = `${active.t}:${active.kind}:${active.target}`;
        if (key !== this.lastKey) {
          this.lastKey = key;
          this.pending = { deg: targetDeg, t0: now, g: active };
        } else if (this.pending) this.pending.deg = targetDeg; // a moving pen: re-aim, keep the cue time
      }
    }
    this.armDeg += (targetDeg - this.armDeg) * 0.18;
    this.setArm(this.armDeg);
    if (this.pending && Math.abs(this.armDeg - this.pending.deg) < 2) {
      m.gestureHits.push({ t: this.pending.g.t, kind: this.pending.g.kind, target: this.pending.g.target, arriveMs: now - this.pending.t0 });
      this.pending = null;
    }
    if (following && pen) {
      const f = this.fingertip();
      m.writeSamples.push({ t, target: following.target, distancePx: Math.hypot(f.x - pen.x, f.y - pen.y) });
    }
    // Head: tilt toward the student when listening, a small nod on each word, a breathing bob otherwise.
    // Listening tilt leans toward the student (screen-left); mirrored rigs tilt the other way in rig space.
    const headTarget = this.listening ? -9 * this.fx : w ? 1.5 * Math.sin((t - w.t0) / 90) : 0;
    this.headDeg += (headTarget - this.headDeg) * 0.2;
    if (this.listenReq != null && this.listening && Math.abs(this.headDeg - headTarget) < 1.5) {
      m.listenLatencyMs.push(now - this.listenReq);
      this.listenReq = null;
    }
    const bob = 3 * Math.sin(now / 900);
    this.setHead(this.headDeg, bob);
  }
}

// ── SK avatar stub (runs without a rig): mouth from word marks, hand from gestures ──
export class StubAvatar implements AvatarLike {
  private readonly hx0: number;
  private readonly hy0: number;
  private readonly mouth: SVGEllipseElement;
  private readonly arm: SVGLineElement;
  private readonly hand: SVGCircleElement;
  private readonly head: SVGCircleElement;
  private readonly ear: SVGCircleElement;
  private readonly cx: number;
  private readonly cy: number;
  private readonly s: number; // one "board unit" in world px
  private hx: number;
  private hy: number;
  private listening = false;
  private lastKey = "";
  private pending: { tx: number; ty: number; t0: number; g: Gesture } | null = null;

  constructor(layer: SVGGElement, W: number, H: number, size = 1) {
    const s = (H / 100) * size;
    this.s = s;
    const x = W - 10 * s;
    const y = H - 10 * s;
    this.cx = x;
    this.cy = y;
    const g = el("g", { "data-id": "sk" });
    const body = el("ellipse", { cx: x, cy: y + 12 * s, rx: 9 * s, ry: 7 * s, fill: "#E6F3F1" });
    this.head = el("circle", { cx: x, cy: y, r: 6.5 * s, fill: "#FFE2C6", stroke: INK, "stroke-width": 0.35 * s });
    const eyeL = el("circle", { cx: x - 2.2 * s, cy: y - 1.2 * s, r: 0.7 * s, fill: INK });
    const eyeR = el("circle", { cx: x + 2.2 * s, cy: y - 1.2 * s, r: 0.7 * s, fill: INK });
    this.mouth = el("ellipse", { cx: x, cy: y + 2.6 * s, rx: 1.6 * s, ry: 0.3 * s, fill: "#8B2E2E" });
    this.hx0 = x - 6 * s;
    this.hy0 = y + 9 * s;
    this.hx = this.hx0;
    this.hy = this.hy0;
    this.arm = el("line", { x1: this.hx0, y1: this.hy0, x2: this.hx, y2: this.hy, stroke: "#FFE2C6", "stroke-width": 1.6 * s, "stroke-linecap": "round" });
    this.hand = el("circle", { cx: this.hx, cy: this.hy, r: 1.3 * s, fill: "#FFE2C6", stroke: INK, "stroke-width": 0.25 * s });
    this.ear = el("circle", { cx: x + 8.5 * s, cy: y - 2 * s, r: 1.6 * s, fill: "none", stroke: ACCENT, "stroke-width": 0.4 * s, opacity: 0 });
    g.append(body, this.arm, this.hand, this.head, eyeL, eyeR, this.mouth, this.ear);
    layer.appendChild(g);
  }

  listen(on: boolean): void {
    this.listening = on;
    setAttr(this.ear, "opacity", on ? "1" : "0");
    setAttr(this.head, "transform", on ? `rotate(-8 ${this.cx} ${this.cy})` : "");
  }

  frame(t: number, marks: Marks, gestures: Gesture[], placed: Placed, hitBoxes: Record<string, Box>, m: AvatarMeasure, pen: Pen = null): void {
    const s = this.s;
    const w = wordAt(marks.words, t);
    const open = (w ? 0.9 + 0.6 * Math.abs(Math.sin((t - w.t0) / 45)) : 0.3) * s;
    setAttr(this.mouth, "ry", open.toFixed(2));
    let tx = this.hx0;
    let ty = this.hy0;
    const active = activeGesture(gestures, t);
    if (active?.target && !this.listening) {
      if (active.kind === "write" && pen) [tx, ty] = [pen.x, pen.y];
      else {
        const r = gestureTarget(active, placed, hitBoxes);
        if (r) {
          const b = r.box;
          if (r.placedAsset) [tx, ty] = active.kind === "point" ? [b.x + b.w + 1.5 * s, b.y + b.h / 2] : [b.x + b.w / 2, b.y + b.h / 2];
          else [tx, ty] = active.kind === "write" ? [b.x + b.w + 1 * s, b.y + b.h] : [b.x + b.w + 2 * s, b.y + b.h / 2];
        }
      }
      const key = `${active.t}:${active.kind}:${active.target}`;
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.pending = { tx, ty, t0: performance.now(), g: active };
      }
    }
    this.hx += (tx - this.hx) * 0.22;
    this.hy += (ty - this.hy) * 0.22;
    setAttr(this.arm, "x2", this.hx.toFixed(2));
    setAttr(this.arm, "y2", this.hy.toFixed(2));
    setAttr(this.hand, "cx", this.hx.toFixed(2));
    setAttr(this.hand, "cy", this.hy.toFixed(2));
    if (this.pending && Math.hypot(this.hx - this.pending.tx, this.hy - this.pending.ty) < 2 * s) {
      const { g, t0 } = this.pending;
      m.gestureHits.push({ t: g.t, kind: g.kind, target: g.target, arriveMs: performance.now() - t0 });
      this.pending = null;
    }
  }
}
