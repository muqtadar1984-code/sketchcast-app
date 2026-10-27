// SK B5 — the Supabase SessionStore against a fake of the query builder (no
// network): the same cases as store.test.ts for the in-memory store, plus
// what the tables add — one open session per student/product/chapter, a
// stale claim taken over, the check context stamped on an attempt, and the
// derived mastery_state recomputed after every attempt.
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { initialMachine, type OpenCheck } from "../state";
import { DuplicateAttemptError, withEvent, type Attempt } from "../store";
import { SupabaseSessionStore } from "../store-supabase";
import { skFakeDb } from "./fake-supabase";

const STUDENT = "55555555-0157-0000-0000-000000000001";
const OBJ = "e3eaa67d-5a4f-461a-9a7e-15e6af1e700d";
const I1 = "71acf08b-bb44-4f23-a34c-018764526476";
const I2 = "1c37dd99-abb1-40f7-ac11-5d1c57f35e9a";
const UNMAPPED = "5dffb113-070a-4ed6-927f-01efbffd8bb2";

const cursor = { graphVersion: 1, unitKey: "u5", assetId: "a1", segmentId: "s1", t: 0 };
const newSession = (studentId = STUDENT) => ({ studentId, productId: "cells-structure-function-organisation", chapter: 2, graphVersion: 1, machine: initialMachine(cursor), mastery: {}, history: [] });

function setup(opts: { now?: () => number } = {}) {
  let t = 1_700_000_000_000;
  const now = opts.now ?? (() => (t += 1000));
  const db = skFakeDb(now);
  db.seed("topic_questions", [
    { id: I1, teaching_objective_id: OBJ, status: "approved" },
    { id: I2, teaching_objective_id: OBJ, status: "approved" },
    { id: UNMAPPED, teaching_objective_id: null, status: "draft" },
  ]);
  const store = new SupabaseSessionStore(db, { now, pollMs: 1, inflightTimeoutMs: 500, staleClaimMs: 60_000 });
  return { db, store, now };
}

describe("sessions", () => {
  it("creates, finds the open one for (student, product, chapter), saves copies, refuses a ghost", async () => {
    const { db, store } = setup();
    const s1 = await store.createSession(newSession());
    expect((await store.findSession(STUDENT, "cells-structure-function-organisation", 2))!.id).toBe(s1.id);
    expect(await store.findSession("other", "cells-structure-function-organisation", 2)).toBeNull();
    s1.machine.cursor.t = 999;
    expect((await store.getSession(s1.id))!.machine.cursor.t).toBe(0); // not saved yet, not aliased
    await store.saveSession(s1);
    const saved = (await store.getSession(s1.id))!;
    expect(saved.machine.cursor.t).toBe(999);
    expect(saved.updatedAt).toBeGreaterThan(saved.createdAt);
    await expect(store.saveSession({ ...s1, id: uuidv7() })).rejects.toThrow(/unknown session/);
    expect(await store.getSession("not-a-uuid")).toBeNull();
    const row = db.rows("sk_sessions")[0]!;
    expect(row).toMatchObject({ status: "open", state: "ONBOARD", phase: "GUIDE", rate: 1, product_id: "cells-structure-function-organisation", chapter: 2 });
    expect(row.cursor).toEqual({ ...cursor, t: 999 });
  });
  it("one OPEN session per student × product × chapter: a new one closes the old", async () => {
    const { db, store } = setup();
    const s1 = await store.createSession(newSession());
    const s2 = await store.createSession(newSession());
    expect((await store.findSession(STUDENT, "cells-structure-function-organisation", 2))!.id).toBe(s2.id);
    const rows = db.rows("sk_sessions");
    expect(rows.find((r) => r.id === s1.id)).toMatchObject({ status: "closed" });
    expect(rows.find((r) => r.id === s2.id)).toMatchObject({ status: "open" });
    expect(await store.getSession(s1.id)).not.toBeNull(); // still readable by id (history)
  });
});

