// SK B4 — the teacher loop end to end with the StubProvider and the in-memory
// store: open/resume, commands, spoken routes, a question with a gated aside,
// a full check with hints, and the idempotent replay of a turn.
import { describe, expect, it } from "vitest";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { ASIDE_TOOL } from "../teacher";
import { openSession, runCommand, runTurn, submitAnswer, type LoopDeps } from "../loop";
import { StaticItemBank } from "../items";
import { InMemorySessionStore } from "../store";
import type { SseEvent } from "../types";
import { graph, U4_HITMAP_TARGETS, U4_SEGMENT } from "./fixtures";

function deps(extra: Partial<LoopDeps> = {}): LoopDeps {
  return {
    store: new InMemorySessionStore(),
    graph: graph(),
    items: new StaticItemBank(),
    loadSegment: async () => U4_SEGMENT,
    loadHitmapElementIds: async () => U4_HITMAP_TARGETS,
    ...extra,
  };
}
const open = (d: LoopDeps) => openSession(d, { studentId: "stu", productId: "test-product", chapter: 2 });
const collect = async (gen: AsyncGenerator<SseEvent>) => {
  const out: SseEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};
const text = (evs: SseEvent[]) => evs.filter((e) => e.event === "text").map((e) => String(e.data)).join("");
const done = (evs: SseEvent[]) => evs.find((e) => e.event === "done")!.data as { view: { state: string; cursor: { unitKey: string; assetId: string; t: number }; bookmarks: unknown[]; openCheck: { item: { id: string } | null; attemptNo: number } | null; mastery: Record<string, { status: string; independent: boolean }> }; board?: string; decision?: { kind: string; rung?: number } };
const eid = (() => {
  let n = 0;
  return () => `0192f5c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;
})();

describe("sessions", () => {
  it("a new session starts PAUSED at the first unit's main asset; resume returns the same session", async () => {
    const d = deps();
    const s = await open(d);
    expect(s.machine.state).toBe("PAUSED");
    expect(s.machine.cursor).toEqual({ graphVersion: 3, unitKey: "u2", assetId: "u2-main", segmentId: "u2-seg", t: 0 });
    const again = await open(d);
    expect(again.id).toBe(s.id);
    expect((d.store as InMemorySessionStore).size).toBe(1);
    const fresh = await openSession(d, { studentId: "stu", productId: "test-product", chapter: 2, resume: false });
    expect(fresh.id).not.toBe(s.id);
    await expect(openSession(d, { studentId: "stu", productId: "other", chapter: 2 })).rejects.toMatchObject({ status: 404 });
  });
  it("a session left mid-turn resumes at a stable state", async () => {
    const d = deps();
    const s = await open(d);
    s.machine = { ...s.machine, state: "ANSWERING" };
    await d.store.saveSession(s);
    expect((await open(d)).machine.state).toBe("PAUSED");
  });
});

describe("commands", () => {
  it("continue plays; slower lowers the rate to the floor; repeat seeks to the last checkpoint", async () => {
    const d = deps();
    const s = await open(d);
    const r1 = await runCommand(d, s, { name: "continue", args: {} });
    expect(r1.view.state).toBe("PRESENTING");
    expect(r1.board).toBe("play");
    const r2 = await runCommand(d, s, { name: "slower", args: {} }, { unitKey: "u2", assetId: "u2-main", t: 20_000 });
    expect(r2.view.rate).toBeCloseTo(0.85, 5);
    expect(r2.view.cursor.t).toBe(20_000); // the client's clock was trusted for the asset the server believes is playing
    for (let i = 0; i < 5; i++) await runCommand(d, s, { name: "slower", args: {} });
    const floor = await runCommand(d, s, { name: "slower", args: {} });
    expect(floor.view.rate).toBeCloseTo(0.6, 5);
    expect(floor.speech).toMatch(/as slow as I go/);
    const r3 = await runCommand(d, s, { name: "repeat", args: {} });
    expect(r3.view.cursor.t).toBe(18_500); // U4 checkpoints: … 18500, 23588 …
    expect(r3.board).toBe("seek");
    const r4 = await runCommand(d, s, { name: "erase", args: {} });
    expect(r4.board).toBe("erase_aside");
  });
  it("a cursor for a different asset is not trusted", async () => {
    const d = deps();
    const s = await open(d);
    const r = await runCommand(d, s, { name: "continue", args: {} }, { unitKey: "u4", assetId: "u4-main", t: 50_000 });
    expect(r.view.cursor.t).toBe(0);
  });
  it("goto pushes a bookmark and moves; return pops it back to the same t", async () => {
    const d = deps();
    const s = await open(d);
    await runCommand(d, s, { name: "continue", args: {} }, { unitKey: "u2", assetId: "u2-main", t: 7000 });
    const g = await runCommand(d, s, { name: "goto", args: { unitKey: "u5" } }, { unitKey: "u2", assetId: "u2-main", t: 9000 });
    expect(g.view.cursor).toMatchObject({ unitKey: "u5", assetId: "u5-main", t: 0 });
    expect(g.view.bookmarks).toEqual([{ graphVersion: 3, unitKey: "u2", assetId: "u2-main", segmentId: "u2-seg", t: 9000, boardSnapshotId: null }]);
    expect(g.speech).toMatch(/Actual size.*quick check first\?/);
    const b = await runCommand(d, s, { name: "return", args: {} });
    expect(b.view.cursor).toMatchObject({ unitKey: "u2", assetId: "u2-main", t: 9000 });
    expect(b.view.bookmarks).toEqual([]);
    const none = await runCommand(d, s, { name: "return", args: {} });
    expect(none.speech).toBe("There's nothing to go back to yet.");
    expect(none.view.state).toBe("PRESENTING");
  });
  it("explain_again without a fitting asset climbs the ladder and says so", async () => {
    const d = deps();
    const s = await open(d);
    await runCommand(d, s, { name: "goto", args: { unitKey: "u5" } });
    const r = await runCommand(d, s, { name: "explain_again", args: { style: "visual" } });
    expect(r.decision?.kind).toBe("generate");
    expect(r.speech).toBe("Let me put it another way."); // rung 3
  });
});

describe("a turn: command, route, question (with a gated aside), replay", () => {
  it("a spoken command is applied and the turn ends presenting", async () => {
    const d = deps();
    const s = await open(d);
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "slower please", modality: "typed" } }));
    expect(evs[0]).toEqual({ event: "meta", data: expect.objectContaining({ intent: "command", source: "regex" }) });
    expect(text(evs)).toBe("I'll slow down a little.");
    expect(done(evs).view.state).toBe("PRESENTING");
  });
  it("a spoken skip opens the 2-item check (bookmark pushed) and the view carries the stripped item", async () => {
    const d = deps();
    const s = await open(d);
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "skip", modality: "typed" }, cursor: { unitKey: "u2", assetId: "u2-main", t: 3000 } }));
    expect(text(evs)).toMatch(/2 quick questions first so it counts/);
    const v = done(evs).view;
    expect(v.state).toBe("AWAITING");
    expect(v.openCheck?.item?.id).toBe("ch2-u4-c1");
    expect(JSON.stringify(v.openCheck)).not.toMatch(/Multiply the eyepiece and objective magnifications"\s*,\s*"marks/); // no key field
    expect(v.bookmarks).toHaveLength(1);
    expect(done(evs).board).toBe("pause");
  });
  it("a question streams Sonnet's text, sends the aside only after the gate, and resumes 1.5 s back", async () => {
    const good = { tal: "0.2-aside", duration_ms: 3000, actions: [{ op: "highlight", id: "g1", target: "mic.eyepiece lens", style: "circle", t: 100, dur: 600 }], gestures: [] };
    const provider = new StubProvider([{ text: ["The eyepiece ", "is the top lens."], toolCalls: [{ id: "t1", name: ASIDE_TOOL.name, args: good }] }]);
    const d = deps({ teacherProvider: provider });
    const s = await open(d);
    await runCommand(d, s, { name: "continue", args: {} });
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "which lens is the eyepiece?", modality: "typed" }, cursor: { unitKey: "u2", assetId: "u2-main", t: 20_000 } }));
    expect(evs.map((e) => e.event)).toEqual(["meta", "text", "text", "tal", "done"]);
    expect(text(evs)).toBe("The eyepiece is the top lens.");
    expect((evs[3]!.data as { actions: unknown[] }).actions).toHaveLength(1);
    const dn = done(evs);
    expect(dn.view.state).toBe("PRESENTING");
    expect(dn.view.cursor.t).toBe(18_500);
    expect(dn.board).toBe("play");
    // The unit's content was the system prefix; the question the last user turn.
    const call = provider.calls[0]!;
    expect(call.system).toContain(U4_SEGMENT.narration.slice(0, 60));
    expect(call.system).toContain("mic.eyepiece lens");
    expect(call.tools).toEqual([ASIDE_TOOL]);
    expect(call.messages.at(-1)).toEqual({ role: "user", text: "which lens is the eyepiece?" });
    expect((await d.store.getSession(s.id))!.history).toHaveLength(2);
  });
  it("a bad aside is dropped whole; the spoken answer still goes out", async () => {
    const bad = { actions: [{ op: "place", as: "x", ref: "asset:light_microscope", at: { x: 0, y: 0, w: 10, h: 10 }, t: 0 }] };
    const provider = new StubProvider([{ text: ["Sure."], toolCalls: [{ id: "t1", name: ASIDE_TOOL.name, args: bad }] }]);
    const d = deps({ teacherProvider: provider });
    const s = await open(d);
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "can you show me the base?", modality: "typed" } }));
    expect(evs.some((e) => e.event === "tal")).toBe(false);
    expect(evs.find((e) => e.event === "meta" && (e.data as { asideRejected?: string }).asideRejected)).toBeTruthy();
    expect(text(evs)).toBe("Sure.");
  });
  it("without a teacher provider SK says it cannot answer, honestly", async () => {
    const d = deps();
    const s = await open(d);
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "why is the image bigger?", modality: "typed" } }));
    expect(text(evs)).toMatch(/can't answer questions right now/);
    expect(done(evs).view.state).toBe("PRESENTING");
  });
  it("a question while a check is open is deflected, a command still works", async () => {
    const d = deps();
    const s = await open(d);
    await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "check me", modality: "typed" } }));
    const q = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "what is an objective lens for?", modality: "typed" } }));
    expect(text(q)).toMatch(/finish this question first/);
    expect(done(q).view.state).toBe("AWAITING");
    const c = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "continue", modality: "typed" } }));
    expect(text(c)).toMatch(/Have a go at this one first/);
  });
});

describe("answers: graded once, hints, mastery, what comes next", () => {
  it("a full unit check with one hint: assisted pass → mastered (not independent) → next unit", async () => {
    const d = deps();
    const s = await open(d);
    await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "check me", modality: "typed" } }));
    const a1 = await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c1", attemptNo: 1, response: "b", modality: "typed" });
    expect(a1).toMatchObject({ kind: "graded", outcome: "correct", independent: true });
    expect(a1.kind === "graded" && a1.view.openCheck?.item?.id).toBe("ch2-u4-c2");
    // wrong, hint, right on attempt 2
    const a2 = await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c2", attemptNo: 1, response: "50", modality: "typed" });
    expect(a2).toMatchObject({ kind: "graded", outcome: "incorrect", hintAvailable: true, hint: "Multiply: eyepiece times objective." });
    expect(a2.kind === "graded" && a2.view.openCheck?.attemptNo).toBe(2);
    await expect(submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c2", attemptNo: 1, response: "400", modality: "typed" })).resolves.toMatchObject({ kind: "graded", replayed: true, outcome: "incorrect" }); // attempt 1 is graded once
    const a3 = await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c2", attemptNo: 2, response: "400", modality: "typed" });
    expect(a3).toMatchObject({ kind: "graded", outcome: "correct", independent: false });
    const a4 = await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c3", attemptNo: 1, response: false, modality: "typed" });
    expect(a4).toMatchObject({ kind: "graded", outcome: "correct", check: { passed: true, independent: false, purpose: "unit" } });
    if (a4.kind === "graded") {
      expect(a4.view.mastery.u2).toMatchObject({ status: "mastered", independent: false });
      expect(a4.view.cursor.unitKey).toBe("u4"); // moved on to the next unit
      expect(a4.view.state).toBe("PRESENTING");
      expect(a4.speech).toMatch(/Got there\. .*Total magnification/);
    }
    expect(await d.store.listAttempts(s.id)).toHaveLength(4);
  });
  it("a failed skip check teaches the unit from the top; practise returns to the bookmark", async () => {
    const d = deps();
    const s = await open(d);
    await runCommand(d, s, { name: "skip", args: { scope: "unit", withCheck: true } }, { unitKey: "u2", assetId: "u2-main", t: 1000 });
    await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c1", attemptNo: 1, response: "a", modality: "typed" });
    for (const n of [2, 3]) await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c1", attemptNo: n, response: "a", modality: "typed" });
    const last = await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c2", attemptNo: 1, response: "400", modality: "typed" });
    expect(last).toMatchObject({ kind: "graded", check: { passed: false, purpose: "skip" } });
    if (last.kind === "graded") {
      expect(last.view.cursor).toMatchObject({ unitKey: "u2", assetId: "u2-main", t: 0 });
      expect(last.view.mastery.u2?.status).toBe("needs_work");
      expect(last.speech).toMatch(/from the top/);
    }
    // practise on u4, then back to the bookmark
    await runCommand(d, s, { name: "goto", args: { unitKey: "u4" } }, { unitKey: "u2", assetId: "u2-main", t: 2500 });
    await runCommand(d, s, { name: "practise", args: { n: 1 } }, { unitKey: "u4", assetId: "u4-main", t: 4000 });
    const p = await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-p1", attemptNo: 1, response: "40", modality: "typed" });
    expect(p).toMatchObject({ kind: "graded", check: { passed: true, purpose: "practise" } });
    if (p.kind === "graded") {
      expect(p.view.cursor).toMatchObject({ unitKey: "u4", assetId: "u4-main", t: 4000 }); // popped the practise bookmark
      expect(p.view.mastery.u4?.status).toBe("in_progress"); // practice is never mastery
    }
  });
  it("spoken answers are confirmed first; wrong item or stale attempt are refused", async () => {
    const d = deps();
    const s = await open(d);
    await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "check me", modality: "typed" } }));
    const c = await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c1", attemptNo: 1, response: "bee", modality: "spoken" });
    expect(c).toMatchObject({ kind: "confirm", transcript: "bee" });
    expect(c.view.state).toBe("CONFIRM_TRANSCRIPT");
    await expect(submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c2", attemptNo: 1, response: "b", modality: "typed" })).rejects.toMatchObject({ status: 409 });
    await expect(submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c1", attemptNo: 2, response: "b", modality: "typed" })).rejects.toMatchObject({ status: 409 });
    const g = await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c1", attemptNo: 1, response: "b", modality: "spoken", transcriptConfirmed: true });
    expect(g).toMatchObject({ kind: "graded", outcome: "correct" });
  });
  it("a typed answer through the turn route grades the open item", async () => {
    const d = deps();
    const s = await open(d);
    await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "check me", modality: "typed" } }));
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "b", modality: "typed" } }));
    expect(evs[0]!.data).toMatchObject({ intent: "answer" });
    expect(text(evs)).toMatch(/That's right\. Next one\./);
    expect(done(evs).view.openCheck?.item?.id).toBe("ch2-u4-c2");
  });
});
