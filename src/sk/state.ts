// SK B4 — the §4 state machine, as pure data + one transition function.
//
//   GUIDE:  ONBOARD → IDLE ⇄ NAVIGATING
//   TEACH:  LOADING_GRAPH → PRESENTING ⇄ PAUSED
//           barge-in → LISTENING → UNDERSTANDING
//             ├ command  → PRESENTING (applied in place)
//             ├ route    → PLANNING → (CHECK) → PRESENTING; bookmark pushed
//             ├ question → ANSWERING → RESUMING (rewind 1.5 s) → PRESENTING
//             └ answer   → GRADING (only while a check is open)
//   ASSESS: ASKING → AWAITING → CONFIRM_TRANSCRIPT(spoken) → GRADING
//           → FEEDBACK → HINT(attempt+1) | NEXT → (ASKING | PRESENTING)
//
// The server owns this state; every transition is persisted by the caller
// under an idempotent event id (contracts §5). `transition` never throws: an
// event the current state does not accept returns { ok: false, reason } so a
// replayed or out-of-order client request cannot corrupt a session.

import type { Bookmark, Cursor } from "./types";

export type SkPhase = "GUIDE" | "TEACH" | "ASSESS";

export type SkState =
  // GUIDE
  | "ONBOARD"
  | "IDLE"
  | "NAVIGATING"
  // TEACH
  | "LOADING_GRAPH"
  | "PRESENTING"
  | "PAUSED"
  | "LISTENING"
  | "UNDERSTANDING"
  | "PLANNING"
  | "CHECK"
  | "ANSWERING"
  | "RESUMING"
  // ASSESS
  | "ASKING"
  | "AWAITING"
  | "CONFIRM_TRANSCRIPT"
  | "GRADING"
  | "FEEDBACK"
  | "HINT"
  | "NEXT";

export const PHASE_OF: Record<SkState, SkPhase> = {
  ONBOARD: "GUIDE",
  IDLE: "GUIDE",
  NAVIGATING: "GUIDE",
  LOADING_GRAPH: "TEACH",
  PRESENTING: "TEACH",
  PAUSED: "TEACH",
  LISTENING: "TEACH",
  UNDERSTANDING: "TEACH",
  PLANNING: "TEACH",
  CHECK: "TEACH",
  ANSWERING: "TEACH",
  RESUMING: "TEACH",
  ASKING: "ASSESS",
  AWAITING: "ASSESS",
  CONFIRM_TRANSCRIPT: "ASSESS",
  GRADING: "ASSESS",
  FEEDBACK: "ASSESS",
  HINT: "ASSESS",
  NEXT: "ASSESS",
};

export const phaseOf = (s: SkState): SkPhase => PHASE_OF[s];

/** A check that is open: items asked one at a time; attempts and hints per item. */
export type OpenCheck = {
  unitKey: string;
  itemIds: string[];
  /** Index of the item being asked. */
  index: number;
  attemptNo: number;
  hintsUsed: number;
  purpose: "skip" | "prereq" | "unit" | "practise";
  /** One entry per finished item: did the student get it right (any attempt)? */
  results: boolean[];
  /** Was every finished item right at attempt 1 with no hint? (independent evidence) */
  independent: boolean;
  /** The grade of the item just marked, consumed by `next_item`. */
  lastCorrect?: boolean;
};

export type MachineState = {
  state: SkState;
  cursor: Cursor;
  bookmarks: Bookmark[];
  openCheck: OpenCheck | null;
  /** Playback rate the "slower" command adjusts; 1 = normal. */
  rate: number;
  /** Units the student skipped WITHOUT taking (or finishing) the 2-item check
   * (founder, 2026-10-27): recorded as skipped, never as mastered — no
   * mastery row is written, and the view shows them so the student (and a
   * dashboard) can see what was passed over. A later passed check removes
   * the key. Absent on rows stored before this field existed ⇒ []. */
  skipped?: string[];
};

/** The skipped list of a machine, tolerant of rows stored before the field existed. */
export const skippedOf = (m: MachineState): string[] => m.skipped ?? [];

export function withSkipped(m: MachineState, unitKey: string): MachineState {
  const cur = skippedOf(m);
  return cur.includes(unitKey) ? m : { ...m, skipped: [...cur, unitKey] };
}

export function withoutSkipped(m: MachineState, unitKey: string): MachineState {
  const cur = skippedOf(m);
  return cur.includes(unitKey) ? { ...m, skipped: cur.filter((k) => k !== unitKey) } : m;
}

/** How far a question's resume rewinds (plan §4: "rewind 1–2 s"; S1 used 1.5 s). */
export const RESUME_REWIND_MS = 1500;
export const MAX_BOOKMARKS = 20;
export const RATE_MIN = 0.6;
export const RATE_MAX = 1.25;
export const RATE_STEP = 0.15;

export type NewCheck = Pick<OpenCheck, "unitKey" | "itemIds" | "purpose">;

