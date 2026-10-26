// SK S1 spike — Option E runtime (DOM side, no React). One clock (the <audio>
// element) drives everything: every board animation is a PAUSED Web Animation
// whose currentTime is set from the audio each frame (scrub-driven), so pause,
// seek and resume are exact by construction and an unfinished stroke simply
// continues from where the clock stopped. The DOM is built with
// createElementNS/textContent only — no innerHTML anywhere (contracts §2).

import {
  centre,
  checkpointFor,
  glyphSchedule,
  handwritingPaths,
  progress,
  regionBox,
  toBoard,
  traceAt,
  tracePath,
  wordAt,
  type Action,
  type AssetFixture,
  type Box,
  type Gesture,
  type Marks,
  type OpentypeLike,
  type Segment,
} from "./engine";

const NS = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const INK = "#14181F";
const MUTED = "#98A0A9";
const ACCENT = "#0C8175";
const MARKER = "#FFB020";
export const CKPT_KEY = "sk-s1:u4:cursor";

export type PlayerState = "ready" | "playing" | "paused" | "listening" | "answering" | "done";
export type Measure = {
  fps: number[];
  actionFirstFrame: { id: string; scheduled: number; seen: number }[]; // drift = seen - scheduled
  pauseLatencyMs: number[];
  resumeTrials: { rewindTo: number; strokesBefore: number; strokesAfter: number }[];
  reloadRecovery: { saved: number; resumed: number }[];
  gestureHits: { t: number; kind: string; target?: string; arriveMs: number }[];
};
type Timed = { id: string; start: number; end: number; anims: Animation[]; onFrame?: (t: number) => void };
type Placed = Record<string, { box: Box; asset: AssetFixture }>;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
/** A paused animation we scrub. `pathLength=1` makes dashoffset length-agnostic. */
function drawOn(target: SVGElement, start: number, dur: number): Animation {
  target.setAttribute("pathLength", "1");
  target.style.strokeDasharray = "1";
  target.style.strokeDashoffset = "1";
  const a = target.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { delay: start, duration: Math.max(1, dur), fill: "both" });
  a.pause();
  return a;
}
function fadeIn(target: SVGElement, start: number, dur: number): Animation {
  target.style.opacity = "0";
  const a = target.animate([{ opacity: 0 }, { opacity: 1 }], { delay: start, duration: Math.max(1, dur), fill: "both" });
  a.pause();
  return a;
}

