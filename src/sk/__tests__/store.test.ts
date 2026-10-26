// SK B4 — the in-memory SessionStore: idempotent events, in-flight claims,
// graded-once attempts, copies not references.
import { describe, expect, it } from "vitest";
import { initialMachine } from "../state";
import { DuplicateAttemptError, InMemorySessionStore, withEvent, type Attempt } from "../store";
import { isEventId, uuidv7 } from "../ids";

const cursor = { graphVersion: 1, unitKey: "u1", assetId: "a1", segmentId: "s1", t: 0 };
const newSession = (studentId = "stu") => ({ studentId, productId: "p", chapter: 2, graphVersion: 1, machine: initialMachine(cursor), mastery: {}, history: [] });

describe("ids", () => {
  it("uuidv7 is RFC-shaped, version 7, and sorts by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(isEventId(a)).toBe(true);
    expect(a[14]).toBe("7");
    expect(a < b).toBe(true);
    expect(a.slice(0, 12)).toBe(b.slice(0, 12).slice(0, 11) + a[11]); // same ms prefix up to the last digit
    expect(isEventId("not-a-uuid")).toBe(false);
  });
});

describe("sessions", () => {
  it("creates, finds the most recent for (student, product, chapter), and saves copies", async () => {
    const store = new InMemorySessionStore();
    const s1 = await store.createSession(newSession());
    const s2 = await store.createSession(newSession());
    expect((await store.findSession("stu", "p", 2))!.id).toBe(s2.id);
    expect(await store.findSession("other", "p", 2)).toBeNull();
    s1.machine.cursor.t = 999;
    expect((await store.getSession(s1.id))!.machine.cursor.t).toBe(0); // not saved yet, and not aliased
    await store.saveSession(s1);
    expect((await store.getSession(s1.id))!.machine.cursor.t).toBe(999);
    await expect(store.saveSession({ ...s1, id: "ghost" })).rejects.toThrow(/unknown session/);
  });
});

describe("events are unique on (sessionId, eventId)", () => {
  it("runs the work once; a repeat returns the stored result and runs nothing", async () => {
    const store = new InMemorySessionStore();
    let runs = 0;
    const work = async () => ({ n: ++runs });
    const a = await withEvent(store, "s1", "e1", "k", work);
    const b = await withEvent(store, "s1", "e1", "k", work);
    expect(a).toEqual({ result: { n: 1 }, replayed: false });
    expect(b).toEqual({ result: { n: 1 }, replayed: true });
    expect(runs).toBe(1);
    // Same eventId on ANOTHER session is a different key.
    expect((await withEvent(store, "s2", "e1", "k", work)).result).toEqual({ n: 2 });
    expect((await store.listEvents("s1")).map((e) => e.kind)).toEqual(["k"]);
  });
  it("a concurrent duplicate waits for the in-flight run and gets the same result", async () => {
    const store = new InMemorySessionStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const work = async () => {
      runs++;
      await gate;
      return "done";
    };
    const p1 = withEvent(store, "s", "e", "k", work);
    const claim = await store.claimEvent("s", "e");
    expect(claim.status).toBe("inflight");
    const p2 = withEvent(store, "s", "e", "k", work);
    release();
    expect(await p1).toEqual({ result: "done", replayed: false });
    expect(await p2).toEqual({ result: "done", replayed: true });
    expect(runs).toBe(1);
  });
  it("a failed run releases the claim so the client's retry can run", async () => {
    const store = new InMemorySessionStore();
    await expect(withEvent(store, "s", "e", "k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await withEvent(store, "s", "e", "k", async () => "second")).result).toBe("second");
  });
});

describe("attempts are graded once per (sessionId, itemId, attemptNo)", () => {
  const attempt = (attemptNo: number): Attempt => ({ sessionId: "s", eventId: uuidv7(), itemId: "i1", attemptNo, response: "x", modality: "typed", transcriptConfirmed: true, outcome: "incorrect", score: 0, max: 1, hintsUsed: 0, independent: false, grader: "deterministic", ruleVersion: "t", gradedAt: 1 });
  it("inserts once and refuses the duplicate with the stored row", async () => {
    const store = new InMemorySessionStore();
    await store.putAttempt(attempt(1));
    await store.putAttempt(attempt(2));
    await expect(store.putAttempt({ ...attempt(1), outcome: "correct" })).rejects.toBeInstanceOf(DuplicateAttemptError);
    expect((await store.getAttempt("s", "i1", 1))!.outcome).toBe("incorrect");
    expect(await store.listAttempts("s")).toHaveLength(2);
    expect(await store.getAttempt("s", "i1", 3)).toBeNull();
  });
});
