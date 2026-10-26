// SK B4 — the §4 state machine: every branch of the plan's diagram, the
// bookmark stack, the cursor, and the refusals that keep a replayed or
// out-of-order request from corrupting a session.
import { describe, expect, it } from "vitest";
import { checkPassed, initialMachine, phaseOf, RATE_MIN, RESUME_REWIND_MS, transition, transitionAll, type MachineState } from "../state";
import type { Cursor } from "../types";

const c0: Cursor = { graphVersion: 1, unitKey: "u1", assetId: "a1", segmentId: "s1", t: 0 };
const c2: Cursor = { graphVersion: 1, unitKey: "u2", assetId: "a2", segmentId: "s2", t: 0 };

function presenting(t = 12_000): MachineState {
  const r = transitionAll(initialMachine(c0), [{ kind: "open_chapter" }, { kind: "graph_loaded", cursor: c0 }, { kind: "tick", t }]);
  if (!r.ok) throw new Error(r.reason);
  return r.state;
}

describe("GUIDE → TEACH", () => {
  it("onboards once, navigates, opens the chapter and loads the graph", () => {
    const r = transitionAll(initialMachine(c0), [{ kind: "onboard_done" }, { kind: "navigate" }, { kind: "arrive" }, { kind: "open_chapter" }, { kind: "graph_loaded", cursor: c0 }]);
    expect(r.ok && r.state.state).toBe("PRESENTING");
    expect(phaseOf("IDLE")).toBe("GUIDE");
    expect(phaseOf("PRESENTING")).toBe("TEACH");
    expect(phaseOf("AWAITING")).toBe("ASSESS");
  });
  it("onboarding is skippable: open_chapter is allowed from ONBOARD", () => {
    expect(transition(initialMachine(c0), { kind: "open_chapter" }).ok).toBe(true);
  });
  it("refuses events the state does not accept, naming both", () => {
    const r = transition(initialMachine(c0), { kind: "pause" });
    expect(r).toEqual({ ok: false, reason: "pause is not allowed in ONBOARD" });
  });
});

