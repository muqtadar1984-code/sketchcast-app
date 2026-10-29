// The SK Shell ⇄ Classroom Board bridge (Final Plan §2.4, S1 slice B). PURE:
// no React, no DOM, no fetch of its own — the controller, the open unit, the
// lesson map and the clock are injected, so every move is unit-tested on a
// fake controller.
//
// Two jobs:
//   1. `state()` — what the collector posts with each turn (SkBoardState): the
//      session, where the video is, the open segment, and the lesson map's
//      headings/concepts so the SERVER can resolve "slide 4" / "explain
//      diffusion" without a database read.
//   2. `run(move, args)` — each SkBoardMove the server decided, mapped onto
//      BoardController calls (src/app/present/board-controller.ts, M2 + the
//      slice C ports `getUnit()` and `showQuestions(start, count)`). The
//      controller has no "play to end_s then pause", so `segment` seeks +
//      resumes and a 250 ms poll of getState().t pauses at the segment's end.
//      The segment's end stays the active "stop at" target across a
//      pause/resume pair (SK speaking mid-segment pauses the video and gives
//      it back; the stop must survive that) until a seek-class move — intro,
//      segment, slide/explain/compare, recap — replaces it.
//      `practise n` opens a WINDOW of n questions from the first worksheet item
//      mapped to the current segment; `walkthrough` opens the whole set.
//
// Which unit is open comes from the controller (`getUnit()`, S1 slice C) —
// the bridge no longer infers it from the audit sink.
//
// The manifest adapter below is STRUCTURAL: slice A's `toBoardManifest` in
// src/sk/manifest/board.ts replaces `toBridgeManifest` once both land; the
// shape it produces (BoardManifest + ids/concepts/items) is what the bridge
// consumes, and nothing else in this file knows the KitManifest.

import type { BoardController, BoardManifest, BoardUnit, ManifestSegment, VisualVerdict } from "./board-controller";
import type { SkBoardMove, SkBoardState, SkSelection } from "@/sk/shell/types";

// ── manifest adapter ────────────────────────────────────────────────────────

/** The parts of a KitManifest (src/sk/manifest/derive.ts) the Board needs. */
export type KitManifestLike = {
  manifest_id: string;
  segments: Array<{
    segment_id: string;
    part: number;
    k: number;
    start_s: number;
    end_s: number;
    slide_t?: number | null;
    heading?: string | null;
    points?: string[] | null;
    visual?: { status: VisualVerdict["status"]; show: VisualVerdict["show"]; fallback_k?: number; reason: string } | null;
  }>;
  concepts?: Array<{ concept_id: string; name: string; segment_ids: string[] }> | null;
  items?: Array<{ q_id: string; source: string; generation_id: string; segment_ids: string[] }> | null;
};

export type BridgeManifest = BoardManifest & {
  manifestId: string;
  /** The manifest segment_id of each Board segment, same order as `segments`. */
  ids: string[];
  concepts: Array<{ id: string; name: string; segmentIds: string[] }>;
  items: Array<{ qId: string; source: string; generationId: string; segmentIds: string[] }>;
};

const UNKNOWN: VisualVerdict = { status: "unknown", show: "caption_only", reason: "no visual verdict in the manifest" };

/** The Board manifest for ONE unit: the segments of `part` (all of them for a
 *  whole-chapter kit, part null) in play order, fallback frames remapped to
 *  the unit's own indices (a fallback outside the unit degrades to caption). */
