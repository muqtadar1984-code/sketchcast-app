// SK — the founder's decisions of 2026-10-27, pinned end to end:
//   1. a unit may be skipped WITHOUT its 2-item check: recorded as skipped,
//      never mastered (no mastery entry), visible in the session view;
//   2. an assisted pass is PROVISIONAL: it unlocks the next unit but keeps the
//      prerequisite warning and is shown apart from an independent pass;
//   3. during a check the student may ask about the INSTRUCTIONS and gets an
//      answer built from the check's shape only; a topic question is deflected
//      and the item's answer is never explained while the check is open.
import { describe, expect, it } from "vitest";
import { openSession, runCommand, runTurn, submitAnswer, checkInstructions, type LoopDeps } from "../loop";
import { StaticItemBank } from "../items";
import { plan, provisionalPrereqs, unmetPrereqs, type PlannerContext } from "../planner";
import { classifyByRules, parseProposal } from "../router";
import { initialMachine, skippedOf, withoutSkipped, withSkipped } from "../state";
import { InMemorySessionStore } from "../store";
import type { Cursor, MasteryMap, SseEvent } from "../types";
import { graph, U4_HITMAP_TARGETS, U4_SEGMENT } from "./fixtures";

const g = graph();
function deps(extra: Partial<LoopDeps> = {}): LoopDeps {
  return { store: new InMemorySessionStore(), graph: graph(), items: new StaticItemBank(), loadSegment: async () => U4_SEGMENT, loadHitmapElementIds: async () => U4_HITMAP_TARGETS, ...extra };
}
const open = (d: LoopDeps) => openSession(d, { studentId: "stu", productId: "test-product", chapter: 2 });
const collect = async (gen: AsyncGenerator<SseEvent>) => {
  const out: SseEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};
