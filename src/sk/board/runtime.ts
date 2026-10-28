// SK board runtime (DOM side, no React) — the ONE board model.
//
// Option E: the main clock is an <audio> element; every board action is a
// PAUSED Web Animation whose currentTime is set from the audio each frame
// (scrub-driven), so pause, seek and resume are exact by construction and an
// unfinished stroke simply continues from where the clock stopped.
//
// Option S (the B2 decision for prepared segments): the main clock is a
// <video> element carrying the scene engine's clip; the board itself is in
// the pixels and the renderer's HIT MAP is its scene graph. The same SVG
// machinery is an OVERLAY in the clip's world coordinates (1280×720) for live
// teaching: an aside drawn on `live`, placed from the hit map, scrubbed from
// its own clock (the answer's audio when there is one, wall time otherwise)
// while the clip is paused. One board, one event model.
//
// Every node goes through `dom.ts` (createElementNS + textContent, tag and
// attribute allow-lists, local image paths only — plan §14). Every command
// can carry an event id and is applied at most once (`events.ts`).

import {
  centre,
  checkpointFor,
  drawnAt,
  glyphSchedule,
  handwritingPaths,
  hitBox,
  isLocalMediaUri,
  progress,
  regionBox,
  toBoard,
  traceAt,
  tracePath,
  validateHitMap,
  type Action,
  type Aside,
  type Box,
  type Gesture,
  type HitMap,
  type Marks,
  type OpentypeLike,
  type Segment,
} from "./engine";
import { drawOn, el, fadeIn, setAttr, setImageHref } from "./dom";
import { RigAvatar, StubAvatar, type AvatarLike, type AvatarMeasure, type Placed, type Rig } from "./avatar";
import { CommandLog, type BoardCommand, type Outcome } from "./events";

export type { HitMap } from "./engine";
export type { Rig } from "./avatar";

const INK = "#14181F";
const MUTED = "#98A0A9";
const ACCENT = "#0C8175";
const MARKER = "#FFB020";
const STRIKE = "#B42318";
export const CKPT_KEY = "sk-s1:u4:cursor";

export type PlayerState = "ready" | "playing" | "paused" | "listening" | "answering" | "done";
export type Mode = "E" | "S";

export type ResumeTrial = {
  /** Clock when the barge-in landed and where playback resumed (ms). */
  pausedAt: number;
  resumedAt: number;
  rewindTo: number;
  /** Overlay stroke nodes before and after — equal means no redraw. */
  strokesBefore: number;
  strokesAfter: number;
  /** The clip reported `seeked` within 40 ms of the requested position. */
  seekExact: boolean;
  /** Event id of the command that caused it, when it came through `command()`. */
  eventId?: string;
};
export type ReloadRecovery = {
  saved: number;
  resumed: number;
  /** Elements on the board (hit map) at the saved cursor vs after restore. */
  drawnSaved: string[];
  drawnRestored: string[];
  boardMatch: boolean;
  /** Filled when the media element reports the seek landed: |t − resumed| ≤ 40 ms. */
  seekExact: boolean | null;
};
export type Measure = AvatarMeasure & {
  fps: number[];
  /** Prepared timeline: first frame an action was seen vs its scheduled start (drift = seen − scheduled). */
  actionFirstFrame: { id: string; scheduled: number; seen: number }[];
  /** Live overlay actions, same measure on the live clock. */
  liveFirstFrame: { id: string; scheduled: number; seen: number }[];
  pauseLatencyMs: number[];
  resumeTrials: ResumeTrial[];
  reloadRecovery: ReloadRecovery[];
  /** Commands ignored because their event id had been seen before. */
  duplicatesIgnored: number;
};
type Timed = { id: string; start: number; end: number; anims: Animation[]; onFrame?: (t: number) => void };

/** A live aside: a validated program (B4's gate) with, optionally, the spoken
 * answer. With `speech` the live clock is that audio; without, wall time. */
export type LiveAside = {
  question?: string;
  program: Pick<Aside, "actions" | "gestures"> & { duration_ms: number };
  speech?: { uri: string; marks?: Marks };
  /** How far back to resume after the answer (default 0: the exact pause point). */
  rewindMs?: number;
  /** Listening pause before the answer starts (ms, default 300: the VAD stand-in). */
  listenMs?: number;
};

