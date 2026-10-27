/**
 * The teacher loop on BOTH production wirings — the in-memory store with the
 * static bank, and the Supabase store with the Supabase bank over the strict
 * fake of the 0156/0157 schema — running the same scenarios on the packaged
 * cells chapter: open, play, skip with check, check me, practise, answer and
 * mark, return, explain again, and the replay of a repeated event id.
 *
 * Why: the five live defects of 2026-10-27 were all contracts the in-memory
 * pair satisfied and the Supabase pair did not (graph_version >= 1, a scope
 * key in a uuid column, string item ids against a uuid FK, the stand-in
 * product, s-keys vs u-keys). Each scenario below writes through the real
 * store code into tables that refuse what Postgres refuses, so the next such
 * mismatch fails here.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/loop-on-supabase.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { parseGraph } from "../graph";
import { uuidv7 } from "../ids";
import { openSession, runCommand, runTurn, submitAnswer, type LoopDeps } from "../loop";
import { graphsForStore, servableGraphsOn } from "../server";
import { withEvent } from "../store";
import type { SseEvent } from "../types";
import { O, PRODUCT, SLUG } from "./cells-fixtures";
import { cellsGraph, ITEM, LOOP_WIRINGS, standinGraph, STUDENT, supabaseLoopDeps, type LoopHarness } from "./supabase-loop-deps";

const open = (h: LoopHarness, studentId = h.studentId) => openSession(h.deps, { studentId, productId: SLUG, chapter: 2 });
const collect = async (gen: AsyncGenerator<SseEvent>) => {
  const out: SseEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};
const text = (evs: SseEvent[]) => evs.filter((e) => e.event === "text").map((e) => String(e.data)).join("");
type View = { state: string; rate: number; cursor: { unitKey: string; assetId: string; t: number }; bookmarks: unknown[]; skipped: string[]; openCheck: { purpose: string; total: number; attemptNo: number; item: { id: string; type: string } | null } | null; mastery: Record<string, { status: string; independent: boolean }> };
const done = (evs: SseEvent[]) => evs.find((e) => e.event === "done")!.data as { view: View; board?: string; decision?: { kind: string; rung?: number; reasons: string[] } };
const AT_S1 = { unitKey: "s1", assetId: "s1-explain-main" };

describe.each(LOOP_WIRINGS)("the teacher loop on the cells chapter — $name", ({ make }) => {
  it("open: a new session starts PAUSED at s1's main segment (graph version 1); reopening resumes it; resume=false starts another", async () => {
    const h = make();
    const s = await open(h);
    expect(s.graphVersion).toBe(1);
    expect(s.machine.state).toBe("PAUSED");
    expect(s.machine.cursor).toEqual({ graphVersion: 1, unitKey: "s1", assetId: "s1-explain-main", segmentId: "s1-explain-main", t: 0 });
    expect((await open(h)).id).toBe(s.id);
    const fresh = await openSession(h.deps, { studentId: h.studentId, productId: SLUG, chapter: 2, resume: false });
    expect(fresh.id).not.toBe(s.id);
    expect((await h.store.findSession(h.studentId, SLUG, 2))!.id).toBe(fresh.id);
    expect(await h.store.getSession(s.id)).not.toBeNull(); // the old one is closed, not gone
    await expect(openSession(h.deps, { studentId: h.studentId, productId: "another-book", chapter: 2 })).rejects.toMatchObject({ status: 404 });
  });

  it("play: continue plays, slower lowers the rate, repeat seeks to the real segment's last checkpoint", async () => {
    const h = make();
    const s = await open(h);
    const r1 = await runCommand(h.deps, s, { name: "continue", args: {} }, { ...AT_S1, t: 6000 });
    expect(r1.view.state).toBe("PRESENTING");
    expect(r1.board).toBe("play");
    expect(r1.view.cursor.t).toBe(6000);
    const r2 = await runCommand(h.deps, s, { name: "slower", args: {} });
    expect(r2.view.rate).toBeCloseTo(0.85, 5);
    const r3 = await runCommand(h.deps, s, { name: "repeat", args: {} });
    expect(r3.view.cursor.t).toBe(5475); // s1-explain-main's checkpoints: 0, 5475, 13412 …
    expect(r3.board).toBe("seek");
    expect((await h.store.getSession(s.id))!.machine).toEqual(s.machine); // what was saved is what the loop holds
  });

  it("skip with check: the 2-item skip check opens from the bank under bank:s1:check, bookmark pushed, no key in the view", async () => {
    const h = make();
    const s = await open(h);
    const evs = await collect(runTurn(h.deps, s, { eventId: uuidv7(), utterance: { text: "skip", modality: "typed" }, cursor: { ...AT_S1, t: 3000 } }));
    expect(text(evs)).toMatch(/2 quick questions first so it counts/);
    const d = done(evs);
    expect(d.view.state).toBe("AWAITING");
    expect(d.view.openCheck).toMatchObject({ purpose: "skip", total: 2, attemptNo: 1, item: { id: ITEM.s1_tf, type: "true_false" } });
    expect(d.view.cursor).toMatchObject({ unitKey: "s1", assetId: "bank:s1:check" });
    expect(d.view.bookmarks).toHaveLength(1);
    expect(d.board).toBe("pause");
    expect(d.decision?.reasons.join(" ")).toMatch(/items from the bank/);
    expect(JSON.stringify(d.view.openCheck)).not.toContain('"answer"');
    expect(s.machine.openCheck?.itemIds).toEqual([ITEM.s1_tf, ITEM.s1_mcq]);
  });

  it("check me: the unit check asks what the unit has (u1: two checkable items)", async () => {
    const h = make();
    const s = await open(h);
    const evs = await collect(runTurn(h.deps, s, { eventId: uuidv7(), utterance: { text: "check me", modality: "typed" } }));
    expect(text(evs)).toMatch(/Let's check .* 2 questions/);
    expect(done(evs).view.openCheck).toMatchObject({ purpose: "unit", total: 2, item: { id: ITEM.s1_tf } });
    // A unit with fewer than two checkable items has no check and says so (s4: one fill-blank, one short answer).
    const h2 = make();
    const s2 = await open(h2);
    await runCommand(h2.deps, s2, { name: "goto", args: { unitKey: "s4" } });
    const r = await runCommand(h2.deps, s2, { name: "practise", args: { n: 0 } });
    expect(r.speech).toMatch(/no check questions for Making a temporary slide yet/);
    expect(r.view.openCheck).toBeNull();
  });

  it("practise: s4's one gradeable item practises; a pass returns to the bookmark and never counts as mastery", async () => {
    const h = make();
    const s = await open(h);
    await runCommand(h.deps, s, { name: "goto", args: { unitKey: "s4" } }, { ...AT_S1, t: 2500 });
    const p = await runCommand(h.deps, s, { name: "practise", args: {} }, { unitKey: "s4", assetId: "s4-explain-main", t: 4000 });
    expect(p.view.openCheck).toMatchObject({ purpose: "practise", total: 1, item: { id: ITEM.s4_fill, type: "fill_blank" } });
    expect(p.view.cursor.assetId).toBe("bank:s4:practice");
    const g = await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s4_fill, attemptNo: 1, response: "Coverslip", modality: "typed" });
    expect(g).toMatchObject({ kind: "graded", outcome: "correct", independent: true, check: { passed: true, purpose: "practise" } });
    if (g.kind === "graded") {
      expect(g.view.cursor).toMatchObject({ unitKey: "s4", assetId: "s4-explain-main", t: 4000 }); // popped the practise bookmark
      expect(g.view.mastery.s4).toMatchObject({ status: "in_progress" });
      expect(g.speech).toMatch(/Nice work/);
    }
    expect((await h.store.listAttempts(s.id)).map((a) => [a.itemId, a.outcome])).toEqual([[ITEM.s4_fill, "correct"]]);
  });

  it("answer and mark: an assisted skip-check pass is provisional, graded once per attempt, and moves on to s2", async () => {
    const h = make();
    const s = await open(h);
    await collect(runTurn(h.deps, s, { eventId: uuidv7(), utterance: { text: "skip", modality: "typed" } }));
    const a1 = await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_tf, attemptNo: 1, response: "true", modality: "typed" });
    expect(a1).toMatchObject({ kind: "graded", outcome: "correct", independent: true });
    expect(a1.kind === "graded" && a1.view.openCheck?.item?.id).toBe(ITEM.s1_mcq);
    const a2 = await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_mcq, attemptNo: 1, response: "a", modality: "typed" });
    expect(a2).toMatchObject({ kind: "graded", outcome: "incorrect", hintAvailable: true, independent: false });
    expect(a2.kind === "graded" && a2.hint).toBeTruthy();
    expect(a2.kind === "graded" && a2.view.openCheck?.attemptNo).toBe(2);
    // attempt 1 is graded once: the repeat replays the stored mark, whatever the new response says
    await expect(submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_mcq, attemptNo: 1, response: "b", modality: "typed" })).resolves.toMatchObject({ kind: "graded", replayed: true, outcome: "incorrect" });
    const a3 = await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_mcq, attemptNo: 2, response: "b", modality: "typed" });
    expect(a3).toMatchObject({ kind: "graded", outcome: "correct", independent: false, check: { passed: true, independent: false, purpose: "skip" } });
    if (a3.kind === "graded") {
      expect(a3.view.mastery.s1).toMatchObject({ status: "provisional", independent: false });
      expect(a3.view.cursor).toMatchObject({ unitKey: "s2", assetId: "s2-explain-main" });
      expect(a3.view.state).toBe("PRESENTING");
      expect(a3.view.skipped).toEqual([]);
      expect(a3.speech).toMatch(/with a little help/);
    }
    expect((await h.store.listAttempts(s.id)).map((a) => [a.itemId, a.attemptNo, a.outcome, a.independent])).toEqual([
      [ITEM.s1_tf, 1, "correct", true],
      [ITEM.s1_mcq, 1, "incorrect", false],
      [ITEM.s1_mcq, 2, "correct", false],
    ]);
  });

  it("answer and mark: an independent unit-check pass is mastered; a failed skip check teaches the unit from the top", async () => {
    const h = make();
    const s = await open(h);
    await collect(runTurn(h.deps, s, { eventId: uuidv7(), utterance: { text: "check me", modality: "typed" } }));
    await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_tf, attemptNo: 1, response: "true", modality: "typed" });
    const pass = await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_mcq, attemptNo: 1, response: "b", modality: "typed" });
    expect(pass).toMatchObject({ kind: "graded", check: { passed: true, independent: true, purpose: "unit" } });
    if (pass.kind === "graded") expect(pass.view.mastery.s1).toMatchObject({ status: "mastered", independent: true });

    const h2 = make();
    const s2 = await open(h2);
    await runCommand(h2.deps, s2, { name: "skip", args: { scope: "unit", withCheck: true } }, { ...AT_S1, t: 1000 });
    for (const n of [1, 2, 3]) await submitAnswer(h2.deps, s2, { eventId: uuidv7(), itemId: ITEM.s1_tf, attemptNo: n, response: "false", modality: "typed" });
    const last = await submitAnswer(h2.deps, s2, { eventId: uuidv7(), itemId: ITEM.s1_mcq, attemptNo: 1, response: "b", modality: "typed" });
    expect(last).toMatchObject({ kind: "graded", check: { passed: false, purpose: "skip" } });
    if (last.kind === "graded") {
      expect(last.view.cursor).toMatchObject({ ...AT_S1, t: 0 });
      expect(last.view.mastery.s1?.status).toBe("needs_work");
      expect(last.speech).toMatch(/from the top/);
    }
    expect(await h2.store.listAttempts(s2.id)).toHaveLength(4);
  });

  it("answer and mark: a spoken answer is confirmed before it is graded; the wrong item or attempt is refused", async () => {
    const h = make();
    const s = await open(h);
    await collect(runTurn(h.deps, s, { eventId: uuidv7(), utterance: { text: "check me", modality: "typed" } }));
    const c = await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_tf, attemptNo: 1, response: "true", modality: "spoken" });
    expect(c).toMatchObject({ kind: "confirm", transcript: "true" });
    expect(c.view.state).toBe("CONFIRM_TRANSCRIPT");
    await expect(submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_mcq, attemptNo: 1, response: "b", modality: "typed" })).rejects.toMatchObject({ status: 409 });
    await expect(submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_tf, attemptNo: 2, response: "true", modality: "typed" })).rejects.toMatchObject({ status: 409 });
    const g = await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_tf, attemptNo: 1, response: "true", modality: "spoken", transcriptConfirmed: true });
    expect(g).toMatchObject({ kind: "graded", outcome: "correct", independent: true });
    expect((await h.store.listAttempts(s.id))[0]).toMatchObject({ modality: "spoken", transcriptConfirmed: true });
  });

  it("return: goto pushes a bookmark, return pops it back to the same t", async () => {
    const h = make();
    const s = await open(h);
    await runCommand(h.deps, s, { name: "continue", args: {} }, { ...AT_S1, t: 7000 });
    const g = await runCommand(h.deps, s, { name: "goto", args: { unitKey: "s5" } }, { ...AT_S1, t: 9000 });
    expect(g.view.cursor).toMatchObject({ unitKey: "s5", assetId: "s5-explain-main", t: 0 });
    expect(g.view.bookmarks).toEqual([{ graphVersion: 1, unitKey: "s1", assetId: "s1-explain-main", segmentId: "s1-explain-main", t: 9000, boardSnapshotId: null }]);
    const b = await runCommand(h.deps, s, { name: "return", args: {} });
    expect(b.view.cursor).toMatchObject({ ...AT_S1, t: 9000 });
    expect(b.view.bookmarks).toEqual([]);
    expect((await runCommand(h.deps, s, { name: "return", args: {} })).speech).toBe("There's nothing to go back to yet.");
  });

  it("explain again: a packaged unit has only its main explanation, so the ladder answers — rung 3 on s1, rung 2 on s2 (a validated figure)", async () => {
    const h = make();
    const s = await open(h);
    const r1 = await runCommand(h.deps, s, { name: "explain_again", args: {} });
    expect(r1.decision).toMatchObject({ kind: "generate", rung: 3 });
    expect(r1.speech).toBe("Let me put it another way.");
    await runCommand(h.deps, s, { name: "goto", args: { unitKey: "s2" } });
    const r2 = await runCommand(h.deps, s, { name: "explain_again", args: { style: "visual" } });
    expect(r2.decision).toMatchObject({ kind: "generate", rung: 2 });
    expect(r2.speech).toBe("Let me draw it more simply.");
  });

  it("replay: a repeated event id returns the stored result and runs nothing — for a command and for an answer", async () => {
    const h = make();
    const s = await open(h);
    const e = uuidv7();
    let runs = 0;
    const run = () =>
      withEvent(h.store, s.id, e, "command.skip", () => {
        runs++;
        return runCommand(h.deps, s, { name: "skip", args: { scope: "unit", withCheck: true } });
      });
    const first = await run();
    const again = await run();
    expect(runs).toBe(1);
    expect(again.replayed).toBe(true);
    expect(again.result.view.openCheck).toEqual(first.result.view.openCheck);
    expect(s.machine.openCheck?.itemIds).toEqual([ITEM.s1_tf, ITEM.s1_mcq]);
    expect((await h.store.listEvents(s.id)).map((ev) => ev.kind)).toEqual(["command.skip"]);
    const ae = uuidv7();
    const g1 = await submitAnswer(h.deps, s, { eventId: ae, itemId: ITEM.s1_tf, attemptNo: 1, response: "false", modality: "typed" });
    const g2 = await submitAnswer(h.deps, s, { eventId: ae, itemId: ITEM.s1_tf, attemptNo: 1, response: "true", modality: "typed" });
    expect(g1).toMatchObject({ kind: "graded", outcome: "incorrect", replayed: false });
    expect(g2).toMatchObject({ kind: "graded", outcome: "incorrect", replayed: true });
    expect(s.machine.openCheck).toMatchObject({ index: 0, attemptNo: 2 });
    expect(await h.store.listAttempts(s.id)).toHaveLength(1);
  });
});

describe("what only the Supabase wiring can tell us", () => {
  it("the rows a skip-check pass leaves: uuid item ids, the unit's objective, the check key, a derived mastery row", async () => {
    const h = supabaseLoopDeps();
    const s = await open(h);
    await collect(runTurn(h.deps, s, { eventId: uuidv7(), utterance: { text: "skip", modality: "typed" } }));
    const e1 = uuidv7();
    await submitAnswer(h.deps, s, { eventId: e1, itemId: ITEM.s1_tf, attemptNo: 1, response: "true", modality: "typed" });
    await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_mcq, attemptNo: 1, response: "a", modality: "typed" });
    await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_mcq, attemptNo: 2, response: "b", modality: "typed" });

    const sessions = h.db.rows("sk_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: s.id, student_id: STUDENT, product_id: SLUG, chapter: 2, graph_version: 1, status: "open", state: "PRESENTING", phase: "TEACH" });
    expect((sessions[0]!.machine as { cursor: { unitKey: string } }).cursor.unitKey).toBe("s2");

    const attempts = h.db.rows("item_attempts");
    expect(attempts.map((r) => [r.item_id, r.attempt_no, r.outcome, r.independent, r.hint_used, r.hints_used])).toEqual([
      [ITEM.s1_tf, 1, "correct", true, false, 0],
      [ITEM.s1_mcq, 1, "incorrect", false, false, 0],
      [ITEM.s1_mcq, 2, "correct", false, true, 1],
    ]);
    for (const r of attempts) expect(r).toMatchObject({ student_id: STUDENT, teaching_objective_id: O.u1, purpose: "skip", unit_key: "s1", check_key: e1, check_size: 2, modality: "typed", transcript_confirmed: true, grader: "deterministic", rule_version: "sk-b4.1" });

    const mastery = h.db.rows("mastery_state");
    expect(mastery).toHaveLength(1);
    expect(mastery[0]).toMatchObject({ student_id: STUDENT, teaching_objective_id: O.u1, status: "provisional", independent: false, rule_version: "sk-b5.1" });
    expect((mastery[0]!.evidence as { attempt_ids: string[] }).attempt_ids).toHaveLength(3);
    expect(h.store.lastMasteryError).toBeNull();
  });

  it("the graph's section keys resolve to the exporter's unit keys through sk_book_units (live fix #148): remove the rows and the chapter has no checks", async () => {
    const h = supabaseLoopDeps();
    expect((await h.items.listForUnit(SLUG, 2, "s1")).map((q) => q.id).sort()).toEqual([ITEM.s1_tf, ITEM.s1_mcq].sort());
    const bare = supabaseLoopDeps();
    bare.db.live("sk_book_units").splice(0);
    const s = await open(bare);
    const r = await runCommand(bare.deps, s, { name: "skip", args: { scope: "unit", withCheck: true } });
    expect(r.decision?.reasons[0]).toMatch(/has no check items; skipping records NO mastery/);
    expect(r.view.skipped).toEqual(["s1"]);
  });

  it("a student the memory store takes is one the tables refuse: a non-uuid id (22P02) and an id with no profiles row (23503)", async () => {
    const h = supabaseLoopDeps();
    await expect(open(h, "stu")).rejects.toThrow(/22P02/);
    await expect(open(h, "0f6a2c1e-7b3d-4e5f-8a9b-000000000000")).rejects.toThrow(/23503/);
    expect(h.db.rows("sk_sessions")).toHaveLength(0);
  });

  it("the stand-in graph is withheld on the Supabase store (its product has no sk_book_products row) and served on the in-memory store", async () => {
    const h = supabaseLoopDeps();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const graphs = [standinGraph(), cellsGraph()];
    const served = await servableGraphsOn(h.db, graphs);
    expect(served.map((g) => g.product_id)).toEqual([SLUG]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("sk-poc-biology is not in sk_book_products"));
    err.mockRestore();
    expect(graphsForStore(graphs, null)).toHaveLength(2);
    // The product row the filter matched is the one the bank resolves units through.
    expect(h.db.rows("sk_book_products")[0]).toMatchObject({ id: PRODUCT, slug: SLUG });
  });

  it("a graph the tables could not record is refused at load: chapter 0 and version 0", () => {
    const raw = JSON.parse(JSON.stringify(cellsGraph())) as Record<string, unknown>;
    expect(() => parseGraph({ ...raw, chapter: 0 })).toThrow(/bad chapter/);
    expect(() => parseGraph({ ...raw, version: 0 })).toThrow(/bad version/);
    // …because this is what the table says to such a row:
    const h = supabaseLoopDeps();
    const deps: LoopDeps = { ...h.deps, graph: { ...h.deps.graph, chapter: 0 } };
    return expect(openSession(deps, { studentId: STUDENT, productId: SLUG, chapter: 0 })).rejects.toThrow(/sk_sessions_chapter_check/);
  });
});
