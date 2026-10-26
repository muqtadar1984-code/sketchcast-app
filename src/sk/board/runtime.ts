// SK S1 spike — runtime (DOM side, no React) for BOTH options.
//
// Option E: the main clock is an <audio> element; every board action is a
// PAUSED Web Animation whose currentTime is set from the audio each frame
// (scrub-driven), so pause, seek and resume are exact by construction and an
// unfinished stroke simply continues from where the clock stopped.
//
// Option S: the main clock is a <video> element carrying the scene engine's
// clip (the production video renderer); the board itself is in the pixels.
// The same SVG machinery becomes an OVERLAY in the clip's world coordinates
// (1280×720) for the live aside, placed from the hit map the renderer
// exported (element boxes + action timeline).
//
// The DOM is built with createElementNS/textContent only — no innerHTML
// anywhere (contracts §2).

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
  type Aside,
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
export type Mode = "E" | "S";
export type HitMap = {
  world: { w: number; h: number };
  duration_ms: number;
  elements: Record<string, { box: [number, number, number, number] }>;
  /** The clip's illustration(s), keyed as the renderer named them ("mic", "ill"); boxes in world pixels. */
  asset: Record<string, { box: [number, number, number, number]; regions: Record<string, [number, number, number, number]> }>;
  timeline: { target: string; verb: string; start_ms: number; end_ms: number }[];
};
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
const box4 = (b: [number, number, number, number]): Box => ({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] });

export class SpikeRuntime {
  readonly measure: Measure = { fps: [], actionFirstFrame: [], pauseLatencyMs: [], resumeTrials: [], reloadRecovery: [], gestureHits: [] };
  state: PlayerState = "ready";
  private timed: Timed[] = [];
  private asideTimed: Timed[] = [];
  private asideLayer!: SVGGElement;
  private defs!: SVGDefsElement;
  /** A live aside (B4): actions scrubbed from a wall clock while the main clock is paused. */
  private live: { timed: Timed[]; gestures: Gesture[]; start: number; duration: number; resolve: () => void } | null = null;
  private seen = new Set<string>();
  private pauseReq: number | null = null;
  private strokes = 0; // stroke elements created — a resume must not add any
  private placed: Placed = {};
  private hitBoxes: Record<string, Box> = {};
  private pen!: SVGGElement;
  private avatar!: AvatarLike;
  private raf = 0;
  /** World size of the SVG: 100×100 (ERE board) for E, the clip's 1280×720 for S. */
  private readonly W: number;
  private readonly H: number;
  /** Sizes below are authored in board units (0–100); `u` scales them to the world. */
  private readonly u: number;

  constructor(
    private readonly host: HTMLElement,
    private readonly main: HTMLMediaElement,
    private readonly asideAudio: HTMLAudioElement,
    private readonly seg: Segment,
    private readonly font: OpentypeLike,
    private readonly base: string,
    private readonly cb: { state: (s: PlayerState) => void; log: (s: string) => void; clock: (ms: number) => void },
    private readonly opts: { mode: Mode; hitmap?: HitMap; rig?: { data: Rig; base: string }; /** null → no localStorage checkpoint (B4 keeps the cursor server-side) */ checkpointKey?: string | null } = { mode: "E" },
  ) {
    if (opts.mode === "S" && opts.hitmap) {
      this.W = opts.hitmap.world.w;
      this.H = opts.hitmap.world.h;
      this.u = this.H / 100;
    } else {
      this.W = 100;
      this.H = 100;
      this.u = 1;
    }
  }