const text = (evs: SseEvent[]) => evs.filter((e) => e.event === "text").map((e) => String(e.data)).join("");
const done = (evs: SseEvent[]) => evs.find((e) => e.event === "done")!.data as { view: { state: string; cursor: Cursor; skipped: string[]; openCheck: unknown; mastery: MasteryMap } };
const eid = (() => {
  let n = 0;
  return () => `0192f5c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;
})();
const at = (unitKey: string, assetId: string, t = 0): Cursor => ({ graphVersion: 3, unitKey, assetId, segmentId: assetId, t });
const ctx = (cursor: Cursor, mastery: MasteryMap = {}, extra: Partial<PlannerContext> = {}): PlannerContext => ({ graph: g, cursor, mastery, bookmarks: [], ...extra });

describe("1. skipping without the check", () => {
  it("state: the skipped list is deduplicated, tolerant of old rows, and a key can be cleared", () => {
    const m0 = initialMachine(at("u2", "u2-main"));
    expect(skippedOf(m0)).toEqual([]);
    const legacy = { ...m0, skipped: undefined } as typeof m0;
    expect(skippedOf(legacy)).toEqual([]);
    const m1 = withSkipped(withSkipped(legacy, "u2"), "u2");
    expect(m1.skipped).toEqual(["u2"]);
    expect(withoutSkipped(m1, "u2").skipped).toEqual([]);
    expect(withoutSkipped(m1, "u9")).toBe(m1);
  });
  it("router: 'just skip it' / 'skip without the check' decline the check; a bare skip still takes it", () => {
    expect(classifyByRules("just skip it", g, false)?.command?.args).toMatchObject({ scope: "unit", withCheck: false });
    expect(classifyByRules("skip this unit without the check", g, false)?.command?.args).toMatchObject({ scope: "unit", withCheck: false });
    expect(classifyByRules("no questions, skip", g, true)?.command?.args).toMatchObject({ scope: "unit", withCheck: false });
    expect(classifyByRules("skip", g, false)?.command?.args).toMatchObject({ scope: "unit", withCheck: true });
    expect(parseProposal({ kind: "route", command: "skip", withCheck: false, confidence: 0.8 }, g, false)?.command?.args).toEqual({ scope: "unit", withCheck: false });
    expect(parseProposal({ kind: "route", command: "skip", confidence: 0.8 }, g, false)?.command?.args).toEqual({ scope: "unit", withCheck: true });
  });
  it("loop: a skip without the check moves on, records the unit as skipped, writes no mastery", async () => {
    const d = deps();
    const s = await open(d);
    const evs = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "just skip it", modality: "typed" }, cursor: { unitKey: "u2", assetId: "u2-main", t: 3000 } }));
    expect(text(evs)).toMatch(/Skipping Parts of a microscope without the check — it stays unmarked, not learned/);
    const v = done(evs).view;
    expect(v.state).toBe("PRESENTING");
    expect(v.cursor.unitKey).toBe("u4");
    expect(v.skipped).toEqual(["u2"]);
    expect(v.mastery.u2).toBeUndefined();
    expect(v.openCheck).toBeNull();
  });
  it("loop: a second 'skip' while the skip check is open declines it — skipped, not mastered", async () => {
    const d = deps();
    const s = await open(d);
    const first = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "skip", modality: "typed" }, cursor: { unitKey: "u2", assetId: "u2-main", t: 3000 } }));
    expect(done(first).view.state).toBe("AWAITING");
    const second = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "skip", modality: "typed" } }));
    const v = done(second).view;
    expect(v.openCheck).toBeNull();
    expect(v.cursor.unitKey).toBe("u4");
    expect(v.skipped).toEqual(["u2"]);
    expect(v.mastery.u2).toBeUndefined();
    expect(text(second)).toMatch(/without the check/);
  });
  it("loop: a later passed check on the unit clears the skip", async () => {
    const d = deps();
    const s = await open(d);
    await runCommand(d, s, { name: "skip", args: { scope: "unit", withCheck: false } }, { unitKey: "u2", assetId: "u2-main", t: 1000 });
    expect(skippedOf(s.machine)).toEqual(["u2"]);
    await runCommand(d, s, { name: "practise", args: { n: 0, unitKey: "u2" } }, { unitKey: "u4", assetId: "u4-main", t: 0 }); // check_me on u2
    for (const [item, answer] of [["ch2-u4-c1", "b"], ["ch2-u4-c2", "400"]] as const) await submitAnswer(d, s, { eventId: eid(), itemId: item, attemptNo: 1, response: answer, modality: "typed" });
    const last = await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c3", attemptNo: 1, response: false, modality: "typed" });
    expect(last).toMatchObject({ kind: "graded", check: { passed: true, independent: true } });
    expect(skippedOf(s.machine)).toEqual([]);
    expect(s.mastery.u2?.status).toBe("mastered");
  });
});

describe("2. an assisted pass is provisional", () => {
  const provisional = (...keys: string[]): MasteryMap => Object.fromEntries(keys.map((k) => [k, { status: "provisional", independent: false, evidence: { correct: 2, total: 2 } }]));
  it("planner: provisional unlocks the next unit (no re-check) but keeps a warning with the suggested check", () => {
    // u2 provisional: "next" from u2 moves on instead of running u2's check again…
    const d = plan(ctx(at("u2", "u2-main"), provisional("u2")), { name: "next" });
    expect(d.kind).toBe("present");
    if (d.kind === "present") {
      expect(d.unitKey).toBe("u4");
      // …but u4's prerequisite u2 still warns, naming the help, and offers u2's 2-item check.
      expect(d.warning).toBe("Total magnification uses Parts of a microscope's idea, which you passed with a little help; quick check first?");
      expect(d.suggestedCheck).toEqual({ unitKey: "u2", itemIds: ["ch2-u4-c1", "ch2-u4-c2"], purpose: "prereq" });
      expect(d.reasons.join(" ")).toMatch(/provisional.*unlocked, warning kept/);
    }
    const u4 = g.units.find((u) => u.unit_key === "u4")!;
    expect(unmetPrereqs(ctx(at("u4", "u4-main"), provisional("u2")), u4)).toEqual([]);
    expect(provisionalPrereqs(ctx(at("u4", "u4-main"), provisional("u2")), u4).map((u) => u.unit_key)).toEqual(["u2"]);
    // An independent pass warns nothing.
    const clean = plan(ctx(at("u2", "u2-main"), { u2: { status: "mastered", independent: true, evidence: { correct: 2, total: 2 } } }), { name: "next" });
    expect(clean.kind === "present" && clean.warning).toBeUndefined();
  });
  it("loop: a pass with a hint lands as provisional, moves on, and SK says so", async () => {
    const d = deps();
    const s = await open(d);
    await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "check me", modality: "typed" } }));
    await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c1", attemptNo: 1, response: "b", modality: "typed" });
    await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c2", attemptNo: 1, response: "50", modality: "typed" }); // wrong → hint
    await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c2", attemptNo: 2, response: "400", modality: "typed" });
    const last = await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c3", attemptNo: 1, response: false, modality: "typed" });
    expect(last).toMatchObject({ kind: "graded", check: { passed: true, independent: false, purpose: "unit" } });
    if (last.kind === "graded") {
      expect(last.view.mastery.u2).toMatchObject({ status: "provisional", independent: false });
      expect(last.view.cursor.unitKey).toBe("u4");
      expect(last.speech).toMatch(/with a little help/);
    }
  });
});

describe("3. clarification during a check, never the answer", () => {
  it("router: with a check open, instruction questions are ungrounded questions; a topic question is not", () => {
    for (const q of ["how do I answer this?", "What do you mean?", "repeat the question", "how many tries do I have?", "can I type", "which question am I on?"]) {
      expect(classifyByRules(q, g, true)).toMatchObject({ kind: "question", needsGrounding: false, source: "regex" });
    }
    expect(classifyByRules("repeat the question", g, false)).toBeNull(); // no check open: not a clarification (and not the repeat command either)
    expect(classifyByRules("repeat", g, true)?.command?.name).toBe("repeat");
    expect(classifyByRules("what is an objective lens for?", g, true)).toBeNull(); // the model decides; default is a grounded question
  });
  it("loop: an instruction question is answered from the check's shape, a topic question is deflected, and nothing leaks", async () => {
    const d = deps();
    const s = await open(d);
    await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "check me", modality: "typed" } }));
    const how = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "how do I answer this?", modality: "typed" } }));
    expect(text(how)).toMatch(/check question 1 of 3, attempt 1 of 3 — 3 goes left on it\. Pick one of the options\./);
    expect(text(how)).toMatch(/can't explain the topic until the check is done; say skip/);
    expect(done(how).view.state).toBe("AWAITING");
    const topic = await collect(runTurn(d, s, { eventId: eid(), utterance: { text: "what is an objective lens for?", modality: "typed" } }));
    expect(text(topic)).toMatch(/can't explain the topic while a check is on/);
    expect(done(topic).view.state).toBe("AWAITING");
    // The clarification text carries no item content: not the prompt, not an option, not the key.
    const item = await d.items.get("ch2-u4-c1");
    const leak = [item?.prompt ?? "", ...(item && "options" in item ? item.options : [])].filter((x) => x.length > 3);
    for (const piece of leak) expect(text(how)).not.toContain(piece);
    // Attempt 2 after a wrong answer: the count moves and the type-specific instruction follows the item.
    await submitAnswer(d, s, { eventId: eid(), itemId: "ch2-u4-c1", attemptNo: 1, response: "a", modality: "typed" });
    expect(await checkInstructions(d, s.machine.openCheck!)).toMatch(/question 1 of 3, attempt 2 of 3 — 2 goes left/);
  });
});