export function toBridgeManifest(m: KitManifestLike, part: number | null): BridgeManifest {
  const chosen = m.segments.filter((s) => part === null || s.part === part).sort((a, b) => a.start_s - b.start_s || a.k - b.k);
  const localK = new Map<number, number>();
  chosen.forEach((s, i) => localK.set(s.k, i));
  const segments: ManifestSegment[] = chosen.map((s) => {
    const seg: ManifestSegment = { start_s: s.start_s, end_s: s.end_s };
    if (typeof s.slide_t === "number") seg.slide_t = s.slide_t;
    if (s.heading) seg.heading = s.heading;
    if (Array.isArray(s.points)) seg.points = s.points.filter((p): p is string => typeof p === "string" && !!p.trim());
    const v = s.visual ?? UNKNOWN;
    const visual: VisualVerdict = { status: v.status, show: v.show, reason: v.reason };
    if (v.show === "fallback_frame") {
      const local = typeof v.fallback_k === "number" ? localK.get(v.fallback_k) : undefined;
      if (local === undefined) {
        visual.show = "caption_only";
        visual.reason = `fallback segment is not in this unit; ${v.reason}`;
      } else visual.fallback_k = local;
    }
    seg.visual = visual;
    return seg;
  });
  return {
    manifestId: m.manifest_id,
    segments,
    ids: chosen.map((s) => s.segment_id),
    concepts: (m.concepts ?? []).map((c) => ({ id: c.concept_id, name: c.name, segmentIds: [...(c.segment_ids ?? [])] })),
    items: (m.items ?? []).map((i) => ({ qId: i.q_id, source: i.source, generationId: i.generation_id, segmentIds: [...(i.segment_ids ?? [])] })),
  };
}

// ── manifest loading (GET/POST /api/sk/manifest, slice A's contract) ────────

export type ManifestReply = { status: "ready"; manifest: KitManifestLike } | { status: "building" | "stale" | "failed" | "missing" };
export type ManifestStatus = "none" | "building" | "ready" | "failed";
export type ManifestFetch = (generationId: string, method: "GET" | "POST") => Promise<ManifestReply>;

export const MANIFEST_POLL_MS = 3000;
export const MANIFEST_MAX_MS = 120_000;

export type LoadManifestResult = { status: "ready"; manifest: KitManifestLike } | { status: "failed"; reason: "failed" | "missing" | "timeout" | "aborted" | "error" };

/**
 * Fetch the kit manifest for a video generation. `building` polls every 3 s
 * for at most 2 min; `missing`/`stale` asks for a (re)build once (POST) and
 * then polls. `onStatus` drives the panel's "preparing the lesson map…".
 */
export async function loadManifest(
  fetchReply: ManifestFetch,
  generationId: string,
  opts: { pollMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; onStatus?: (s: ManifestStatus) => void; signal?: AbortSignal } = {},
): Promise<LoadManifestResult> {
  const pollMs = opts.pollMs ?? MANIFEST_POLL_MS;
  const maxMs = opts.maxMs ?? MANIFEST_MAX_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  let requested = false;
  let method: "GET" | "POST" = "GET";
  for (;;) {
    if (opts.signal?.aborted) return { status: "failed", reason: "aborted" };
    let reply: ManifestReply;
    try {
      reply = await fetchReply(generationId, method);
    } catch {
      opts.onStatus?.("failed");
      return { status: "failed", reason: "error" };
    }
    method = "GET";
    if (reply.status === "ready") {
      opts.onStatus?.("ready");
      return { status: "ready", manifest: reply.manifest };
    }
    if (reply.status === "failed") {
      opts.onStatus?.("failed");
      return { status: "failed", reason: "failed" };
    }
    if (reply.status === "missing" || reply.status === "stale") {
      if (requested) {
        // Asked once already and it is still not there: nothing to wait for.
        if (reply.status === "missing") {
          opts.onStatus?.("failed");
          return { status: "failed", reason: "missing" };
        }
      } else {
        requested = true;
        method = "POST";
      }
    }
    opts.onStatus?.("building");
    if (now() - t0 >= maxMs) {
      opts.onStatus?.("failed");
      return { status: "failed", reason: "timeout" };
    }
    await sleep(pollMs);
  }
}

// ── the bridge ──────────────────────────────────────────────────────────────

export type BridgeDeps = {
  controller: () => BoardController | null;
  /** Optional fallback for the open unit's generation when the controller has
   *  no `unit` port (an older host). The controller's `getUnit()` wins. */
  generationId?: () => string | null;
  manifest: () => BridgeManifest | null;
  mapStatus: () => ManifestStatus;
  /** The bar's current pick (class / book + chapter / ready-made kit) BEFORE
   *  a lesson runs, so "start the video" on an idle Board can start that
   *  lesson. Ids only; the server re-checks them before it navigates. */
  selection?: () => SkSelection | undefined;
  /** Board UX (2026-10-28): the unit rail overlay — a UI control the host
   *  owns (present-client state), NOT a controller move and not audited.
   *  `rail(open)` sets it; `railOpen()` reads it for toggle. */
  rail?: (open: boolean) => void;
  railOpen?: () => boolean;
  /** Told of a slides load's progress (k of n) and of its end (null), so the
   *  Board itself can show it as well as the panel's tray. */
  onLoading?: (progress: { k: number; n: number } | null) => void;
  /** Polling cadence for the segment-end watcher. */
  pollMs?: number;
  now?: () => number;
};

