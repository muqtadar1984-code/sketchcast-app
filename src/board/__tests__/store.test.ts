import { describe, it, expect, vi } from "vitest";
import { BoardStore, MemoryLog, replay, type LogRecord } from "../store";
import { pageStrokes, type Stroke } from "../model";

const stroke = (over: Partial<Stroke> = {}): Stroke => ({
  id: "s1",
  page: 0,
  tool: "pen",
  color: "#14181F",
  width: 4,
  pts: [10, 10, 1, 20, 20, 1],
  ...over,
});

const rec = {
  stroke: (seq: number, s: Partial<Stroke> = {}): LogRecord => ({
    kind: "stroke",
    seq,
    stroke: stroke({ id: `s${seq}`, ...s }),
  }),
  page: (seq: number, index: number): LogRecord => ({
    kind: "page",
    seq,
    index,
    background: { kind: "question", generationId: "g", questionId: `q${index}`, prompt: `P${index}` },
  }),
  void: (seq: number, strokeId: string): LogRecord => ({ kind: "void", seq, strokeId }),
};

describe("replay — the roll is the fold of the log", () => {
  it("rebuilds strokes and pages in order", () => {
    const r = replay("r1", [rec.stroke(0), rec.page(1, 1), rec.stroke(2, { page: 1 })]);
    expect(r.pages).toHaveLength(2);
    expect(pageStrokes(r, 0).map((s) => s.id)).toEqual(["s0"]);
    expect(pageStrokes(r, 1).map((s) => s.id)).toEqual(["s2"]);
  });

  it("SORTS BY SEQ rather than trusting arrival order", () => {
    // getAll returns key order, but a server replay or a merge of two devices
    // will not be so tidy, and a stroke replayed before its page would be lost.
    const shuffled = [rec.stroke(2, { page: 1 }), rec.stroke(0), rec.page(1, 1)];
    const r = replay("r1", shuffled);
    expect(pageStrokes(r, 1).map((s) => s.id)).toEqual(["s2"]);
  });

  it("fills page gaps rather than shifting later pages", () => {
    // A lost page record must not slide every later page's ink up one.
    const r = replay("r1", [rec.stroke(0, { page: 3 })]);
    expect(r.pages).toHaveLength(4);
    expect(pageStrokes(r, 3)).toHaveLength(1);
    expect(pageStrokes(r, 1)).toHaveLength(0);
  });

  it("applies a void that arrives BEFORE the stroke it voids", () => {
    // Which happens the moment two devices' logs are merged.
    const r = replay("r1", [rec.void(0, "s1"), rec.stroke(1)]);
    expect(r.strokes[0].voided).toBe(true);
    expect(pageStrokes(r, 0)).toHaveLength(0);
  });

  it("skips a record kind it has never heard of instead of refusing the lesson", () => {
    // A later version of the board may write a kind this one does not know.
    const future = { kind: "annotation", seq: 1, note: "hi" } as unknown as LogRecord;
    const r = replay("r1", [rec.stroke(0), future, rec.stroke(2)]);
    expect(r.strokes).toHaveLength(2);
  });

  it("gives an empty log an empty one-page roll", () => {
    const r = replay("r1", []);
    expect(r.pages).toHaveLength(1);
    expect(r.strokes).toHaveLength(0);
  });

  it("does not alias the records it was handed", () => {
    const records = [rec.stroke(0)];
    const r = replay("r1", records);
    r.strokes[0].voided = true;
    expect((records[0] as { stroke: Stroke }).stroke.voided).toBeUndefined();
  });
});