export type SkEvent =
  | { kind: "onboard_done" }
  | { kind: "navigate" }
  | { kind: "arrive" }
  | { kind: "open_chapter" }
  | { kind: "graph_loaded"; cursor: Cursor }
  | { kind: "tick"; t: number }
  | { kind: "pause"; t?: number }
  | { kind: "play" }
  | { kind: "seek"; t: number }
  | { kind: "set_rate"; rate: number }
  | { kind: "segment_ended" }
  | { kind: "barge_in"; t?: number }
  | { kind: "utterance" }
  | { kind: "intent"; intent: "command" | "route" | "question" | "answer" }
  /** A typed/button command that re-routes (no utterance to understand). */
  | { kind: "route_requested" }
  /** The planner decided. A bookmark is pushed BEFORE the cursor moves;
   * `popBookmark` is how "return" consumes the one it came back to. */
  | { kind: "planned"; cursor: Cursor; bookmark?: boolean; popBookmark?: boolean; check?: NewCheck }
  | { kind: "answered" }
  | { kind: "ask" }
  | { kind: "asked" }
  | { kind: "response"; modality: "typed" | "spoken"; transcriptConfirmed?: boolean }
  | { kind: "transcript_confirmed" }
  | { kind: "graded"; correct: boolean }
  | { kind: "hint" }
  | { kind: "retry" }
  | { kind: "next_item" }
  | { kind: "check_closed" };

export type TransitionResult = { ok: true; state: MachineState } | { ok: false; reason: string };

const refuse = (s: MachineState, ev: SkEvent): TransitionResult => ({ ok: false, reason: `${ev.kind} is not allowed in ${s.state}` });

const inSet = (s: SkState, ...allowed: SkState[]) => allowed.includes(s);

export function initialMachine(cursor: Cursor): MachineState {
  return { state: "ONBOARD", cursor, bookmarks: [], openCheck: null, rate: 1, skipped: [] };
}

export function pushBookmark(s: MachineState, boardSnapshotId: string | null = null): Bookmark[] {
  const bm: Bookmark = { ...s.cursor, boardSnapshotId };
  return [...s.bookmarks, bm].slice(-MAX_BOOKMARKS);
}

export function peekBookmark(s: MachineState): Bookmark | null {
  return s.bookmarks.at(-1) ?? null;
}

const clampT = (t: number) => (Number.isFinite(t) && t > 0 ? Math.floor(t) : 0);