export type BridgeRun = {
  ok: boolean;
  summary: string;
  /** True when the move left the video playing. */
  plays?: boolean;
  /** load_slides only: how many pages it made and where they sit (1-based,
   *  inclusive) — the panel turns these into its localized closing line. */
  loaded?: { n: number; a: number; b: number; aborted: boolean };
};

export type SkBoardBridge = {
  state(): SkBoardState | undefined;
  /** What the bar has picked (see BridgeDeps.selection); undefined when nothing. */
  selection(): SkSelection | undefined;
  status(): ManifestStatus;
  /** The open unit, from the controller. */
  unit(): BoardUnit | null;
  run(move: SkBoardMove, args: Record<string, unknown>): Promise<BridgeRun>;
  /** The unit rail overlay (Board UX 2026-10-28): a UI port for the host and
   *  for SK's `rail` move. Nothing is audited; nothing touches the video. */
  rail(action: "open" | "close" | "toggle"): void;
  /** A slides-as-pages load in progress — k of n — for the panel's tray. */
  loading(): { k: number; n: number } | null;
  dispose(): void;
};

export const SEGMENT_END_SLACK_S = 0.05;

/** The segment the playhead is in (start ≤ t < end), else the last one it has passed. */
export function segmentAt(manifest: BoardManifest, t: number): number | undefined {
  let k: number | undefined;
  manifest.segments.forEach((s, i) => {
    if (t >= s.start_s && t < s.end_s) k = i;
  });
  if (k !== undefined) return k;
  for (let i = manifest.segments.length - 1; i >= 0; i--) if (t >= manifest.segments[i].end_s) return i;
  return manifest.segments.length ? 0 : undefined;
}

/** Index of the first worksheet question mapped to `segmentId` (q_ids are
 *  "ws:q3" → the third card), else 0. Pure. */
export function practiseStart(manifest: BridgeManifest | null, segmentId: string | undefined): number {
  if (!manifest || !segmentId) return 0;
  const idx = manifest.items
    .filter((i) => i.source === "worksheet" && i.segmentIds.includes(segmentId))
    .map((i) => /(?:^|:)q(\d+)$/i.exec(i.qId))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]) - 1)
    .filter((n) => Number.isInteger(n) && n >= 0);
  return idx.length ? Math.min(...idx) : 0;
}

const intArg = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
};