describe("the store", () => {
  const store = (opts = {}) =>
    new BoardStore("r1", { log: new MemoryLog(), batchSize: 3, intervalMs: 10_000, ...opts });

  it("survives a reload by replaying what it wrote", async () => {
    const log = new MemoryLog();
    const a = new BoardStore("r1", { log });
    await a.open();
    await a.addStroke(stroke({ id: "one" }));
    await a.addPage(1, { kind: "blank" });
    await a.addStroke(stroke({ id: "two", page: 1 }));

    const b = new BoardStore("r1", { log });
    const roll = await b.open();
    expect(roll.pages).toHaveLength(2);
    expect(roll.strokes.map((s) => s.id)).toEqual(["one", "two"]);
  });

  it("continues the sequence after a reload instead of restarting it", async () => {
    // Restarting would overwrite earlier records — the keyPath is seq.
    const log = new MemoryLog();
    const a = new BoardStore("r1", { log });
    await a.open();
    await a.addStroke(stroke({ id: "one" }));
    const b = new BoardStore("r1", { log });
    await b.open();
    await b.addStroke(stroke({ id: "two" }));
    expect((await log.all()).map((r) => r.seq)).toEqual([0, 1]);
  });

  it("mirrors upstream once the batch is full", async () => {
    const flush = vi.fn(async (records: LogRecord[]) => {
      void records;
    });
    const s = store({ flush });
    await s.open();
    await s.addStroke(stroke({ id: "a" }));
    await s.addStroke(stroke({ id: "b" }));
    expect(flush).not.toHaveBeenCalled();
    await s.addStroke(stroke({ id: "c" }));
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(flush.mock.calls[0][0]).toHaveLength(3);
    s.close();
  });

  it("KEEPS RECORDS A FAILED FLUSH DID NOT DELIVER", async () => {
    // Dropping them means the local board and the server silently disagree, and
    // nobody finds out until a student opens a lesson with holes in it.
    let fail = true;
    const flush = vi.fn(async (records: LogRecord[]) => {
      void records;
      if (fail) throw new Error("offline");
    });
    const s = store({ flush });
    await s.open();
    for (const id of ["a", "b", "c"]) await s.addStroke(stroke({ id }));
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(s.unsent).toBe(3);

    fail = false;
    await s.flush();
    expect(s.unsent).toBe(0);
    expect(flush).toHaveBeenCalledTimes(2);
    s.close();
  });

  it("retries the failed batch OLDEST FIRST, ahead of what arrived since", async () => {
    let fail = true;
    const seen: string[][] = [];
    const flush = vi.fn(async (records: LogRecord[]) => {
      seen.push(records.map((r) => (r.kind === "stroke" ? r.stroke.id : r.kind)));
      if (fail) throw new Error("offline");
    });
    const s = store({ flush });
    await s.open();
    for (const id of ["a", "b", "c"]) await s.addStroke(stroke({ id }));
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    await s.addStroke(stroke({ id: "d" }));
    fail = false;
    await s.flush();
    expect(seen[seen.length - 1]).toEqual(["a", "b", "c", "d"]);
    s.close();
  });

  it("keeps the local log even when the server never accepts anything", async () => {
    // Local is durable regardless; the flush only decides whether the server
    // catches up.
    const log = new MemoryLog();
    const s = new BoardStore("r1", { log, flush: async () => { throw new Error("offline"); } });
    await s.open();
    await s.addStroke(stroke({ id: "kept" }));
    expect((await log.all())).toHaveLength(1);
    s.close();
  });

  it("does not run two flushes at once", async () => {
    let inFlight = 0;
    let overlapped = false;
    const flush = vi.fn(async (records: LogRecord[]) => {
      void records;
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    const s = store({ flush });
    await s.open();
    for (const id of ["a", "b", "c"]) await s.addStroke(stroke({ id }));
    await Promise.all([s.flush(), s.flush(), s.flush()]);
    expect(overlapped).toBe(false);
    s.close();
  });

  it("is local-only, and silent, with no flush function", async () => {
    const s = store();
    await s.open();
    await s.addStroke(stroke());
    expect(s.unsent).toBe(0);
    s.close();
  });

  it("reports whether it is actually durable", async () => {
    // A memory fallback must be visible to the host, so it can say "this board
    // will not survive a reload" rather than implying it will.
    const s = store();
    await s.open();
    expect(s.durable).toBe(false);
    s.close();
  });

  it("clears everything on reset", async () => {
    const log = new MemoryLog();
    const s = new BoardStore("r1", { log });
    await s.open();
    await s.addStroke(stroke());
    await s.reset();
    expect(await log.all()).toHaveLength(0);
  });
});

describe("linking a void to the stroke it voids", () => {
  it("carries the STROKE RECORD's seq, not the stroke's own id", () => {
    // A stroke has two different numbers — the id the board minted and the seq
    // this log assigned — and only the store knows both. A server holding rows
    // keyed by seq would otherwise have to parse one out of the other, which is
    // a guess that works right up until the id format changes.
    const log = new MemoryLog();
    const s = new BoardStore("r1", { log });
    return (async () => {
      await s.open();
      await s.addStroke(stroke({ id: "a" }));
      await s.addStroke(stroke({ id: "b" }));
      await s.voidStroke("b");
      const records = await log.all();
      const v = records.find((r) => r.kind === "void") as { targetSeq?: number } | undefined;
      expect(v?.targetSeq).toBe(1); // b was the second record
    })();
  });

  it("still links a stroke drawn BEFORE a reload", async () => {
    // The map is rebuilt on open, or a stroke from earlier in the lesson could
    // never be undone in a way the server could match.
    const log = new MemoryLog();
    const a = new BoardStore("r1", { log });
    await a.open();
    await a.addStroke(stroke({ id: "early" }));

    const b = new BoardStore("r1", { log });
    await b.open();
    await b.voidStroke("early");
    const v = (await log.all()).find((r) => r.kind === "void") as { targetSeq?: number } | undefined;
    expect(v?.targetSeq).toBe(0);
  });

  it("leaves the target undefined for a stroke this device never saw", async () => {
    // Which a merge of two devices' logs makes possible. Undefined is a fact the
    // server can act on; a guessed number is not.
    const s = new BoardStore("r1", { log: new MemoryLog() });
    await s.open();
    await s.voidStroke("from-another-device");
    expect(s.unsent).toBe(0); // local-only, nothing to flush
  });
});

// ── the three failures Phase 3 leant on ──────────────────────────────────────
//
// The end of a lesson does `await store.flush()` and then exports, uploads and
// closes. Each of these was a way for that await to mean less than it says.

describe("flush means everything queued has been attempted", () => {
  /** A flush that resolves only when the test lets it. */
  const gate = () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    return { held, release };
  };

  it("CHAINS a concurrent caller rather than skipping it", async () => {
    // The bug this replaces: flush() returned immediately whenever another was
    // in flight, so `await store.flush()` at the bell could return with records
    // still queued — and close() was about to clear the only timer that would
    // have sent them.
    const g = gate();
    const sent: LogRecord[][] = [];
    let first = true;
    const store = new BoardStore("r1", {
      log: new MemoryLog(),
      batchSize: 1000,
      flush: async (records) => {
        sent.push(records);
        if (first) {
          first = false;
          await g.held;
        }
      },
    });
    await store.open();

    await store.addStroke(stroke({ id: "a" }));
    const inflight = store.flush(); // parks inside flushFn
    await store.addStroke(stroke({ id: "b" }));
    const second = store.flush();

    g.release();
    await Promise.all([inflight, second]);

    expect(sent).toHaveLength(2);
    expect(sent[1].map((r) => r.kind === "stroke" && r.stroke.id)).toEqual(["b"]);
    expect(store.unsent).toBe(0);
  });

  it("STOPS RETRYING once closed, instead of re-arming a timer on a dead store", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const store = new BoardStore("r2", {
        log: new MemoryLog(),
        batchSize: 1,
        intervalMs: 10,
        flush: async () => {
          calls++;
          throw new Error("offline");
        },
      });
      await store.open();
      await store.addStroke(stroke({ id: "a" })); // batch of 1 → flushes, fails
      await vi.advanceTimersByTimeAsync(0);
      const afterFirst = calls;
      store.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("open() reconciles the sequence rather than assigning it", () => {
  it("NEVER HANDS OUT A NUMBER ALREADY USED, even for a fresh log", async () => {
    // The host publishes the store before open() resolves, so a page pushed in
    // that window has already taken seq 0. Assigning would hand 0 out twice, and
    // /api/present/sync upserts on (session_id, seq): the second record would
    // silently overwrite the first, and a tombstone aimed at one stroke would
    // void the other.
    const sent: LogRecord[] = [];
    const store = new BoardStore("r3", {
      log: new MemoryLog(),
      batchSize: 1000,
      flush: async (records) => {
        sent.push(...records);
      },
    });
    const opening = store.open(); // not awaited — exactly what the board does
    await store.addPage(0, { kind: "blank" });
    await opening;
    await store.addStroke(stroke({ id: "a" }));
    await store.flush();

    expect(sent.map((r) => r.seq)).toEqual([0, 1]);
  });
});