describe("events are unique on (sessionId, eventId)", () => {
  it("runs the work once; a repeat returns the stored result and runs nothing", async () => {
    const { db, store } = setup();
    let runs = 0;
    const work = async () => ({ n: ++runs });
    const a = await withEvent(store, "s1", "e1", "k", work);
    const b = await withEvent(store, "s1", "e1", "k", work);
    expect(a).toEqual({ result: { n: 1 }, replayed: false });
    expect(b).toEqual({ result: { n: 1 }, replayed: true });
    expect(runs).toBe(1);
    expect((await withEvent(store, "s2", "e1", "k", work)).result).toEqual({ n: 2 }); // another session = another key
    expect((await store.listEvents("s1")).map((e) => [e.kind, e.result])).toEqual([["k", { n: 1 }]]);
    expect(db.rows("sk_events").every((r) => r.status === "stored")).toBe(true);
  });
  it("a concurrent duplicate waits for the in-flight run and gets the same result", async () => {
    const { store } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const work = async () => {
      runs++;
      await gate;
      return "done";
    };
    const p1 = withEvent(store, "s", "e", "k", work);
    await new Promise((r) => setTimeout(r, 5));
    const claim = await store.claimEvent("s", "e");
    expect(claim.status).toBe("inflight");
    const p2 = withEvent(store, "s", "e", "k", work);
    release();
    expect(await p1).toEqual({ result: "done", replayed: false });
    expect(await p2).toEqual({ result: "done", replayed: true });
    expect(runs).toBe(1);
  });
  it("a failed run releases the claim so the client's retry can run", async () => {
    const { db, store } = setup();
    await expect(withEvent(store, "s", "e", "k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(db.rows("sk_events")).toHaveLength(0);
    expect((await withEvent(store, "s", "e", "k", async () => "second")).result).toBe("second");
  });
  it("a waiting duplicate is told when the first run released the claim", async () => {
    const { store } = setup();
    await store.claimEvent("s", "e");
    const claim = await store.claimEvent("s", "e");
    expect(claim.status).toBe("inflight");
    const done = claim.status === "inflight" ? claim.done : Promise.resolve(null);
    await store.releaseEvent("s", "e");
    await expect(done).rejects.toThrow(/released/);
  });
  it("a stale in-flight claim (a dead run) is taken over", async () => {
    let t = 1_700_000_000_000;
    const { db, store } = setup({ now: () => t });
    expect((await store.claimEvent("s", "e")).status).toBe("new");
    t += 61_000; // past staleClaimMs
    expect((await store.claimEvent("s", "e")).status).toBe("new");
    expect(db.rows("sk_events")).toHaveLength(1);
    expect(db.rows("sk_events")[0]).toMatchObject({ status: "inflight" });
  });
  it("completing an event that was never claimed, or twice, is refused", async () => {
    const { store } = setup();
    await expect(store.completeEvent("s", "e", "k", 1)).rejects.toThrow(/already stored or not claimed/);
    await store.claimEvent("s", "e");
    await store.completeEvent("s", "e", "k", 1);
    await expect(store.completeEvent("s", "e", "k", 2)).rejects.toThrow(/already stored/);
  });
});

/** Put the session's machine in AWAITING on a 2-item unit check at `index`. */
async function openCheck(store: SupabaseSessionStore, sessionId: string, patch: Partial<OpenCheck> & Pick<OpenCheck, "index" | "attemptNo" | "hintsUsed">): Promise<void> {
  const s = (await store.getSession(sessionId))!;
  s.machine = { ...s.machine, state: "AWAITING", openCheck: { unitKey: "u5", itemIds: [I1, I2], purpose: "unit", results: [], independent: true, ...patch } };
  await store.saveSession(s);
}

const attempt = (sessionId: string, itemId: string, attemptNo: number, outcome: Attempt["outcome"], hintsUsed = 0, extra: Partial<Attempt> = {}): Attempt => ({
  sessionId,
  eventId: uuidv7(),
  itemId,
  attemptNo,
  response: "B",
  modality: "typed",
  transcriptConfirmed: true,
  outcome,
  score: outcome === "correct" ? 1 : 0,
  max: 1,
  hintsUsed,
  independent: outcome === "correct" && attemptNo === 1 && hintsUsed === 0,
  grader: "deterministic",
  ruleVersion: "sk-b4.1",
  gradedAt: 1,
  ...extra,
});

describe("attempts are graded once per (sessionId, itemId, attemptNo)", () => {
  it("inserts once and refuses the duplicate with the stored row", async () => {
    const { store } = setup();
    const s = await store.createSession(newSession());
    await openCheck(store, s.id, { index: 0, attemptNo: 1, hintsUsed: 0 });
    await store.putAttempt(attempt(s.id, I1, 1, "incorrect"));
    await openCheck(store, s.id, { index: 0, attemptNo: 2, hintsUsed: 1 });
    await store.putAttempt(attempt(s.id, I1, 2, "incorrect", 1));
    await expect(store.putAttempt(attempt(s.id, I1, 1, "correct"))).rejects.toBeInstanceOf(DuplicateAttemptError);
    try {
      await store.putAttempt(attempt(s.id, I1, 1, "correct"));
    } catch (e) {
      expect((e as DuplicateAttemptError).existing).toMatchObject({ itemId: I1, attemptNo: 1, outcome: "incorrect", teachingObjectiveId: OBJ });
    }
    expect((await store.getAttempt(s.id, I1, 1))!.outcome).toBe("incorrect");
    expect(await store.listAttempts(s.id)).toHaveLength(2);
    expect(await store.getAttempt(s.id, I1, 3)).toBeNull();
  });
  it("refuses an item id that is not a topic_questions id and an unknown session", async () => {
    const { store } = setup();
    const s = await store.createSession(newSession());
    await expect(store.putAttempt(attempt(s.id, "ch2-u4-c1", 1, "correct"))).rejects.toThrow(/not a topic_questions id/);
    await expect(store.putAttempt(attempt(uuidv7(), I1, 1, "correct"))).rejects.toThrow(/unknown session/);
  });
  it("stamps the check context from the session's open check and resolves the objective from the item", async () => {
    const { db, store } = setup();
    const s = await store.createSession(newSession());
    await openCheck(store, s.id, { index: 0, attemptNo: 1, hintsUsed: 0 });
    const a1 = await store.putAttempt(attempt(s.id, I1, 1, "incorrect"));
    await openCheck(store, s.id, { index: 0, attemptNo: 2, hintsUsed: 1 });
    await store.putAttempt(attempt(s.id, I1, 2, "correct", 1));
    await openCheck(store, s.id, { index: 1, attemptNo: 1, hintsUsed: 0 });
    await store.putAttempt(attempt(s.id, I2, 1, "correct"));
    const rows = db.rows("item_attempts");
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ student_id: STUDENT, teaching_objective_id: OBJ, purpose: "unit", unit_key: "u5", check_key: a1.eventId, check_size: 2, rule_version: "sk-b4.1" });
    expect(rows.map((r) => [r.attempt_no, r.hint_used, r.hints_used, r.independent])).toEqual([[1, false, 0, false], [2, true, 1, false], [1, false, 0, true]]);
  });
  it("an attempt outside any check is stored with no check context (practice only)", async () => {
    const { db, store } = setup();
    const s = await store.createSession(newSession());
    await store.putAttempt(attempt(s.id, I1, 1, "correct"));
    expect(db.rows("item_attempts")[0]).toMatchObject({ purpose: null, unit_key: null, check_key: null, check_size: null, teaching_objective_id: OBJ });
    expect((await store.getMastery(STUDENT, OBJ))!.status).toBe("in_progress");
  });
});