  mount(): void {
    const host = this.host;
    while (host.firstChild) host.removeChild(host.firstChild);
    const svg = el("svg", { viewBox: `0 0 ${this.W} ${this.H}`, width: "100%", height: "100%", "font-family": "Caveat, ui-sans-serif" });
    if (this.opts.mode === "E") svg.appendChild(el("rect", { x: 0, y: 0, width: this.W, height: this.H, fill: "#FCFCFA" }));
    const defs = el("defs");
    const baseLayer = el("g", { "data-layer": "base" });
    const asideLayer = el("g", { "data-layer": "aside" });
    const avatarLayer = el("g", { "data-layer": "avatar" });
    const penLayer = el("g", { "data-layer": "pen" });
    svg.append(defs, baseLayer, asideLayer, avatarLayer, penLayer);
    host.appendChild(svg);
    this.asideLayer = asideLayer;
    this.defs = defs;

    this.pen = el("g", { opacity: 0 });
    this.pen.appendChild(el("path", { d: `M0 0 l${-1.4 * this.u} ${-4.2 * this.u} l${0.9 * this.u} ${-0.4 * this.u} l${1.9 * this.u} ${4.1 * this.u} z`, fill: ACCENT }));
    penLayer.appendChild(this.pen);

    if (this.opts.mode === "S" && this.opts.hitmap) {
      // The clip carries the board. Placed boxes come from the renderer's hit
      // map so the aside and the avatar target the SAME pixels the video drew.
      const hm = this.opts.hitmap;
      for (const [key, a] of Object.entries(hm.asset ?? {})) {
        // An Option-E asset of the same name (the U4 fixture) maps regions from
        // asset pixels; a B3 clip has none, so its regions come straight from the
        // hit map in world pixels as "key.region" hit boxes.
        const placeOp = this.seg.actions.find((x) => x.op === "place" && x.as === key);
        const fixture = placeOp && placeOp.op === "place" ? this.seg.assets[placeOp.ref.replace(/^asset:/, "")] : Object.values(this.seg.assets)[0];
        if (fixture) this.placed[key] = { box: box4(a.box), asset: fixture };
        this.hitBoxes[key] = box4(a.box);
        for (const [part, b] of Object.entries(a.regions ?? {})) this.hitBoxes[`${key}.${part}`] = box4(b);
      }
      for (const [id, e] of Object.entries(hm.elements)) this.hitBoxes[id] = box4(e.box);
      // Drift for S is measured against the hit-map timeline (no DOM actions).
      this.timed = hm.timeline.map((t) => ({ id: `${t.verb}:${t.target}`, start: t.start_ms, end: t.end_ms, anims: [] }));
    } else {
      this.timed = this.compile(this.seg.actions, baseLayer, defs, "b");
    }
    this.asideTimed = this.seg.aside ? this.compile(this.seg.aside.actions, asideLayer, defs, "a") : [];
    this.avatar = this.opts.rig
      ? new RigAvatar(avatarLayer, this.W, this.H, this.opts.rig.data, this.opts.rig.base, this.opts.mode === "S" ? 0.26 : 0.24)
      : new Avatar(avatarLayer, this.W, this.H, this.opts.mode === "S" ? 0.7 : 1);

    // Reload recovery: resume from the last checkpoint ≤ the saved cursor.
    try {
      const raw = this.ckptKey() ? localStorage.getItem(this.ckptKey()!) : null;
      if (raw) {
        const saved = JSON.parse(raw) as { t: number };
        const at = checkpointFor(this.checkpoints(), saved.t);
        this.main.currentTime = at / 1000;
        this.scrub(at);
        this.measure.reloadRecovery.push({ saved: saved.t, resumed: at });
        this.cb.log(`reload: saved cursor ${saved.t} ms → resumed at checkpoint ${at} ms`);
        localStorage.removeItem(this.ckptKey()!);
      }
    } catch {
      /* no storage */
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  /** The dev harness's localStorage key; null when the caller keeps the cursor itself. */
  private ckptKey(): string | null {
    if (this.opts.checkpointKey === null) return null;
    return this.opts.checkpointKey ?? CKPT_KEY + ":" + this.opts.mode;
  }

  // ── B4 teacher-loop surface ─────────────────────────────────────────────
  /** Current main-clock position, ms. */
  get t(): number {
    return this.main.currentTime * 1000;
  }
  seek(ms: number): void {
    const at = Math.max(0, ms) / 1000;
    this.main.currentTime = at;
    this.scrub(at * 1000);
  }
  setRate(rate: number): void {
    this.main.playbackRate = Math.min(2, Math.max(0.5, rate));
  }
  /** Pause for a turn: freeze the clock, SK leans in to listen. */
  pauseForTurn(): void {
    if (!this.main.paused) {
      this.pauseReq = performance.now();
      this.main.pause();
    }
    this.avatar.listen(true);
    this.setState("listening");
  }
  /** The server is answering: SK stops listening and talks. */
  answering(): void {
    this.avatar.listen(false);
    this.setState("answering");
  }
  /** Resume after a turn, `rewindMs` back (plan §4 RESUMING), or seek to `at` when given. */
  async resumeAfterTurn(rewindMs = 1500, at?: number): Promise<void> {
    this.avatar.listen(false);
    this.clearLiveAside();
    const to = at ?? Math.max(0, this.main.currentTime * 1000 - rewindMs);
    this.seek(to);
    await this.main.play();
    this.setState("playing");
  }
  /** Stay paused after a turn (a check opened, or the student paused). */
  holdAfterTurn(): void {
    this.avatar.listen(false);
    this.setState("paused");
  }
  /** Remove everything on the aside layer (the "erase" command). */
  clearLiveAside(): void {
    if (this.live) {
      this.live.resolve();
      this.live = null;
    }
    while (this.asideLayer.firstChild) this.asideLayer.removeChild(this.asideLayer.firstChild);
    // Re-compile the scripted aside (dev harness) so interrupt() still works.
    this.asideTimed = this.seg.aside ? this.compile(this.seg.aside.actions, this.asideLayer, this.defs, "a") : [];
    this.pen.setAttribute("opacity", "0");
  }
  /** Draw a VALIDATED live aside program on the aside layer. The program has
   * already passed the server's gate; the clock is wall time from now. Resolves
   * when the program's duration has elapsed (or it is cleared). */
  playLiveAside(program: Pick<Aside, "actions" | "gestures"> & { duration_ms: number }): Promise<void> {
    this.clearLiveAside();
    const timed = this.compile(program.actions, this.asideLayer, this.defs, "g");
    return new Promise<void>((resolve) => {
      this.live = { timed, gestures: program.gestures, start: performance.now(), duration: program.duration_ms, resolve };
    });
  }

  private checkpoints(): number[] {
    if (this.opts.mode === "S" && this.opts.hitmap) return [0, ...this.opts.hitmap.timeline.map((t) => t.start_ms)];
    return this.seg.checkpoints;
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    this.main.pause();
    this.asideAudio.pause();
  }

  private setState(s: PlayerState) {
    this.state = s;
    this.cb.state(s);
  }

  play(): void {
    void this.main.play();
    this.setState("playing");
  }
  pause(): void {
    this.pauseReq = performance.now();
    this.main.pause();
    this.setState("paused");
  }

  /** Barge-in: pause → listen (300 ms) → answer on the aside layer → resume 1.5 s back. */
  async interrupt(): Promise<void> {
    const { main, asideAudio: aside, seg } = this;
    if (main.paused || !seg.aside) return;
    const strokesBefore = this.strokes;
    this.pauseReq = performance.now();
    main.pause();
    this.setState("listening");
    this.avatar.listen(true);
    this.cb.log(`interrupt at ${Math.round(main.currentTime * 1000)} ms — listening`);
    await new Promise((r) => setTimeout(r, 300));
    this.avatar.listen(false);
    this.setState("answering");
    this.cb.log(`answering: "${seg.aside.question}"`);
    aside.currentTime = 0;
    await aside.play();
    await new Promise<void>((r) => aside.addEventListener("ended", () => r(), { once: true }));
    await new Promise((r) => setTimeout(r, 800));
    for (const tm of this.asideTimed) for (const a of tm.anims) a.currentTime = 0; // clear the aside layer
    const rewindTo = Math.max(0, main.currentTime * 1000 - 1500);
    main.currentTime = rewindTo / 1000;
    this.scrub(rewindTo);
    this.measure.resumeTrials.push({ rewindTo, strokesBefore, strokesAfter: this.strokes });
    this.cb.log(`resume from ${Math.round(rewindTo)} ms (strokes ${strokesBefore} → ${this.strokes}: ${this.strokes === strokesBefore ? "no redraw" : "REDRAW!"})`);
    await main.play();
    this.setState("playing");
  }

  summary(): Record<string, unknown> {
    const m = this.measure;
    const drift = m.actionFirstFrame.map((a) => a.seen - a.scheduled).sort((a, b) => a - b);
    const p = (q: number) => drift[Math.min(drift.length - 1, Math.floor(q * drift.length))] ?? 0;
    return {
      segment: this.seg.segment_id,
      option: this.opts.mode,
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
    const { main, asideAudio: aside, seg } = this;
    const t = main.currentTime * 1000;
    if (!main.paused) {
      this.scrub(t);
      this.cb.clock(t);
      try {
        if (this.ckptKey()) localStorage.setItem(this.ckptKey()!, JSON.stringify({ t }));
      } catch {
        /* ignore */
      }
      this.avatar.frame(t, seg.marks, seg.gestures, this.placed, this.hitBoxes, this.measure);
    } else if (this.pauseReq != null) {
      // First frame after the pause landed: that is the pause latency.
      this.measure.pauseLatencyMs.push(performance.now() - this.pauseReq);
      this.pauseReq = null;
    }
    if (main.ended && this.state === "playing") {
      this.setState("done");
      // A finished segment leaves no cursor behind — the next open starts fresh
      // (found when a completed Option S run "resumed" at its last second).
      try {
        if (this.ckptKey()) localStorage.removeItem(this.ckptKey()!);
      } catch {
        /* ignore */
      }
    }
    if (!aside.paused && seg.aside) {
      const ta = aside.currentTime * 1000;
      this.scrub(ta, "aside");
      this.avatar.frame(ta, seg.aside.marks, seg.aside.gestures, this.placed, this.hitBoxes, this.measure);
    }
    if (this.live) {
      const tl = performance.now() - this.live.start;
      for (const tm of this.live.timed) {
        for (const a of tm.anims) a.currentTime = tl;
        tm.onFrame?.(tl);
      }
      this.avatar.frame(tl, { words: [], visemes: [] }, this.live.gestures, this.placed, this.hitBoxes, this.measure);
      if (tl >= this.live.duration) {
        this.live.resolve();
        this.live = null;
        this.pen.setAttribute("opacity", "0");
      }
    }
    this.frames++;
    const now = performance.now();
    if (!this.lastFps) this.lastFps = now;
    if (now - this.lastFps >= 1000) {
      if (!main.paused || !aside.paused) this.measure.fps.push(this.frames);
      this.frames = 0;
      this.lastFps = now;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  // ── compile actions → DOM + paused animations ──────────────────────────────
  private compile(actions: Action[], layer: SVGGElement, defs: SVGDefsElement, prefix: string): Timed[] {
    const out: Timed[] = [];
    const nodes = new Map<string, SVGElement>();
    const { font, pen, base, seg, u } = this;
    const resolveTarget = (target: string): Box | null => {
      const [asId, ...rest] = target.split(".");
      const placed = this.placed[asId!];
      if (placed) return toBoard(placed.box, placed.asset, regionBox(placed.asset, rest.join(".") || undefined));
      if (this.hitBoxes[target]) return this.hitBoxes[target]!;
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
        const tx = right ? r.x + r.w + 6 * u : r.x - 6 * u;
        const g = el("g", { "data-id": a.id });
        const leader = el("line", { x1: tx - (right ? 1 : -1) * u, y1: cy, x2: cx + (right ? r.w / 2 : -r.w / 2), y2: cy, stroke: ACCENT, "stroke-width": 0.35 * u });
        const text = el("text", { x: tx, y: cy + 1.2 * u, "font-size": 3.4 * u, fill: INK, "text-anchor": right ? "start" : "end" });
        text.textContent = a.text; // never innerHTML
        g.append(leader, text);
        layer.appendChild(g);
        nodes.set(a.id, g);
        this.strokes++;
        out.push({ id: a.id, start: a.t, end: a.t + a.dur, anims: [drawOn(leader, a.t, a.dur * 0.6), fadeIn(text, a.t + a.dur * 0.5, a.dur * 0.5)] });
      } else if (a.op === "write") {
        const g = el("g", { "data-id": a.id });
        const glyphs = handwritingPaths(font, a.text, a.at.x * u, a.at.y * u, a.size * u);
        const sched = glyphSchedule(glyphs, a.dur);
        const anims: Animation[] = [];
        const color = a.style === "muted" ? MUTED : INK;
        glyphs.forEach((gl, i) => {
          const outline = el("path", { d: gl.d, fill: "none", stroke: color, "stroke-width": 0.28 * u, "stroke-linejoin": "round" });
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
            ? el("ellipse", { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2 + 2.5 * u, ry: b.h / 2 + 2 * u, fill: "none", stroke: MARKER, "stroke-width": 0.9 * u, opacity: 0.9 })
            : el("line", { x1: b.x - 0.5 * u, y1: b.y + b.h * 0.55, x2: b.x + b.w + 0.5 * u, y2: b.y + b.h * 0.45, stroke: "#B42318", "stroke-width": 0.6 * u });
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

interface AvatarLike {
  listen(on: boolean): void;
  frame(t: number, marks: Marks, gestures: Gesture[], placed: Placed, hitBoxes: Record<string, Box>, m: Measure): void;
}

/** The target box of the active gesture, in world units, or null. Shared by
 * both avatars so the stub and the rig point at the same thing. */
function gestureTarget(active: Gesture, placed: Placed, hitBoxes: Record<string, Box>): { box: Box; placedAsset: boolean } | null {
  const [asId, ...rest] = active.target!.split(".");
  const p = placed[asId!];
  if (p) return { box: toBoard(p.box, p.asset, regionBox(p.asset, rest.join(".") || undefined)), placedAsset: true };
  if (hitBoxes[active.target!]) return { box: hitBoxes[active.target!]!, placedAsset: false };
  const node = document.querySelector(`[data-id="${CSS.escape(active.target!)}"]`) as SVGGraphicsElement | null;
  if (!node) return null;
  const bb = node.getBBox();
  return { box: { x: bb.x, y: bb.y, w: bb.width, h: bb.height }, placedAsset: false };
}
function activeGesture(gestures: Gesture[], t: number): Gesture | undefined {
  return [...gestures].reverse().find((ge) => t >= ge.t && (ge.until == null ? t < ge.t + 2500 : t < ge.until));
}

// ── SK rig: cut-out layers of the chosen illustration (B), animated ────────
// Body static (with a breathing bob); head tilts/nods about the neck; the
// pointing forearm rotates about the elbow to aim at the gesture target; the
// mouth is a vector overlay driven by the word marks (visemes in B3); eyes
// blink. All rig geometry is in SOURCE pixels inside one scaled group.
class RigAvatar implements AvatarLike {
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
  private lastKey = "";
  private pending: { deg: number; t0: number; g: Gesture } | null = null;
  private nextBlink = 2500;

  constructor(layer: SVGGElement, W: number, H: number, private readonly rig: Rig, base: string, heightFrac: number) {
    const fh = rig.frame.y1 - rig.frame.y0;
    const fw = rig.frame.x1 - rig.frame.x0;
    this.k = (H * heightFrac) / fh;
    this.fx = rig.flip ? -1 : 1;
    // Bottom-right, flush with the bottom edge; a margin on the right. A
    // mirrored figure maps source x1→left edge, x0→right edge.
    const right = W - 2 * (H / 100);
    this.ax = rig.flip ? right + rig.frame.x0 * this.k : right - rig.frame.x1 * this.k;
    this.ay = H - rig.frame.y1 * this.k;
    void fw;
    this.root = el("g", { "data-id": "sk", transform: `translate(${this.ax.toFixed(2)} ${this.ay.toFixed(2)}) scale(${(this.k * this.fx).toFixed(5)} ${this.k.toFixed(5)})` });
    const img = (name: string, b: { x0: number; y0: number; x1: number; y1: number }) => {
      const i = el("image", { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 });
      i.setAttributeNS(XLINK, "href", base + name);
      i.setAttribute("href", base + name);
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
    this.armG.setAttribute("transform", `rotate(${deg.toFixed(2)} ${px} ${py})`);
  }
  private setHead(deg: number, dy = 0) {
    const [px, py] = this.rig.head.pivot;
    this.headG.setAttribute("transform", `translate(0 ${dy.toFixed(2)}) rotate(${deg.toFixed(2)} ${px} ${py})`);
  }

  listen(on: boolean): void {
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

  frame(t: number, marks: Marks, gestures: Gesture[], placed: Placed, hitBoxes: Record<string, Box>, m: Measure): void {
    // Mouth from the word marks (visemes replace this in B3).
    const w = wordAt(marks.words, t);
    const open = w ? 5 + 7 * Math.abs(Math.sin((t - w.t0) / 48)) : 0;
    this.mouthSkin.setAttribute("opacity", w ? "1" : "0");
    this.mouthOpen.setAttribute("opacity", w ? "1" : "0");
    this.mouthOpen.setAttribute("ry", open.toFixed(1));
    this.mouthOpen.setAttribute("rx", (this.rig.mouth.w / 2 - 6 - open * 0.6).toFixed(1));
    // Blink every 3–5 s for ~120 ms (wall clock, so it also blinks while paused).
    const now = performance.now();
    if (now > this.nextBlink) {
      const on = now < this.nextBlink + 120;
      for (const l of this.lids) l.setAttribute("opacity", on ? "1" : "0");
      if (!on) this.nextBlink = now + 3000 + Math.random() * 2000;
    }
    // Arm: aim at the active gesture's target; rest when none or listening.
    let targetDeg = this.restArm;
    const active = activeGesture(gestures, t);
    if (active?.target && !this.listening) {
      const r = gestureTarget(active, placed, hitBoxes);
      if (r) {
        const b = r.box;
        const [tx, ty] = active.kind === "point" ? [b.x + b.w + 1.5 * (this.k * 40), b.y + b.h / 2] : [b.x + b.w, b.y + b.h];
        targetDeg = this.aimAt(tx, ty);
        const key = `${active.t}:${active.kind}:${active.target}`;
        if (key !== this.lastKey) {
          this.lastKey = key;
          this.pending = { deg: targetDeg, t0: now, g: active };
        }
      }
    }
    this.armDeg += (targetDeg - this.armDeg) * 0.18;
    this.setArm(this.armDeg);
    if (this.pending && Math.abs(this.armDeg - this.pending.deg) < 2) {
      m.gestureHits.push({ t: this.pending.g.t, kind: this.pending.g.kind, target: this.pending.g.target, arriveMs: now - this.pending.t0 });
      this.pending = null;
    }
    // Head: tilt toward the student when listening, a small nod on each word, a breathing bob otherwise.
    // Listening tilt leans toward the student (screen-left); mirrored rigs tilt the other way in rig space.
    const headTarget = this.listening ? -9 * this.fx : w ? 1.5 * Math.sin((t - w.t0) / 90) : 0;
    this.headDeg += (headTarget - this.headDeg) * 0.2;
    const bob = 3 * Math.sin(now / 900);
    this.setHead(this.headDeg, bob);
  }
}

// ── SK avatar stub (kept for runs without a rig): mouth from word marks, hand from gestures ──
class Avatar implements AvatarLike {
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
    // Bottom-right corner, clear of the working column's last row.
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
    this.ear = el("circle", { cx: x + 8.5 * s, cy: y - 2 * s, r: 1.6 * s, fill: "none", stroke: ACCENT, "stroke-width": 0.4 * s, opacity: 0 }); // "listening" ring
    g.append(body, this.arm, this.hand, this.head, eyeL, eyeR, this.mouth, this.ear);
    layer.appendChild(g);
  }

  listen(on: boolean): void {
    this.listening = on;
    this.ear.setAttribute("opacity", on ? "1" : "0");
    this.head.setAttribute("transform", on ? `rotate(-8 ${this.cx} ${this.cy})` : "");
  }

  frame(t: number, marks: Marks, gestures: Gesture[], placed: Placed, hitBoxes: Record<string, Box>, m: Measure): void {
    const s = this.s;
    // Mouth: open while a word is spoken, with a small wobble so it reads as speech.
    const w = wordAt(marks.words, t);
    const open = (w ? 0.9 + 0.6 * Math.abs(Math.sin((t - w.t0) / 45)) : 0.3) * s;
    this.mouth.setAttribute("ry", open.toFixed(2));
    // Hand: ease toward the active gesture's target; rest when none.
    let tx = this.hx0;
    let ty = this.hy0;
    const active = activeGesture(gestures, t);
    if (active?.target && !this.listening) {
      const r = gestureTarget(active, placed, hitBoxes);
      if (r) {
        const b = r.box;
        if (r.placedAsset) [tx, ty] = active.kind === "point" ? [b.x + b.w + 1.5 * s, b.y + b.h / 2] : centre(b);
        else [tx, ty] = active.kind === "write" ? [b.x + b.w + 1 * s, b.y + b.h] : [b.x + b.w + 2 * s, b.y + b.h / 2];
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
    if (this.pending && Math.hypot(this.hx - this.pending.tx, this.hy - this.pending.ty) < 2 * s) {
      const { g, t0 } = this.pending;
      m.gestureHits.push({ t: g.t, kind: g.kind, target: g.target, arriveMs: performance.now() - t0 });
      this.pending = null;
    }
  }
}