describe("TEACH: presenting, pausing, barge-in", () => {
  it("tick moves the cursor only while presenting; pause and play round-trip", () => {
    const m = presenting(5000);
    expect(m.cursor.t).toBe(5000);
    const p = transition(m, { kind: "pause", t: 6000 });
    expect(p.ok && p.state.state).toBe("PAUSED");
    expect(p.ok && p.state.cursor.t).toBe(6000);
    expect(p.ok && transition(p.state, { kind: "tick", t: 7000 }).ok).toBe(false);
    expect(p.ok && transition(p.state, { kind: "play" }).ok && true).toBe(true);
  });
  it("command: barge-in → understanding → applied → presenting", () => {
    const r = transitionAll(presenting(), [{ kind: "barge_in", t: 13_000 }, { kind: "utterance" }, { kind: "intent", intent: "command" }]);
    expect(r.ok && r.state.state).toBe("PRESENTING");
    expect(r.ok && r.state.cursor.t).toBe(13_000);
  });
  it("question: answering → resuming rewinds 1.5 s → presenting", () => {
    const r = transitionAll(presenting(10_000), [{ kind: "barge_in" }, { kind: "utterance" }, { kind: "intent", intent: "question" }, { kind: "answered" }]);
    expect(r.ok && r.state.state).toBe("RESUMING");
    expect(r.ok && r.state.cursor.t).toBe(10_000 - RESUME_REWIND_MS);
    const p = r.ok ? transition(r.state, { kind: "play" }) : r;
    expect(p.ok && p.state.state).toBe("PRESENTING");
  });
  it("a rewind never goes below zero", () => {
    const r = transitionAll(presenting(500), [{ kind: "barge_in" }, { kind: "utterance" }, { kind: "intent", intent: "question" }, { kind: "answered" }]);
    expect(r.ok && r.state.cursor.t).toBe(0);
  });
  it("an answer intent with no open check is refused", () => {
    const r = transitionAll(presenting(), [{ kind: "barge_in" }, { kind: "utterance" }, { kind: "intent", intent: "answer" }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/no open check/);
  });
  it("slower clamps the rate", () => {
    const r = transition(presenting(), { kind: "set_rate", rate: 0.1 });
    expect(r.ok && r.state.rate).toBe(RATE_MIN);
    expect(transition(initialMachine(c0), { kind: "set_rate", rate: 0.8 }).ok).toBe(false); // not in TEACH
  });
});

describe("routes and bookmarks", () => {
  it("route → planning → planned pushes a bookmark BEFORE the cursor moves", () => {
    const r = transitionAll(presenting(20_000), [{ kind: "barge_in" }, { kind: "utterance" }, { kind: "intent", intent: "route" }, { kind: "planned", cursor: c2, bookmark: true }]);
    expect(r.ok && r.state.state).toBe("PRESENTING");
    expect(r.ok && r.state.cursor).toEqual(c2);
    expect(r.ok && r.state.bookmarks).toEqual([{ ...c0, t: 20_000, boardSnapshotId: null }]);
  });
  it("return pops the bookmark it came back to", () => {
    const away = transitionAll(presenting(20_000), [{ kind: "route_requested" }, { kind: "planned", cursor: c2, bookmark: true }]);
    if (!away.ok) throw new Error(away.reason);
    const back = transitionAll(away.state, [{ kind: "route_requested" }, { kind: "planned", cursor: { ...c0, t: 20_000 }, popBookmark: true }]);
    expect(back.ok && back.state.cursor.t).toBe(20_000);
    expect(back.ok && back.state.bookmarks).toEqual([]);
  });
  it("a planned check opens CHECK with a fresh OpenCheck, and route_requested abandons it", () => {
    const r = transitionAll(presenting(), [{ kind: "route_requested" }, { kind: "planned", cursor: c2, bookmark: true, check: { unitKey: "u2", itemIds: ["i1", "i2"], purpose: "skip" } }]);
    expect(r.ok && r.state.state).toBe("CHECK");
    expect(r.ok && r.state.openCheck).toEqual({ unitKey: "u2", itemIds: ["i1", "i2"], purpose: "skip", index: 0, attemptNo: 1, hintsUsed: 0, results: [], independent: true });
    const abandon = r.ok ? transition(r.state, { kind: "route_requested" }) : r;
    expect(abandon.ok && abandon.state.openCheck).toBeNull();
  });
  it("segment end goes to planning (the planner picks what is next)", () => {
    expect(transition(presenting(), { kind: "segment_ended" }).ok && true).toBe(true);
  });
});

describe("ASSESS", () => {
  const opened = () => {
    const r = transitionAll(presenting(), [{ kind: "route_requested" }, { kind: "planned", cursor: c2, check: { unitKey: "u2", itemIds: ["i1", "i2"], purpose: "skip" } }, { kind: "ask" }, { kind: "asked" }]);
    if (!r.ok) throw new Error(r.reason);
    return r.state;
  };
  it("typed answer: awaiting → grading → feedback → next → asking the second item", () => {
    const r = transitionAll(opened(), [{ kind: "response", modality: "typed" }, { kind: "graded", correct: true }, { kind: "next_item" }, { kind: "ask" }, { kind: "asked" }]);
    expect(r.ok && r.state.state).toBe("AWAITING");
    expect(r.ok && r.state.openCheck?.index).toBe(1);
    expect(r.ok && r.state.openCheck?.results).toEqual([true]);
    expect(r.ok && r.state.openCheck?.independent).toBe(true);
  });
  it("a spoken answer waits for transcript confirmation before grading", () => {
    const r = transition(opened(), { kind: "response", modality: "spoken" });
    expect(r.ok && r.state.state).toBe("CONFIRM_TRANSCRIPT");
    const g = r.ok ? transition(r.state, { kind: "transcript_confirmed" }) : r;
    expect(g.ok && g.state.state).toBe("GRADING");
    const direct = transition(opened(), { kind: "response", modality: "spoken", transcriptConfirmed: true });
    expect(direct.ok && direct.state.state).toBe("GRADING");
  });
  it("a hint bumps the attempt, and the item stops counting as independent", () => {
    const r = transitionAll(opened(), [{ kind: "response", modality: "typed" }, { kind: "graded", correct: false }, { kind: "hint" }, { kind: "retry" }]);
    expect(r.ok && r.state.state).toBe("AWAITING");
    expect(r.ok && r.state.openCheck?.attemptNo).toBe(2);
    expect(r.ok && r.state.openCheck?.hintsUsed).toBe(1);
    expect(r.ok && r.state.openCheck?.independent).toBe(false);
    const done = r.ok ? transitionAll(r.state, [{ kind: "response", modality: "typed" }, { kind: "graded", correct: true }, { kind: "next_item" }]) : r;
    expect(done.ok && done.state.openCheck?.results).toEqual([true]);
    expect(done.ok && done.state.openCheck?.independent).toBe(false); // right, but assisted
  });
  it("the check closes after the last item and passes only when every item was right", () => {
    const r = transitionAll(opened(), [
      { kind: "response", modality: "typed" },
      { kind: "graded", correct: true },
      { kind: "next_item" },
      { kind: "ask" },
      { kind: "asked" },
      { kind: "response", modality: "typed" },
      { kind: "graded", correct: false },
      { kind: "next_item" },
    ]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.state.state).toBe("NEXT");
    expect(transition(r.state, { kind: "ask" }).ok).toBe(false); // no items left
    expect(checkPassed(r.state.openCheck!)).toBe(false);
    const closed = transition(r.state, { kind: "check_closed" });
    expect(closed.ok && closed.state.state).toBe("PRESENTING");
    expect(closed.ok && closed.state.openCheck).toBeNull();
  });
  it("transitionAll stops at the first refusal and applies nothing after it", () => {
    const r = transitionAll(opened(), [{ kind: "graded", correct: true }, { kind: "response", modality: "typed" }]);
    expect(r.ok).toBe(false);
  });
});