describe("mastery_state is recomputed from item_attempts after every attempt (rule sk-b5.1)", () => {
  it("an independent 2-of-2 pass → mastered, independent, evidence lists both attempts", async () => {
    const { db, store } = setup();
    const s = await store.createSession(newSession());
    await openCheck(store, s.id, { index: 0, attemptNo: 1, hintsUsed: 0 });
    const a1 = await store.putAttempt(attempt(s.id, I1, 1, "correct"));
    expect((await store.getMastery(STUDENT, OBJ))).toMatchObject({ status: "in_progress", independent: false });
    await openCheck(store, s.id, { index: 1, attemptNo: 1, hintsUsed: 0 });
    const a2 = await store.putAttempt(attempt(s.id, I2, 1, "correct"));
    const m = (await store.getMastery(STUDENT, OBJ))!;
    expect(m).toMatchObject({ status: "mastered", independent: true, rule_version: "sk-b5.1" });
    expect(m.evidence).toMatchObject({ correct: 2, total: 2, attempt_ids: [a1.eventId, a2.eventId] });
    expect(db.rows("mastery_state")).toHaveLength(1);
    expect(db.rows("mastery_state")[0]).toMatchObject({ student_id: STUDENT, teaching_objective_id: OBJ, rule_version: "sk-b5.1" });
  });
  it("an assisted pass (a hint on the way) → provisional, NOT independent", async () => {
    const { store } = setup();
    const s = await store.createSession(newSession());
    await openCheck(store, s.id, { index: 0, attemptNo: 1, hintsUsed: 0 });
    await store.putAttempt(attempt(s.id, I1, 1, "incorrect"));
    await openCheck(store, s.id, { index: 0, attemptNo: 2, hintsUsed: 1 });
    await store.putAttempt(attempt(s.id, I1, 2, "correct", 1));
    await openCheck(store, s.id, { index: 1, attemptNo: 1, hintsUsed: 0 });
    await store.putAttempt(attempt(s.id, I2, 1, "correct"));
    const m = (await store.getMastery(STUDENT, OBJ))!;
    expect(m).toMatchObject({ status: "provisional", independent: false });
    expect(m.evidence.attempt_ids).toHaveLength(3);
  });
  it("a failed check → needs_work; an unmapped item writes no mastery row", async () => {
    const { db, store } = setup();
    const s = await store.createSession(newSession());
    await openCheck(store, s.id, { index: 0, attemptNo: 1, hintsUsed: 0 });
    await store.putAttempt(attempt(s.id, I1, 1, "incorrect"));
    await openCheck(store, s.id, { index: 0, attemptNo: 2, hintsUsed: 1 });
    await store.putAttempt(attempt(s.id, I1, 2, "incorrect", 1));
    await openCheck(store, s.id, { index: 0, attemptNo: 3, hintsUsed: 2 });
    await store.putAttempt(attempt(s.id, I1, 3, "incorrect", 2));
    await openCheck(store, s.id, { index: 1, attemptNo: 1, hintsUsed: 0 });
    await store.putAttempt(attempt(s.id, I2, 1, "correct"));
    expect((await store.getMastery(STUDENT, OBJ))).toMatchObject({ status: "needs_work", independent: false });

    const s2 = await store.createSession(newSession("55555555-0157-0000-0000-000000000002"));
    await store.putAttempt(attempt(s2.id, UNMAPPED, 1, "correct"));
    expect(db.rows("item_attempts").find((r) => r.session_id === s2.id)).toMatchObject({ teaching_objective_id: null });
    expect(db.rows("mastery_state").filter((r) => r.student_id === "55555555-0157-0000-0000-000000000002")).toHaveLength(0);
  });
  it("an explicit teachingObjectiveId on the attempt is used as given (null = unmapped)", async () => {
    const { db, store } = setup();
    const s = await store.createSession(newSession());
    await store.putAttempt(attempt(s.id, I1, 1, "correct", 0, { teachingObjectiveId: null }));
    expect(db.rows("item_attempts")[0]).toMatchObject({ teaching_objective_id: null });
    expect(db.rows("mastery_state")).toHaveLength(0);
  });
});
