// SK B4 — the gate for a LIVE aside program (the model's answer to a question,
// drawn on the aside layer over the paused segment). The program is DATA from
// a model: it goes through the same `validateSegment` the prepared fixture
// passes (ids, text, numbers, op allow-list, duplicate ids against the base
// actions) plus the rules a live aside adds:
//   * only label / highlight / write — nothing that places or reveals assets;
//   * every target must resolve: a placed asset instance (optionally one of
//     its regions) or an element the clip's hit map drew;
//   * bounded: ≤ 12 actions, ≤ 20 s, every action inside the duration.
// A program that fails is dropped WHOLE; the student still gets the spoken
// answer (never a partial drawing — the ERE rule).

import { LIMITS, SegmentError, validateSegment, type Action, type Gesture, type Segment } from "./board/engine";

export const ASIDE_TAL = "0.2-aside" as const;
export const ASIDE_LIMITS = { actions: 12, duration: 20_000, gestures: 12 } as const;
export const ASIDE_OPS = new Set(["label", "highlight", "write"]);

export type AsideProgram = { tal: typeof ASIDE_TAL; duration_ms: number; actions: Action[]; gestures: Gesture[] };

export type AsideTargets = {
  /** Placed asset instance id → its region names ("mic" → ["eyepiece lens", …]). */
  placed: Record<string, string[]>;
  /** Ids from the hit map: elements the clip drew ("l1"), its illustration
   * ("ill") and the illustration's regions ("ill.arm") — all in world pixels. */
  elements: string[];
};

/** What the model may target, derived from the segment (and the hit map when there is one). */
export function asideTargets(seg: Segment, hitmapElementIds: string[] = []): AsideTargets {
  const placed: Record<string, string[]> = {};
  for (const a of seg.actions) if (a.op === "place") placed[a.as] = Object.keys(seg.assets[a.ref.replace(/^asset:/, "")]?.regions ?? {});
  return { placed, elements: hitmapElementIds.filter((id) => !placed[id]) };
}

export function targetResolves(target: string, targets: AsideTargets): boolean {
  const [root, ...rest] = target.split(".");
  const part = rest.join(".");
  if (root && targets.placed[root]) return !part || targets.placed[root]!.includes(part);
  return targets.elements.includes(target);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Throws SegmentError; returns the program otherwise. */
export function validateAside(raw: unknown, seg: Segment, hitmapElementIds: string[] = []): AsideProgram {
  if (!isObj(raw)) throw new SegmentError("aside: not an object");
  if (raw.tal != null && raw.tal !== ASIDE_TAL) throw new SegmentError(`aside: unsupported tal ${String(raw.tal)}`);
  const actions = raw.actions;
  if (!Array.isArray(actions)) throw new SegmentError("aside: actions must be an array");
  if (actions.length > ASIDE_LIMITS.actions) throw new SegmentError(`aside: too many actions (${actions.length} > ${ASIDE_LIMITS.actions})`);
  const gestures = raw.gestures == null ? [] : raw.gestures;
  if (!Array.isArray(gestures) || gestures.length > ASIDE_LIMITS.gestures) throw new SegmentError("aside: bad gestures");
  for (const a of actions) {
    if (!isObj(a) || !ASIDE_OPS.has(String(a.op))) throw new SegmentError(`aside: op ${isObj(a) ? String(a.op) : "?"} is not allowed in a live aside`);
  }
  // Structural pass: the shared validator over a synthetic segment whose aside
  // IS this program (base actions kept so a reused id is caught).
  const synthetic: Segment = { ...seg, aside: { question: "", audio: { uri: "", duration_ms: 0 }, marks: { words: [], visemes: [] }, ...seg.aside, actions: actions as Action[], gestures: gestures as Gesture[] } };
  validateSegment(synthetic);
  // Semantic pass: targets and timing.
  const targets = asideTargets(seg, hitmapElementIds);
  let end = 0;
  for (const a of actions as Action[]) {
    if ("target" in a && !targetResolves(a.target, targets)) throw new SegmentError(`aside: target ${a.target} does not resolve`);
    const dur = "dur" in a ? a.dur : 0;
    end = Math.max(end, a.t + dur);
  }
  for (const g of gestures as Gesture[]) {
    if (!["point", "write", "listen", "idle"].includes(g.kind)) throw new SegmentError(`aside: bad gesture kind ${String(g.kind)}`);
    if (g.target && !targetResolves(g.target, targets)) throw new SegmentError(`aside: gesture target ${g.target} does not resolve`);
    end = Math.max(end, g.until ?? g.t);
  }
  const declared = typeof raw.duration_ms === "number" && Number.isFinite(raw.duration_ms) ? Math.floor(raw.duration_ms) : end;
  const duration_ms = Math.max(declared, end);
  if (duration_ms > ASIDE_LIMITS.duration) throw new SegmentError(`aside: too long (${duration_ms} ms > ${ASIDE_LIMITS.duration})`);
  for (const a of actions as Action[]) if ("text" in a && a.text.length > LIMITS.text) throw new SegmentError("aside: text too long");
  return { tal: ASIDE_TAL, duration_ms, actions: actions as Action[], gestures: gestures as Gesture[] };
}