export function createBoardBridge(deps: BridgeDeps): SkBoardBridge {
  const pollMs = deps.pollMs ?? 250;
  const now = deps.now ?? (() => Date.now());
  let watcher: ReturnType<typeof setTimeout> | null = null;
  let watching = 0;
  /** The segment end the video must stop at, kept across pause/resume. */
  let stopAt: { endS: number; startS: number } | null = null;
  /** The slides load under way, for the panel's "Loading slide k of n…". */
  let loading: { k: number; n: number } | null = null;

  const rail = (action: "open" | "close" | "toggle") => {
    const open = action === "toggle" ? !(deps.railOpen?.() ?? false) : action === "open";
    deps.rail?.(open);
  };

  /** Stop the timer; `clearTarget` also forgets the stop (a seek-class move). */
  const stopWatch = (clearTarget = true) => {
    watching++;
    if (watcher) clearTimeout(watcher);
    watcher = null;
    if (clearTarget) stopAt = null;
  };

  /** Pause when the playhead reaches `endS` — or give up after the segment's
   *  own length twice over, so a stalled video never leaves a timer behind. */
  const watchUntil = (c: BoardController, endS: number, startS: number) => {
    stopWatch();
    stopAt = { endS, startS };
    const id = watching;
    const deadline = now() + Math.max(5_000, (endS - startS) * 2_000 + 5_000);
    const tick = () => {
      if (id !== watching) return;
      const st = c.getState();
      if (st.ended) return;
      if (st.t >= endS - SEGMENT_END_SLACK_S || now() > deadline) {
        try {
          c.pause();
        } catch {
          /* the Board's own pause failing is not the bridge's to report */
        }
        watcher = null;
        stopAt = null; // reached: nothing left to stop at
        return;
      }
      watcher = setTimeout(tick, pollMs);
    };
    watcher = setTimeout(tick, pollMs);
  };

  const needManifest = (): { ok: true; m: BridgeManifest } | { ok: false; summary: string } => {
    const m = deps.manifest();
    if (!m || !m.segments.length) return { ok: false, summary: deps.mapStatus() === "building" ? "The lesson map is still being prepared." : "No lesson map for this video." };
    return { ok: true, m };
  };

  const segK = (m: BridgeManifest, v: unknown): { ok: true; k: number } | { ok: false; summary: string } => {
    const k = intArg(v);
    if (k === null || k >= m.segments.length) return { ok: false, summary: `This lesson has ${m.segments.length} slides.` };
    return { ok: true, k };
  };

  /** The open unit: the controller's port first, the host's fallback second. */
  const unitOf = (c: BoardController | null): BoardUnit | null => {
    const u = c?.getUnit?.() ?? null;
    if (u?.generationId) return u;
    const g = deps.generationId?.() ?? null;
    return g ? { generationId: g, part: u?.part ?? null, title: u?.title ?? null } : u;
  };

  return {
    status: () => deps.mapStatus(),

    selection: () => deps.selection?.(),

    unit: () => unitOf(deps.controller()),

    rail,

    loading: () => loading,

    state() {
      const c = deps.controller();
      if (!c) return undefined;
      const st = c.getState();
      if (st.ended) return undefined;
      const m = deps.manifest();
      const out: SkBoardState = { sessionId: st.sessionId, t: Math.round(st.t * 10) / 10, paused: st.paused, rollPage: st.page };
      const g = unitOf(c)?.generationId ?? null;
      if (g) out.generationId = g;
      if (m) {
        out.manifestId = m.manifestId;
        const k = segmentAt(m, st.t);
        if (k !== undefined) {
          out.k = k;
          if (m.ids[k]) out.segmentId = m.ids[k];
        }
        out.segments = m.segments.map((s, i) => ({ k: i, heading: s.heading ?? "", ...(m.ids[i] ? { id: m.ids[i] } : {}), ...(s.points?.length ? { points: s.points.slice(0, 8) } : {}) }));
        out.concepts = m.concepts;
      }
      return out;
    },

    async run(move, args) {
      const a = args ?? {};
      // The rail is a UI control: it needs no session and audits nothing.
      if (move === "rail") {
        if (!deps.rail) return { ok: false, summary: "This Board has no unit rail." };
        const open = a.open !== false;
        rail(open ? "open" : "close");
        return { ok: true, summary: open ? "Unit rail open." : "Unit rail closed." };
      }
      const c = deps.controller();
      if (!c) return { ok: false, summary: "Open the Board first." };
      // A new move stops a slides load after the frame in hand (pages made stay).
      if (move !== "load_slides") c.cancelLoad?.();
      try {
        switch (move) {
          case "intro": {
            stopWatch();
            await c.seek(0);
            await c.play();
            return { ok: true, summary: "Playing from the start.", plays: true };
          }
          case "segment": {
            const mm = needManifest();
            if (!mm.ok) return mm;
            const kk = segK(mm.m, a.k);
            if (!kk.ok) return kk;
            const seg = mm.m.segments[kk.k];
            await c.seekSegment(kk.k, "start", mm.m);
            await c.resume();
            watchUntil(c, seg.end_s, seg.start_s);
            return { ok: true, summary: `Playing segment ${kk.k + 1}; pausing at its end.`, plays: true };
          }
          case "slide":
          case "explain":
          case "compare": {
            const mm = needManifest();
            if (!mm.ok) return mm;
            // explain/compare arrive already resolved by the server (move
            // "slide" with k); a raw explain/compare without k has no slide.
            const kk = segK(mm.m, a.k);
            if (!kk.ok) return move === "slide" ? kk : { ok: false, summary: "I couldn't match that to a slide." };
            stopWatch();
            const r = await c.slide(kk.k, mm.m);
            const how = r.shown === "caption" ? "as a caption" : r.shown === "fallback_frame" ? `with slide ${r.shownK + 1}'s frame` : "";
            return { ok: true, summary: `Slide ${kk.k + 1}${how ? ` ${how}` : ""}.` };
          }
          case "practise": {
            stopWatch(false);
            const n = Math.max(1, intArg(a.n) ?? 3);
            const m = deps.manifest();
            const st = c.getState();
            const segId = typeof a.segmentId === "string" ? a.segmentId : m ? m.ids[segmentAt(m, st.t) ?? -1] : undefined;
            const start = practiseStart(m, segId);
            // A window of n from the first worksheet question mapped to the
            // current segment; next/previous stay inside it (slice C).
            const r = await c.showQuestions(start, n);
            const shown = r.shown ?? Math.min(n, r.total - start);
            const of = r.of ?? r.total;
            const range = shown > 1 ? `q${start + 1}–q${start + shown}` : `q${start + 1}`;
            return { ok: true, summary: `Showing ${shown} of ${of} questions (${range}).` };
          }
          case "walkthrough": {
            stopWatch(false);
            // The whole set, in order: no window.
            const r = await c.showQuestions(0);
            return { ok: true, summary: `Worksheet question 1 of ${r.total} on the roll.` };
          }
          case "freeze": {
            // The frame goes onto the roll; the segment's stop stays for a later resume.
            stopWatch(false);
            await c.freeze();
            return { ok: true, summary: "Frame frozen onto the roll." };
          }
          case "blank": {
            // AFTER THE CURRENT PAGE, not at the end: on page 3 of the slide
            // pages "blank page" is a note between slides 3 and 4. On the last
            // page it is the append it always was.
            const page = c.getState().page;
            c.blankPage({ after: page });
            return { ok: true, summary: `Blank page added after page ${page + 1}.` };
          }
          case "load_slides": {
            const mm = needManifest();
            if (!mm.ok) return mm;
            if (!c.loadSlides) return { ok: false, summary: "This Board cannot load slides as pages." };
            stopWatch();
            const n = mm.m.segments.length;
            const progress = (p: { k: number; n: number } | null) => {
              loading = p;
              deps.onLoading?.(p);
            };
            progress({ k: 0, n });
            try {
              const r = await c.loadSlides(mm.m, { onProgress: (k, total) => progress({ k, n: total }) });
              if (!r.pages) return { ok: false, summary: "Stopped before the first slide." };
              const range = r.pages > 1 ? `pages ${r.firstPage + 1}–${r.lastPage + 1}` : `page ${r.firstPage + 1}`;
              const tail = r.aborted ? ` (stopped after ${r.pages} of ${n})` : "";
              return {
                ok: true,
                summary: `${r.pages} slides are on the roll as ${range}${tail}. Page up and page down move between them; say 'blank page' to add one in between.`,
                loaded: { n: r.pages, a: r.firstPage + 1, b: r.lastPage + 1, aborted: r.aborted },
              };
            } finally {
              progress(null);
            }
          }
          case "back": {
            c.pageUp();
            return { ok: true, summary: "Back one page." };
          }
          case "resume": {
            await c.resume();
            // Still inside a segment move: re-arm the same stop (slice E's
            // coordinator pauses while SK speaks and resumes after).
            if (stopAt) watchUntil(c, stopAt.endS, stopAt.startS);
            return { ok: true, summary: "Resumed.", plays: true };
          }
          case "pause": {
            stopWatch(false);
            c.pause();
            return { ok: true, summary: "Paused." };
          }
          case "recap": {
            stopWatch();
            await c.endSession();
            return { ok: true, summary: "Lesson ended; the recap draft is open." };
          }
          default:
            return { ok: false, summary: `Unknown move ${String(move)}.` };
        }
      } catch (e) {
        return { ok: false, summary: e instanceof Error ? e.message : String(e) };
      }
    },

    dispose: () => stopWatch(),
  };
}