const box4 = (b: [number, number, number, number]): Box => ({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] });
const SEEK_TOL_MS = 40;

export class SpikeRuntime {
  readonly measure: Measure = { fps: [], actionFirstFrame: [], liveFirstFrame: [], pauseLatencyMs: [], resumeTrials: [], reloadRecovery: [], gestureHits: [], writeSamples: [], listenLatencyMs: [], duplicatesIgnored: 0 };
  state: PlayerState = "ready";
  /** Board-level idempotency: every command with an event id runs once. */
  readonly commands = new CommandLog<unknown>();
  private timed: Timed[] = [];
  private asideTimed: Timed[] = [];
  private asideLayer!: SVGGElement;
  private defs!: SVGDefsElement;
  /** A live aside: actions scrubbed from the aside audio (speech) or a wall clock while the main clock is paused. */
  private live: { timed: Timed[]; gestures: Gesture[]; marks: Marks; start: number; duration: number; speech: boolean; seen: Set<string>; lastT: number; resolve: () => void } | null = null;
  private seen = new Set<string>();
  private pauseReq: number | null = null;
  private strokes = 0; // stroke elements created — a resume must not add any
  /** Strokes before the current live aside was compiled: clearing it restores this. */
  private liveStrokeBase = 0;
  private placed: Placed = {};
  private hitBoxes: Record<string, Box> = {};
  private readonly hitmap: HitMap | null;
  private pen!: SVGGElement;
  private penPos: { x: number; y: number } | null = null;
  private avatar!: AvatarLike;
  private raf = 0;
  private busy = false;
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
    // The hit map is data from the renderer's export: validated (and its
    // boxes clamped into the world) before anything is placed from it.
    this.hitmap = opts.mode === "S" && opts.hitmap ? validateHitMap(opts.hitmap) : null;
    if (this.hitmap) {
      this.W = this.hitmap.world.w;
      this.H = this.hitmap.world.h;
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

    if (this.hitmap) {
      // The clip carries the board. Placed boxes come from the renderer's hit
      // map so the aside and the avatar target the SAME pixels the video drew.
      const hm = this.hitmap;
      for (const [key, a] of Object.entries(hm.asset)) {
        // An Option-E asset of the same name (the U4 fixture) maps regions from
        // asset pixels; a B3 clip has none, so its regions come straight from the
        // hit map in world pixels as "key.region" hit boxes.
        const placeOp = this.seg.actions.find((x) => x.op === "place" && x.as === key);
        const fixture = placeOp && placeOp.op === "place" ? this.seg.assets[placeOp.ref.replace(/^asset:/, "")] : Object.values(this.seg.assets)[0];
        if (fixture) this.placed[key] = { box: box4(a.box), asset: fixture };
        this.hitBoxes[key] = box4(a.box);
        for (const [part, b] of Object.entries(a.regions)) this.hitBoxes[`${key}.${part}`] = box4(b);
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
      : new StubAvatar(avatarLayer, this.W, this.H, this.opts.mode === "S" ? 0.7 : 1);

    // Reload recovery: resume from the last checkpoint ≤ the saved cursor.
    try {
      const key = this.ckptKey();
      const raw = key ? localStorage.getItem(key) : null;
      if (raw && key) {
        const saved = JSON.parse(raw) as { t: number; drawn?: string[] };
        const at = checkpointFor(this.checkpoints(), saved.t);
        const rec: ReloadRecovery = {
          saved: saved.t,
          resumed: at,
          drawnSaved: saved.drawn ?? this.drawnAt(checkpointFor(this.checkpoints(), saved.t)),
          drawnRestored: this.drawnAt(at),
          boardMatch: false,
          seekExact: null,
        };
        rec.boardMatch = rec.drawnSaved.join(",") === rec.drawnRestored.join(",");
        this.seekTo(at).then((exact) => {
          rec.seekExact = exact;
          this.cb.log(`reload: seek landed ${exact ? "exactly" : "OFF"} at ${Math.round(this.t)} ms`);
        });
        this.measure.reloadRecovery.push(rec);
        this.cb.log(`reload: saved cursor ${saved.t} ms → resumed at checkpoint ${at} ms (board ${rec.boardMatch ? "same" : "DIFFERENT"})`);
        localStorage.removeItem(key);
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

  /** What the hit map says is on the board at t (S); the action ids started by t (E). */
  drawnAt(t: number): string[] {
    if (this.hitmap) return drawnAt(this.hitmap, t);
    return this.seg.actions.filter((a) => a.t <= t).map((a) => (a.op === "place" ? a.as : a.id));
  }

  /** World box of a target the board can see (hit-map element/region, placed asset, live node). */
  resolveTarget(target: string): Box | null {
    const [asId, ...rest] = target.split(".");
    const placed = this.placed[asId!];
    if (placed) return toBoard(placed.box, placed.asset, regionBox(placed.asset, rest.join(".") || undefined));
    if (this.hitBoxes[target]) return this.hitBoxes[target]!;
    if (this.hitmap) {
      const hb = hitBox(this.hitmap, target);
      if (hb) return hb;
    }
    const n = this.host.querySelector(`[data-id="${CSS.escape(target)}"]`) as SVGGraphicsElement | null;
    if (!n) return null;
    const bb = n.getBBox();
    return { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
  }

  // ── Commands with event ids (board-level idempotency) ───────────────────
  /** Apply a command once per event id. A repeat returns the stored outcome
   * (`duplicate: true`) and does nothing — the client half of contracts §5. */
  command(cmd: BoardCommand): Outcome<unknown> {
    const out = this.commands.apply(cmd, (c) => {
      switch (c.kind) {
        case "play":
          this.play();
          return true;
        case "pause":
          this.pause();
          return true;
        case "seek":
          this.seek(Number(c.args?.ms ?? 0));
          return true;
        case "rate":
          this.setRate(Number(c.args?.rate ?? 1));
          return true;
        case "erase":
          this.clearLiveAside();
          return true;
        case "resume":
          return this.resumeAfterTurn(Number(c.args?.rewindMs ?? 0), c.args?.at == null ? undefined : Number(c.args.at));
        case "interrupt":
          return this.interruptWith({ ...(c.args?.aside as LiveAside), eventId: c.eventId } as LiveAside & { eventId: string });
        case "aside":
          return this.playLiveAside((c.args?.program as LiveAside["program"]) ?? { actions: [], gestures: [], duration_ms: 0 }, c.args?.speech as LiveAside["speech"]);
      }
    });
    if (out.duplicate) {
      this.measure.duplicatesIgnored = this.commands.duplicates;
      this.cb.log(`duplicate ${cmd.kind} ${cmd.eventId.slice(0, 8)}… ignored`);
    }
    return out;
  }

  // ── B4 teacher-loop surface ─────────────────────────────────────────────
  /** Current main-clock position, ms. */
  /** B9: a viseme of SK's own spoken line (the speech element's clock). */
  mouth(viseme: string): void {
    this.avatar?.mouth?.(viseme);
  }

  get t(): number {
    return this.main.currentTime * 1000;
  }
  seek(ms: number): void {
    void this.seekTo(ms);
  }
  /** Seek and report whether the element landed within 40 ms of the request. */
  private seekTo(ms: number): Promise<boolean> {
    const at = Math.max(0, ms) / 1000;
    const done = new Promise<boolean>((resolve) => {
      const onSeeked = () => resolve(Math.abs(this.main.currentTime * 1000 - at * 1000) <= SEEK_TOL_MS);
      this.main.addEventListener("seeked", onSeeked, { once: true });
      setTimeout(() => {
        this.main.removeEventListener("seeked", onSeeked);
        resolve(Math.abs(this.main.currentTime * 1000 - at * 1000) <= SEEK_TOL_MS);
      }, 1500);
    });
    this.main.currentTime = at;
    this.scrub(at * 1000);
    return done;
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
    await this.seekTo(to);
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
    this.endLive();
    if (!this.asideAudio.paused) this.asideAudio.pause();
    while (this.asideLayer.firstChild) this.asideLayer.removeChild(this.asideLayer.firstChild);
    for (const d of Array.from(this.defs.children)) if (d.getAttribute("id")?.startsWith("g-")) this.defs.removeChild(d);
    // Re-compile the scripted aside (dev harness) so interrupt() still works.
    this.asideTimed = this.seg.aside ? this.compile(this.seg.aside.actions, this.asideLayer, this.defs, "a") : [];
    this.movePen(0, 0, false);
  }
  /** The live aside is over (finished or erased): release it and its stroke count. */
  private endLive(): void {
    if (!this.live) return;
    for (const tm of this.live.timed) for (const a of tm.anims) a.cancel();
    this.live.resolve();
    this.live = null;
    this.strokes = this.liveStrokeBase; // the aside's own nodes go with it
    this.movePen(0, 0, false);
  }
  /** Draw a VALIDATED live aside program on the aside layer. The program has
   * already passed the gate (`aside.ts`). With `speech` the clock is that
   * audio (word marks drive the mouth); without, wall time from now. Resolves
   * when the program's duration has elapsed (or it is cleared). */
  playLiveAside(program: Pick<Aside, "actions" | "gestures"> & { duration_ms: number }, speech?: { uri: string; marks?: Marks }): Promise<void> {
    this.clearLiveAside();
    this.liveStrokeBase = this.strokes;
    const timed = this.compile(program.actions, this.asideLayer, this.defs, "g");
    return new Promise<void>((resolve) => {
      const live = { timed, gestures: program.gestures, marks: speech?.marks ?? { words: [], visemes: [] }, start: performance.now(), duration: program.duration_ms, speech: !!speech, seen: new Set<string>(), lastT: -1, resolve };
      this.live = live;
      if (speech && !isLocalMediaUri(speech.uri)) {
        this.cb.log("aside speech refused: not a local media path; wall clock instead");
        live.speech = false;
      } else if (speech) {
        const a = this.asideAudio;
        if (a.getAttribute("src") !== speech.uri) a.src = speech.uri;
        a.currentTime = 0;
        a.play().catch((e) => {
          this.cb.log(`aside audio blocked (${(e as Error).message}); wall clock instead`);
          live.speech = false;
          live.start = performance.now();
        });
      }
    });
  }

  private checkpoints(): number[] {
    if (this.hitmap) return [0, ...this.hitmap.timeline.map((t) => t.start_ms)];
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
  /** Play and report whether the browser allowed it (autoplay policy after a reload). */
  async playAsync(): Promise<boolean> {
    try {
      await this.main.play();
      this.setState("playing");
      return true;
    } catch (e) {
      this.cb.log(`play blocked: ${(e as Error).message}`);
      return false;
    }
  }
  pause(): void {
    this.pauseReq = performance.now();
    this.main.pause();
    this.setState("paused");
  }

  /** Barge-in on the S1 fixture's scripted aside (kept for /dev/sk-spike). */
  async interrupt(): Promise<void> {
    const { seg } = this;
    if (!seg.aside) return;
    await this.interruptWith({ question: seg.aside.question, program: { actions: [], gestures: seg.aside.gestures, duration_ms: seg.aside.audio.duration_ms + 800 }, speech: { uri: this.base + seg.aside.audio.uri, marks: seg.aside.marks }, rewindMs: 1500, scripted: true } as LiveAside & { scripted: boolean });
  }

  /** Barge-in with a live aside: pause → listen → answer on the aside layer
   * (scrubbed from the answer's audio or wall time) → resume from the exact
   * pause point (or `rewindMs` back) WITHOUT redrawing: the clip is seeked,
   * the overlay is cleared, no stroke node is created. Records a ResumeTrial. */
  async interruptWith(aside: LiveAside & { eventId?: string; scripted?: boolean }): Promise<ResumeTrial | null> {
    const { main } = this;
    if (main.paused || this.busy) return null;
    this.busy = true;
    try {
      const strokesBefore = this.strokes;
      this.pauseReq = performance.now();
      main.pause();
      const pausedAt = main.currentTime * 1000;
      this.setState("listening");
      this.avatar.listen(true);
      this.cb.log(`interrupt at ${Math.round(pausedAt)} ms — listening${aside.question ? `: "${aside.question}"` : ""}`);
      await new Promise((r) => setTimeout(r, aside.listenMs ?? 300));
      this.avatar.listen(false);
      this.setState("answering");
      if (aside.scripted) {
        // The S1 fixture's aside was compiled at mount on the aside layer.
        const a = this.asideAudio;
        a.currentTime = 0;
        await a.play();
        await new Promise<void>((r) => a.addEventListener("ended", () => r(), { once: true }));
        await new Promise((r) => setTimeout(r, 800));
        for (const tm of this.asideTimed) for (const an of tm.anims) an.currentTime = 0;
      } else {
        await this.playLiveAside(aside.program, aside.speech);
        this.clearLiveAside();
      }
      const rewindTo = Math.max(0, pausedAt - (aside.rewindMs ?? 0));
      const seekExact = await this.seekTo(rewindTo);
      const trial: ResumeTrial = { pausedAt, resumedAt: main.currentTime * 1000, rewindTo, strokesBefore, strokesAfter: this.strokes, seekExact, eventId: aside.eventId };
      this.measure.resumeTrials.push(trial);
      this.cb.log(`resume from ${Math.round(rewindTo)} ms (strokes ${strokesBefore} → ${this.strokes}: ${this.strokes === strokesBefore ? "no redraw" : "REDRAW!"}; seek ${seekExact ? "exact" : "OFF"})`);
      await main.play();
      this.setState("playing");
      return trial;
    } finally {
      this.busy = false;
    }
  }

  summary(): Record<string, unknown> {
    const m = this.measure;
    const pct = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
      return { p50: p(0.5), p95: p(0.95), max: s.at(-1) ?? 0, n: s.length };
    };
    const drift = m.actionFirstFrame.map((a) => a.seen - a.scheduled);
    const liveDrift = m.liveFirstFrame.map((a) => a.seen - a.scheduled);
    const resumeOk = m.resumeTrials.filter((r) => r.strokesAfter === r.strokesBefore && r.seekExact).length;
    const reloadOk = m.reloadRecovery.filter((r) => r.boardMatch && r.seekExact !== false).length;
    return {
      segment: this.seg.segment_id,
      option: this.opts.mode,
      ua: navigator.userAgent,
      fps: { min: m.fps.length ? Math.min(...m.fps) : 0, avg: m.fps.reduce((a, b) => a + b, 0) / (m.fps.length || 1), n: m.fps.length },
      driftMs: pct(drift),
      liveDriftMs: pct(liveDrift),
      pauseLatencyMs: pct(m.pauseLatencyMs),
      resume: { ok: resumeOk, n: m.resumeTrials.length },
      reload: { ok: reloadOk, n: m.reloadRecovery.length },
      gestures: { point: pct(m.gestureHits.filter((g) => g.kind === "point").map((g) => g.arriveMs)), write: pct(m.gestureHits.filter((g) => g.kind === "write").map((g) => g.arriveMs)), writeHandPx: pct(m.writeSamples.map((w) => w.distancePx)), writeReachPx: pct(m.writeSamples.map((w) => w.reachPx)), listenMs: pct(m.listenLatencyMs) },
      duplicatesIgnored: this.commands.duplicates,
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
        const key = this.ckptKey();
        if (key) localStorage.setItem(key, JSON.stringify({ t, drawn: this.drawnAt(t) }));
      } catch {
        /* ignore */
      }
      this.avatar.frame(t, seg.marks, seg.gestures, this.placed, this.hitBoxes, this.measure, this.penPos);
    } else {
      if (this.pauseReq != null) {
        // First frame after the pause landed: that is the pause latency.
        this.measure.pauseLatencyMs.push(performance.now() - this.pauseReq);
        this.pauseReq = null;
      }
      // Paused with nothing live: SK still breathes, blinks and turns to listen.
      if (!this.live && aside.paused) this.avatar.frame(t, { words: [], visemes: [] }, [], this.placed, this.hitBoxes, this.measure, null);
    }
    if (main.ended && this.state === "playing") {
      this.setState("done");
      // A finished segment leaves no cursor behind — the next open starts fresh
      // (found when a completed Option S run "resumed" at its last second).
      try {
        const key = this.ckptKey();
        if (key) localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    if (!aside.paused && seg.aside && !this.live) {
      const ta = aside.currentTime * 1000;
      this.scrub(ta, "aside");
      this.avatar.frame(ta, seg.aside.marks, seg.aside.gestures, this.placed, this.hitBoxes, this.measure, this.penPos);
    }
    if (this.live) {
      const lv = this.live;
      const tl = lv.speech ? aside.currentTime * 1000 : performance.now() - lv.start;
      const consecutive = lv.lastT >= 0 && tl - lv.lastT >= 0 && tl - lv.lastT < 250;
      for (const tm of lv.timed) {
        for (const a of tm.anims) a.currentTime = tl;
        tm.onFrame?.(tl);
        if (tl >= tm.start && !lv.seen.has(tm.id)) {
          lv.seen.add(tm.id);
          if (consecutive) this.measure.liveFirstFrame.push({ id: tm.id, scheduled: tm.start, seen: tl });
        }
      }
      lv.lastT = tl;
      this.avatar.frame(tl, lv.marks, lv.gestures, this.placed, this.hitBoxes, this.measure, this.penPos);
      const finished = lv.speech ? aside.ended || (aside.paused && tl > 0) || tl >= lv.duration : tl >= lv.duration;
      if (finished) this.endLive();
    }
    this.frames++;
    const now = performance.now();
    if (!this.lastFps) this.lastFps = now;
    if (now - this.lastFps >= 1000) {
      if (!main.paused || !aside.paused || this.live) this.measure.fps.push(this.frames);
      this.frames = 0;
      this.lastFps = now;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private movePen(x: number, y: number, show: boolean) {
    setAttr(this.pen, "transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    setAttr(this.pen, "opacity", show ? "1" : "0");
    this.penPos = show ? { x, y } : null;
  }

  // ── compile actions → DOM + paused animations ──────────────────────────────
  private compile(actions: Action[], layer: SVGGElement, defs: SVGDefsElement, prefix: string): Timed[] {
    const out: Timed[] = [];
    const nodes = new Map<string, SVGElement>();
    const { font, base, seg, u } = this;
    const resolveTarget = (target: string): Box | null => {
      const n = nodes.get(target) as SVGGraphicsElement | undefined;
      if (n) {
        const bb = n.getBBox();
        return { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
      }
      return this.resolveTarget(target);
    };

    for (const a of actions) {
      if (a.op === "place") {
        const asset = seg.assets[a.ref.replace(/^asset:/, "")];
        if (!asset) continue;
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
        setImageHref(img, base + asset.src);
        inner.appendChild(img);
        layer.appendChild(inner);
        nodes.set(a.as, inner);
        nodes.set(`${a.as}__maskStroke`, stroke);
        nodes.set(`${a.as}__maskFull`, full);
      } else if (a.op === "reveal") {
        const stroke = nodes.get(`${a.target}__maskStroke`);
        const full = nodes.get(`${a.target}__maskFull`);
        const placed = this.placed[a.target];
        if (!stroke || !full || !placed) continue;
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
            this.movePen(b.x, b.y, true);
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
            if (p <= 0 || p >= 1 || !glyphs.length) return;
            const rel = p * a.dur;
            const i = Math.max(0, sched.findIndex(([, e]) => rel < e));
            const gl = glyphs[i]!;
            const q = progress(rel, sched[i]![0], sched[i]![1] - sched[i]![0]);
            this.movePen(gl.bbox.x + gl.bbox.w * q, gl.bbox.y + gl.bbox.h * 0.6, true);
          },
        });
      } else if (a.op === "highlight") {
        const b = resolveTarget(a.target);
        if (!b) continue;
        const shape =
          a.style === "circle"
            ? el("ellipse", { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2 + 2.5 * u, ry: b.h / 2 + 2 * u, fill: "none", stroke: MARKER, "stroke-width": 0.9 * u, opacity: 0.9 })
            : el("line", { x1: b.x - 0.5 * u, y1: b.y + b.h * 0.55, x2: b.x + b.w + 0.5 * u, y2: b.y + b.h * 0.45, stroke: STRIKE, "stroke-width": 0.6 * u });
        setAttr(shape, "data-id", a.id);
        layer.appendChild(shape);
        nodes.set(a.id, shape);
        this.strokes++;
        out.push({ id: a.id, start: a.t, end: a.t + a.dur, anims: [drawOn(shape, a.t, a.dur)] });
      }
    }
    return out;
  }
}