export class SpikeRuntime {
  readonly measure: Measure = { fps: [], actionFirstFrame: [], pauseLatencyMs: [], resumeTrials: [], reloadRecovery: [], gestureHits: [] };
  state: PlayerState = "ready";
  private timed: Timed[] = [];
  private asideTimed: Timed[] = [];
  private seen = new Set<string>();
  private pauseReq: number | null = null;
  private strokes = 0; // stroke elements created — a resume must not add any
  private placed: Placed = {};
  private pen!: SVGGElement;
  private avatar!: Avatar;
  private raf = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly audio: HTMLAudioElement,
    private readonly asideAudio: HTMLAudioElement,
    private readonly seg: Segment,
    private readonly font: OpentypeLike,
    private readonly base: string,
    private readonly cb: { state: (s: PlayerState) => void; log: (s: string) => void; clock: (ms: number) => void },
  ) {}

  mount(): void {
    const host = this.host;
    while (host.firstChild) host.removeChild(host.firstChild);
    const svg = el("svg", { viewBox: "0 0 100 100", width: "100%", height: "100%", "font-family": "Caveat, ui-sans-serif" });
    svg.appendChild(el("rect", { x: 0, y: 0, width: 100, height: 100, fill: "#FCFCFA" }));
    const defs = el("defs");
    const baseLayer = el("g", { "data-layer": "base" });
    const asideLayer = el("g", { "data-layer": "aside" });
    const avatarLayer = el("g", { "data-layer": "avatar" });
    const penLayer = el("g", { "data-layer": "pen" });
    svg.append(defs, baseLayer, asideLayer, avatarLayer, penLayer);
    host.appendChild(svg);

    this.pen = el("g", { opacity: 0 });
    this.pen.appendChild(el("path", { d: "M0 0 l-1.4 -4.2 l0.9 -0.4 l1.9 4.1 z", fill: ACCENT }));
    penLayer.appendChild(this.pen);

    this.timed = this.compile(this.seg.actions, baseLayer, defs, "b");
    this.asideTimed = this.compile(this.seg.aside.actions, asideLayer, defs, "a");
    this.avatar = new Avatar(avatarLayer);

    // Reload recovery: resume from the last checkpoint ≤ the saved cursor.
    try {
      const raw = localStorage.getItem(CKPT_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { t: number };
        const at = checkpointFor(this.seg.checkpoints, saved.t);
        this.audio.currentTime = at / 1000;
        this.scrub(at);
        this.measure.reloadRecovery.push({ saved: saved.t, resumed: at });
        this.cb.log(`reload: saved cursor ${saved.t} ms → resumed at checkpoint ${at} ms`);
        localStorage.removeItem(CKPT_KEY);
      }
    } catch {
      /* no storage */
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.asideAudio.pause();
  }

  private setState(s: PlayerState) {
    this.state = s;
    this.cb.state(s);
  }

  play(): void {
    void this.audio.play();
    this.setState("playing");
  }
  pause(): void {
    this.pauseReq = performance.now();
    this.audio.pause();
    this.setState("paused");
  }

  /** Barge-in: pause → listen (300 ms) → answer on the aside layer → resume 1.5 s back. */
  async interrupt(): Promise<void> {
    const { audio, asideAudio: aside, seg } = this;
    if (audio.paused) return;
    const strokesBefore = this.strokes;
    this.pauseReq = performance.now();
    audio.pause();
    this.setState("listening");
    this.avatar.listen(true);
    this.cb.log(`interrupt at ${Math.round(audio.currentTime * 1000)} ms — listening`);
    await new Promise((r) => setTimeout(r, 300));
    this.avatar.listen(false);
    this.setState("answering");
    this.cb.log(`answering: "${seg.aside.question}"`);
    aside.currentTime = 0;
    await aside.play();
    await new Promise<void>((r) => aside.addEventListener("ended", () => r(), { once: true }));
    await new Promise((r) => setTimeout(r, 800));
    for (const tm of this.asideTimed) for (const a of tm.anims) a.currentTime = 0; // clear the aside layer
    const rewindTo = Math.max(0, audio.currentTime * 1000 - 1500);
    audio.currentTime = rewindTo / 1000;
    this.scrub(rewindTo);
    this.measure.resumeTrials.push({ rewindTo, strokesBefore, strokesAfter: this.strokes });
    this.cb.log(`resume from ${Math.round(rewindTo)} ms (strokes ${strokesBefore} → ${this.strokes}: ${this.strokes === strokesBefore ? "no redraw" : "REDRAW!"})`);
    await audio.play();
    this.setState("playing");
  }

  summary(): Record<string, unknown> {
    const m = this.measure;
    const drift = m.actionFirstFrame.map((a) => a.seen - a.scheduled).sort((a, b) => a - b);
    const p = (q: number) => drift[Math.min(drift.length - 1, Math.floor(q * drift.length))] ?? 0;
    return {
      segment: this.seg.segment_id,
      option: "E",
      ua: navigator.userAgent,
      fps: { min: m.fps.length ? Math.min(...m.fps) : 0, avg: m.fps.reduce((a, b) => a + b, 0) / (m.fps.length || 1) },
      driftMs: { p50: p(0.5), p95: p(0.95), max: drift.at(-1) ?? 0, n: drift.length },
      pauseLatencyMs: m.pauseLatencyMs,
      resumeTrials: m.resumeTrials,
      reloadRecovery: m.reloadRecovery,
      gestureHits: m.gestureHits,
      raw: m,
    };
  }

  // ── clock ──────────────────────────────────────────────────────────────────
  private lastScrubT = -1;
  private scrub(t: number, which: "main" | "aside" = "main"): void {
    const list = which === "main" ? this.timed : this.asideTimed;
    // Drift is only meaningful between CONSECUTIVE playback frames; a seek (a
    // resume rewind, a reload checkpoint) jumps the clock and must not count.
    const live = which === "main" && this.lastScrubT >= 0 && t - this.lastScrubT >= 0 && t - this.lastScrubT < 250;
    for (const tm of list) {
      for (const a of tm.anims) a.currentTime = t;
      tm.onFrame?.(t);
      if (which === "main" && t >= tm.start && !this.seen.has(tm.id)) {
        this.seen.add(tm.id);
        if (live) this.measure.actionFirstFrame.push({ id: tm.id, scheduled: tm.start, seen: t });
      }
    }
    if (which === "main") this.lastScrubT = t;
  }

  private frames = 0;
  private lastFps = 0;
  private readonly loop = () => {
    const { audio, asideAudio: aside, seg } = this;
    const t = audio.currentTime * 1000;
    if (!audio.paused) {
      this.scrub(t);
      this.cb.clock(t);
      try {
        localStorage.setItem(CKPT_KEY, JSON.stringify({ t }));
      } catch {
        /* ignore */
      }
      this.avatar.frame(t, seg.marks, seg.gestures, this.placed, this.measure);
    } else if (this.pauseReq != null) {
      // First frame after the pause landed: that is the pause latency.
      this.measure.pauseLatencyMs.push(performance.now() - this.pauseReq);
      this.pauseReq = null;
    }
    if (audio.ended && this.state === "playing") this.setState("done");
    if (!aside.paused) {
      const ta = aside.currentTime * 1000;
      this.scrub(ta, "aside");
      this.avatar.frame(ta, seg.aside.marks, seg.aside.gestures, this.placed, this.measure);
    }
    this.frames++;
    const now = performance.now();
    if (!this.lastFps) this.lastFps = now;
    if (now - this.lastFps >= 1000) {
      if (!audio.paused || !aside.paused) this.measure.fps.push(this.frames);
      this.frames = 0;
      this.lastFps = now;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  // ── compile actions → DOM + paused animations ──────────────────────────────
  private compile(actions: Action[], layer: SVGGElement, defs: SVGDefsElement, prefix: string): Timed[] {
    const out: Timed[] = [];
    const nodes = new Map<string, SVGElement>();
    const { font, pen, base, seg } = this;
    const resolveTarget = (target: string): Box | null => {
      const [asId, ...rest] = target.split(".");
      const placed = this.placed[asId!];
      if (placed) return toBoard(placed.box, placed.asset, regionBox(placed.asset, rest.join(".") || undefined));
      const n = nodes.get(target) as SVGGraphicsElement | undefined;
      if (!n) return null;
      const bb = n.getBBox();
      return { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
    };

    for (const a of actions) {
      if (a.op === "place") {
        const asset = seg.assets[a.ref.replace(/^asset:/, "")]!;
        this.placed[a.as] = { box: a.at, asset };
        // Inner <svg> in asset pixel space so regions/trace coordinates apply directly.
        const inner = el("svg", { x: a.at.x, y: a.at.y, width: a.at.w, height: a.at.h, viewBox: `0 0 ${asset.w} ${asset.h}`, "data-id": a.as });
        const maskId = `${prefix}-mask-${a.as}`;
        const mask = el("mask", { id: maskId, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: asset.w, height: asset.h });
        const stroke = el("path", { d: tracePath(asset.trace), fill: "none", stroke: "#fff", "stroke-width": 16, "stroke-linecap": "round", "stroke-linejoin": "round" });
        const full = el("rect", { x: 0, y: 0, width: asset.w, height: asset.h, fill: "#fff", opacity: 0 });
        mask.append(stroke, full);
        defs.appendChild(mask);
        const img = el("image", { x: 0, y: 0, width: asset.w, height: asset.h, mask: `url(#${maskId})` });
        img.setAttributeNS(XLINK, "href", base + asset.src);
        img.setAttribute("href", base + asset.src);
        inner.appendChild(img);
        layer.appendChild(inner);
        nodes.set(a.as, inner);
        nodes.set(`${a.as}__maskStroke`, stroke);
        nodes.set(`${a.as}__maskFull`, full);
      } else if (a.op === "reveal") {
        const stroke = nodes.get(`${a.target}__maskStroke`)!;
        const full = nodes.get(`${a.target}__maskFull`)!;
        const placed = this.placed[a.target]!;
        this.strokes++;
        // The last step is the whole ink, not another stamp (the worker's lesson, PR #47).
        const anims = [drawOn(stroke, a.t, a.dur), fadeIn(full, a.t + a.dur, 250)];
        out.push({
          id: a.id,
          start: a.t,
          end: a.t + a.dur,
          anims,
          onFrame: (t) => {
            const p = progress(t, a.t, a.dur);
            if (p <= 0 || p >= 1) return;
            const [px, py] = traceAt(placed.asset.trace, p);
            const b = toBoard(placed.box, placed.asset, { x: px, y: py, w: 0, h: 0 });
            movePen(pen, b.x, b.y, true);
          },
        });
      } else if (a.op === "label") {
        const r = resolveTarget(a.target);
        if (!r) continue;
        const [cx, cy] = centre(r);
        const right = a.side === "right";
        const tx = right ? r.x + r.w + 6 : r.x - 6;
        const g = el("g", { "data-id": a.id });
        const leader = el("line", { x1: tx - (right ? 1 : -1), y1: cy, x2: cx + (right ? r.w / 2 : -r.w / 2), y2: cy, stroke: ACCENT, "stroke-width": 0.35 });
        const text = el("text", { x: tx, y: cy + 1.2, "font-size": 3.4, fill: INK, "text-anchor": right ? "start" : "end" });
        text.textContent = a.text; // never innerHTML
        g.append(leader, text);
        layer.appendChild(g);
        nodes.set(a.id, g);
        this.strokes++;
        out.push({ id: a.id, start: a.t, end: a.t + a.dur, anims: [drawOn(leader, a.t, a.dur * 0.6), fadeIn(text, a.t + a.dur * 0.5, a.dur * 0.5)] });
      } else if (a.op === "write") {
        const g = el("g", { "data-id": a.id });
        const glyphs = handwritingPaths(font, a.text, a.at.x, a.at.y, a.size);
        const sched = glyphSchedule(glyphs, a.dur);
        const anims: Animation[] = [];
        const color = a.style === "muted" ? MUTED : INK;
        glyphs.forEach((gl, i) => {
          const outline = el("path", { d: gl.d, fill: "none", stroke: color, "stroke-width": 0.28, "stroke-linejoin": "round" });
          const fill = el("path", { d: gl.d, fill: color, stroke: "none" });
          g.append(outline, fill);
          const [s, e] = sched[i]!;
          anims.push(drawOn(outline, a.t + s, e - s), fadeIn(fill, a.t + e - 60, 120));
          this.strokes++;
        });
        layer.appendChild(g);
        nodes.set(a.id, g);
        out.push({
          id: a.id,
          start: a.t,
          end: a.t + a.dur,
          anims,
          onFrame: (t) => {
            const p = progress(t, a.t, a.dur);
            if (p <= 0 || p >= 1) return;
            const rel = p * a.dur;
            const i = Math.max(0, sched.findIndex(([, e]) => rel < e));
            const gl = glyphs[i]!;
            const q = progress(rel, sched[i]![0], sched[i]![1] - sched[i]![0]);
            movePen(pen, gl.bbox.x + gl.bbox.w * q, gl.bbox.y + gl.bbox.h * 0.6, true);
          },
        });
      } else if (a.op === "highlight") {
        const b = resolveTarget(a.target);
        if (!b) continue;
        const shape =
          a.style === "circle"
            ? el("ellipse", { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2 + 2.5, ry: b.h / 2 + 2, fill: "none", stroke: MARKER, "stroke-width": 0.9, opacity: 0.9 })
            : el("line", { x1: b.x - 0.5, y1: b.y + b.h * 0.55, x2: b.x + b.w + 0.5, y2: b.y + b.h * 0.45, stroke: "#B42318", "stroke-width": 0.6 });
        shape.setAttribute("data-id", a.id);
        layer.appendChild(shape);
        nodes.set(a.id, shape);
        this.strokes++;
        out.push({ id: a.id, start: a.t, end: a.t + a.dur, anims: [drawOn(shape, a.t, a.dur)] });
      }
    }
    return out;
  }
}

function movePen(pen: SVGGElement, x: number, y: number, show: boolean) {
  pen.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
  pen.setAttribute("opacity", show ? "1" : "0");
}

// ── SK avatar stub: mouth from word marks, hand from gestures ───────────────
class Avatar {
  private static readonly HEAD: [number, number] = [90, 90]; // clear of the working column's last row (y≈81)
  private readonly mouth: SVGEllipseElement;
  private readonly arm: SVGLineElement;
  private readonly hand: SVGCircleElement;
  private readonly head: SVGCircleElement;
  private readonly ear: SVGCircleElement;
  private hx: number;
  private hy: number;
  private listening = false;
  private lastKey = "";
  private pending: { tx: number; ty: number; t0: number; g: Gesture } | null = null;

  constructor(layer: SVGGElement) {
    const [x, y] = Avatar.HEAD;
    const g = el("g", { "data-id": "sk" });
    const body = el("ellipse", { cx: x, cy: y + 12, rx: 9, ry: 7, fill: "#E6F3F1" });
    this.head = el("circle", { cx: x, cy: y, r: 6.5, fill: "#FFE2C6", stroke: INK, "stroke-width": 0.35 });
    const eyeL = el("circle", { cx: x - 2.2, cy: y - 1.2, r: 0.7, fill: INK });
    const eyeR = el("circle", { cx: x + 2.2, cy: y - 1.2, r: 0.7, fill: INK });
    this.mouth = el("ellipse", { cx: x, cy: y + 2.6, rx: 1.6, ry: 0.3, fill: "#8B2E2E" });
    this.hx = x - 6;
    this.hy = y + 9;
    this.arm = el("line", { x1: x - 6, y1: y + 9, x2: this.hx, y2: this.hy, stroke: "#FFE2C6", "stroke-width": 1.6, "stroke-linecap": "round" });
    this.hand = el("circle", { cx: this.hx, cy: this.hy, r: 1.3, fill: "#FFE2C6", stroke: INK, "stroke-width": 0.25 });
    this.ear = el("circle", { cx: x + 8.5, cy: y - 2, r: 1.6, fill: "none", stroke: ACCENT, "stroke-width": 0.4, opacity: 0 }); // "listening" ring
    g.append(body, this.arm, this.hand, this.head, eyeL, eyeR, this.mouth, this.ear);
    layer.appendChild(g);
  }

  listen(on: boolean): void {
    this.listening = on;
    const [x, y] = Avatar.HEAD;
    this.ear.setAttribute("opacity", on ? "1" : "0");
    this.head.setAttribute("transform", on ? `rotate(-8 ${x} ${y})` : "");
  }

  frame(t: number, marks: Marks, gestures: Gesture[], placed: Placed, m: Measure): void {
    // Mouth: open while a word is spoken, with a small wobble so it reads as speech.
    const w = wordAt(marks.words, t);
    const open = w ? 0.9 + 0.6 * Math.abs(Math.sin((t - w.t0) / 45)) : 0.3;
    this.mouth.setAttribute("ry", open.toFixed(2));
    // Hand: ease toward the active gesture's target; rest when none.
    const [x, y] = Avatar.HEAD;
    let tx = x - 6;
    let ty = y + 9;
    const active = [...gestures].reverse().find((ge) => t >= ge.t && (ge.until == null ? t < ge.t + 2500 : t < ge.until));
    if (active?.target && !this.listening) {
      const [asId, ...rest] = active.target.split(".");
      const p = placed[asId!];
      if (p) {
        const b = toBoard(p.box, p.asset, regionBox(p.asset, rest.join(".") || undefined));
        [tx, ty] = active.kind === "point" ? [b.x + b.w + 1.5, b.y + b.h / 2] : centre(b);
      } else {
        const node = document.querySelector(`[data-id="${CSS.escape(active.target)}"]`) as SVGGraphicsElement | null;
        if (node) {
          const bb = node.getBBox();
          [tx, ty] = active.kind === "write" ? [bb.x + bb.width + 1, bb.y + bb.height] : [bb.x + bb.width + 2, bb.y + bb.height / 2];
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
    this.arm.setAttribute("x2", this.hx.toFixed(2));
    this.arm.setAttribute("y2", this.hy.toFixed(2));
    this.hand.setAttribute("cx", this.hx.toFixed(2));
    this.hand.setAttribute("cy", this.hy.toFixed(2));
    if (this.pending && Math.hypot(this.hx - this.pending.tx, this.hy - this.pending.ty) < 2) {
      const { g, t0 } = this.pending;
      m.gestureHits.push({ t: g.t, kind: g.kind, target: g.target, arriveMs: performance.now() - t0 });
      this.pending = null;
    }
  }
}