export function transition(s: MachineState, ev: SkEvent): TransitionResult {
  const ok = (patch: Partial<MachineState>): TransitionResult => ({ ok: true, state: { ...s, ...patch } });
  switch (ev.kind) {
    // ── GUIDE ────────────────────────────────────────────────────────────
    case "onboard_done":
      return s.state === "ONBOARD" ? ok({ state: "IDLE" }) : refuse(s, ev);
    case "navigate":
      return s.state === "IDLE" ? ok({ state: "NAVIGATING" }) : refuse(s, ev);
    case "arrive":
      return s.state === "NAVIGATING" ? ok({ state: "IDLE" }) : refuse(s, ev);
    case "open_chapter":
      // ONBOARD is skippable (plan §4 "once, versioned, skippable").
      return inSet(s.state, "ONBOARD", "IDLE") ? ok({ state: "LOADING_GRAPH" }) : refuse(s, ev);

    // ── TEACH ────────────────────────────────────────────────────────────
    case "graph_loaded":
      return s.state === "LOADING_GRAPH" ? ok({ state: "PRESENTING", cursor: { ...ev.cursor, t: clampT(ev.cursor.t) } }) : refuse(s, ev);
    case "tick":
      return s.state === "PRESENTING" ? ok({ cursor: { ...s.cursor, t: clampT(ev.t) } }) : refuse(s, ev);
    case "pause":
      return s.state === "PRESENTING" ? ok({ state: "PAUSED", cursor: ev.t == null ? s.cursor : { ...s.cursor, t: clampT(ev.t) } }) : refuse(s, ev);
    case "play":
      // Leaving CHECK/NEXT by playing abandons the check (nothing is recorded).
      return inSet(s.state, "PAUSED", "RESUMING", "CHECK", "NEXT") ? ok({ state: "PRESENTING", openCheck: inSet(s.state, "CHECK", "NEXT") ? null : s.openCheck }) : refuse(s, ev);
    case "seek":
      return inSet(s.state, "PRESENTING", "PAUSED") ? ok({ cursor: { ...s.cursor, t: clampT(ev.t) } }) : refuse(s, ev);
    case "set_rate": {
      if (phaseOf(s.state) !== "TEACH") return refuse(s, ev);
      const rate = Math.min(RATE_MAX, Math.max(RATE_MIN, Number.isFinite(ev.rate) ? ev.rate : 1));
      return ok({ rate });
    }
    case "segment_ended":
      return s.state === "PRESENTING" ? ok({ state: "PLANNING" }) : refuse(s, ev);
    case "barge_in":
      return inSet(s.state, "PRESENTING", "PAUSED") ? ok({ state: "LISTENING", cursor: ev.t == null ? s.cursor : { ...s.cursor, t: clampT(ev.t) } }) : refuse(s, ev);
    case "utterance":
      return s.state === "LISTENING" ? ok({ state: "UNDERSTANDING" }) : refuse(s, ev);
    case "intent": {
      if (s.state !== "UNDERSTANDING") return refuse(s, ev);
      switch (ev.intent) {
        case "command":
          return ok({ state: "PRESENTING" });
        case "route":
          return ok({ state: "PLANNING" });
        case "question":
          return ok({ state: "ANSWERING" });
        case "answer":
          // An answer only means something while a check is open (plan §4).
          return s.openCheck ? ok({ state: "GRADING" }) : { ok: false, reason: "answer intent with no open check" };
      }
      return refuse(s, ev);
    }
    case "route_requested":
      // Buttons and typed commands skip LISTENING/UNDERSTANDING; an open check is abandoned.
      return inSet(s.state, "PRESENTING", "PAUSED", "RESUMING", "CHECK", "NEXT", "AWAITING", "CONFIRM_TRANSCRIPT", "FEEDBACK") ? ok({ state: "PLANNING", openCheck: null }) : refuse(s, ev);
    case "planned": {
      if (s.state !== "PLANNING") return refuse(s, ev);
      const bookmarks = ev.popBookmark ? s.bookmarks.slice(0, -1) : ev.bookmark ? pushBookmark(s) : s.bookmarks;
      const cursor = { ...ev.cursor, t: clampT(ev.cursor.t) };
      if (ev.check) {
        const openCheck: OpenCheck = { ...ev.check, index: 0, attemptNo: 1, hintsUsed: 0, results: [], independent: true };
        return ok({ state: "CHECK", cursor, bookmarks, openCheck });
      }
      return ok({ state: "PRESENTING", cursor, bookmarks, openCheck: null });
    }
    case "answered":
      return s.state === "ANSWERING" ? ok({ state: "RESUMING", cursor: { ...s.cursor, t: Math.max(0, s.cursor.t - RESUME_REWIND_MS) } }) : refuse(s, ev);

    // ── ASSESS ───────────────────────────────────────────────────────────
    case "ask":
      if (!inSet(s.state, "CHECK", "NEXT")) return refuse(s, ev);
      if (!s.openCheck) return { ok: false, reason: "ask with no open check" };
      if (s.openCheck.index >= s.openCheck.itemIds.length) return { ok: false, reason: "no items left to ask" };
      return ok({ state: "ASKING" });
    case "asked":
      return s.state === "ASKING" ? ok({ state: "AWAITING" }) : refuse(s, ev);
    case "response":
      if (s.state !== "AWAITING") return refuse(s, ev);
      return ok({ state: ev.modality === "spoken" && !ev.transcriptConfirmed ? "CONFIRM_TRANSCRIPT" : "GRADING" });
    case "transcript_confirmed":
      return s.state === "CONFIRM_TRANSCRIPT" ? ok({ state: "GRADING" }) : refuse(s, ev);
    case "graded":
      if (s.state !== "GRADING" || !s.openCheck) return refuse(s, ev);
      return ok({ state: "FEEDBACK", openCheck: { ...s.openCheck, lastCorrect: ev.correct } });
    case "hint":
      if (s.state !== "FEEDBACK" || !s.openCheck) return refuse(s, ev);
      // A hint is assistance: this item can no longer count as independent evidence.
      return ok({ state: "HINT", openCheck: { ...s.openCheck, attemptNo: s.openCheck.attemptNo + 1, hintsUsed: s.openCheck.hintsUsed + 1, independent: false, lastCorrect: undefined } });
    case "retry":
      return s.state === "HINT" ? ok({ state: "AWAITING" }) : refuse(s, ev);
    case "next_item": {
      if (s.state !== "FEEDBACK" || !s.openCheck) return refuse(s, ev);
      const oc = s.openCheck;
      const correct = oc.lastCorrect === true;
      const independent = oc.independent && correct && oc.attemptNo === 1 && oc.hintsUsed === 0;
      const openCheck: OpenCheck = { unitKey: oc.unitKey, itemIds: oc.itemIds, purpose: oc.purpose, index: oc.index + 1, attemptNo: 1, hintsUsed: 0, results: [...oc.results, correct], independent };
      return ok({ state: "NEXT", openCheck });
    }
    case "check_closed":
      return inSet(s.state, "NEXT", "CHECK") ? ok({ state: "PRESENTING", openCheck: null }) : refuse(s, ev);
  }
  return refuse(s, ev);
}

/** Apply events in order; stop at the first refusal (nothing after it applies). */
export function transitionAll(s: MachineState, events: SkEvent[]): TransitionResult {
  let cur = s;
  for (const ev of events) {
    const r = transition(cur, ev);
    if (!r.ok) return r;
    cur = r.state;
  }
  return { ok: true, state: cur };
}

/** True when the check has marked every item. */
export function checkComplete(oc: OpenCheck): boolean {
  return oc.results.length >= oc.itemIds.length;
}

/** A check passes when every item was answered correctly (any attempt); the
 * `independent` flag says whether that counts as unassisted evidence. */
export function checkPassed(oc: OpenCheck): boolean {
  return checkComplete(oc) && oc.results.every(Boolean);
}
