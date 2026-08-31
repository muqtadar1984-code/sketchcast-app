// Local-first persistence: the roll survives the lesson, not the network.
//
// THE LOG IS THE TRUTH AND THE ROLL IS ITS FOLD. Every change is an append —
// a stroke, a page, a void — and the board is rebuilt by replaying them. That
// is the same shape as the server's `present_strokes` table and as the ERE
// event log, and it is what makes the two reconcilable: the client and the
// server are folding the same sequence rather than exchanging snapshots that
// have to be diffed.
//
// SCHOOL WI-FI DROPS MID-LESSON. That is the whole reason this exists. Writes
// land locally first and are mirrored to the server in batches; a network that
// goes away costs nothing but a later flush, and the teacher never finds out.
//
// The IndexedDB details sit behind `StrokeLog` so the logic above them — batching,
// sequencing, replay — is testable in node and so the standalone board can plug
// in something else entirely.

import {
  newRoll,
  type PageBackground,
  type Roll,
  type Stroke,
} from "./model";

// ── the log ──────────────────────────────────────────────────────────────────

export type LogRecord =
  | { kind: "stroke"; seq: number; stroke: Stroke }
  | { kind: "page"; seq: number; index: number; background: PageBackground }
  | {
      kind: "void";
      seq: number;
      strokeId: string;
      /**
       * The seq of the STROKE RECORD this voids.
       *
       * A stroke carries two different numbers — the id the board minted for it
       * and the sequence this log assigned it — and only the store knows both.
       * Without carrying the link, a server holding rows keyed by sequence has
       * to guess which stroke an id refers to, and parsing it out of the id is
       * a guess that works until the id format changes. Undefined when the void
       * arrives for a stroke this store never saw, which a merge of two devices
       * makes possible.
       */
      targetSeq?: number;
    };

/** Somewhere to append records and read them back in order. */
export interface StrokeLog {
  open(): Promise<void>;
  append(records: LogRecord[]): Promise<void>;
  all(): Promise<LogRecord[]>;
  clear(): Promise<void>;
  close(): void;
}

/**
 * An in-memory log.
 *
 * Not only a test double: it is the FALLBACK when IndexedDB is unavailable —
 * a private window, an old WebView, a browser with site data blocked. The board
 * then works exactly as it does otherwise and simply does not survive a reload,
 * which is a much better failure than refusing to open in front of a class.
 * `BoardStore.durable` tells a host which one it got, so it can say so.
 */
export class MemoryLog implements StrokeLog {
  private records: LogRecord[] = [];
  async open(): Promise<void> {}
  async append(records: LogRecord[]): Promise<void> {
    this.records.push(...records);
  }
  async all(): Promise<LogRecord[]> {
    return this.records.slice();
  }
  async clear(): Promise<void> {
    this.records = [];
  }
  close(): void {}
}

const DB_VERSION = 1;
const STORE = "records";

/** IndexedDB, one database per roll. */
export class IdbLog implements StrokeLog {
  private db: IDBDatabase | null = null;
  constructor(private readonly rollId: string) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("no IndexedDB"));
        return;
      }
      const req = indexedDB.open(`sketchcast-board-${this.rollId}`, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "seq" });
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB refused to open"));
      // A second tab holding an older version would block this forever, and a
      // board that never opens is indistinguishable from one that is broken.
      req.onblocked = () => reject(new Error("IndexedDB blocked by another tab"));
    });
  }

  append(records: LogRecord[]): Promise<void> {
    const db = this.db;
    if (!db) return Promise.reject(new Error("not open"));
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const os = tx.objectStore(STORE);
      for (const r of records) os.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("write aborted"));
    });
  }

  all(): Promise<LogRecord[]> {
    const db = this.db;
    if (!db) return Promise.reject(new Error("not open"));
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as LogRecord[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error("read failed"));
    });
  }

  clear(): Promise<void> {
    const db = this.db;
    if (!db) return Promise.reject(new Error("not open"));
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("clear failed"));
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

// ── replay ───────────────────────────────────────────────────────────────────

/**
 * Rebuild a roll from its log. Pure, and the heart of the whole design.
 *
 * Records are sorted by seq rather than trusted in arrival order: IndexedDB's
 * getAll returns key order, which is what we want, but a server replay or a
 * merge of two devices will not be so tidy, and a stroke replayed before the
 * page it belongs to would be dropped.
 *
 * UNKNOWN RECORD KINDS ARE SKIPPED, NOT FATAL. A later version of the board may
 * write a kind this one has never heard of; refusing to open the whole lesson
 * because of one unrecognised entry is the wrong trade for a teacher standing in
 * front of a class.
 */
export function replay(rollId: string, records: LogRecord[]): Roll {
  const roll = newRoll(rollId);
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const voided = new Set<string>();

  for (const r of sorted) {
    if (r.kind === "page") {
      // Pages are dense, so a record for index n fills every gap before it. A
      // log that lost a page record must not shift every later page's ink.
      while (roll.pages.length <= r.index) {
        roll.pages.push({ index: roll.pages.length, background: { kind: "blank" } });
      }
      roll.pages[r.index].background = r.background;
    } else if (r.kind === "stroke") {
      while (roll.pages.length <= r.stroke.page) {
        roll.pages.push({ index: roll.pages.length, background: { kind: "blank" } });
      }
      roll.strokes.push({ ...r.stroke });
    } else if (r.kind === "void") {
      voided.add(r.strokeId);
    }
  }
  // Applied at the end so a void may legitimately precede the stroke it voids —
  // which happens the moment two devices' logs are merged.
  for (const s of roll.strokes) if (voided.has(s.id)) s.voided = true;
  return roll;
}

// ── the store ────────────────────────────────────────────────────────────────

export type FlushFn = (records: LogRecord[]) => Promise<void>;

export type StoreOpts = {
  /** Mirror a batch to the server. Absent means local-only. */
  flush?: FlushFn;
  /** Send after this many pending records. */
  batchSize?: number;
  /** …or after this long, whichever comes first. */
  intervalMs?: number;
  /** Injectable for tests and for the standalone board. */
  log?: StrokeLog;
  /** Injectable so tests need no timers of their own. */
  now?: () => number;
};

/**
 * Appends locally, mirrors upstream in batches.
 *
 * A FAILED FLUSH KEEPS ITS RECORDS. They go back on the pending queue and are
 * retried with the next batch, because the alternative — dropping them — means
 * the local board and the server silently disagree, and nobody finds out until
 * a student opens a lesson with holes in it. The local log is already durable
 * by then, so nothing is lost either way; this only decides whether the server
 * catches up.
 */
export class BoardStore {
  private log: StrokeLog;
  private readonly flushFn?: FlushFn;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private pending: LogRecord[] = [];
  private seq = 0;
  /** stroke id -> the seq of the record that carried it. */
  private strokeSeq = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The flush currently in flight, so a second caller chains rather than
   *  skipping — see flush(). */
  private inflight: Promise<void> | null = null;
  private closed = false;
  /** False when IndexedDB was unavailable and this is memory-only. */
  durable = false;

  constructor(
    readonly rollId: string,
    private readonly opts: StoreOpts = {},
  ) {
    this.log = opts.log ?? new IdbLog(rollId);
    this.flushFn = opts.flush;
    this.batchSize = opts.batchSize ?? 20;
    this.intervalMs = opts.intervalMs ?? 3000;
  }

  /**
   * Open the log and return whatever it already holds.
   *
   * A failure here is NOT fatal: it falls back to memory and reports
   * `durable === false`. A board that refuses to open because storage is
   * unavailable is a board that fails in the one moment it must not.
   */
  async open(): Promise<Roll> {
    try {
      await this.log.open();
      this.durable = !(this.log instanceof MemoryLog);
    } catch {
      this.durable = false;
      const mem = new MemoryLog();
      await mem.open();
      this.log = mem;
    }
    const records = await this.log.all().catch(() => [] as LogRecord[]);
    // RECONCILED, NEVER ASSIGNED. The host publishes the store before this
    // resolves — opening IndexedDB is two awaits — so a page pushed or a stroke
    // drawn in that window has ALREADY taken seq 0. Assigning would hand the
    // same number out twice, and /api/present/sync upserts on (session_id, seq):
    // the second record would silently overwrite the first, and a tombstone
    // aimed at one stroke would void the other.
    this.seq = Math.max(this.seq, records.reduce((m, r) => Math.max(m, r.seq), -1) + 1);
    // Rebuilt on open, or a stroke drawn before a reload could never be voided
    // in a way the server could match.
    for (const r of records) if (r.kind === "stroke") this.strokeSeq.set(r.stroke.id, r.seq);
    return replay(this.rollId, records);
  }

  private async record(r: LogRecord): Promise<void> {
    // Local FIRST. If the process dies between here and the flush, the stroke
    // is still on the device.
    await this.log.append([r]).catch(() => {
      /* a failed local write must not throw into a pointer handler */
    });
    if (!this.flushFn) return;
    this.pending.push(r);
    if (this.pending.length >= this.batchSize) void this.flush();
    else this.schedule();
  }

  addStroke(stroke: Stroke): Promise<void> {
    const seq = this.seq++;
    this.strokeSeq.set(stroke.id, seq);
    return this.record({ kind: "stroke", seq, stroke });
  }

  addPage(index: number, background: PageBackground): Promise<void> {
    return this.record({ kind: "page", seq: this.seq++, index, background });
  }

  voidStroke(strokeId: string): Promise<void> {
    return this.record({
      kind: "void",
      seq: this.seq++,
      strokeId,
      targetSeq: this.strokeSeq.get(strokeId),
    });
  }

  private schedule(): void {
    // A closed store has nobody left to send for it. Without this a flush that
    // fails after close() re-arms a timer on a dead store and retries every
    // three seconds for the life of the page.
    if (this.closed || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.intervalMs);
  }

  /**
   * Send everything pending, and MEAN IT.
   *
   * Awaiting this has to mean "everything queued when I called has been
   * attempted", because that is what the two callers assume — the end-of-lesson
   * reconciliation and the unmount cleanup. An earlier version returned
   * immediately while another flush was in flight, which made the await a no-op
   * at exactly the two moments it was load-bearing: a batch that filled up on
   * its own (20 records) put a flush in flight, and the awaited one then
   * returned with the remainder still queued and nothing but a 3s timer to send
   * it — a timer close() was about to clear.
   *
   * So concurrent callers CHAIN rather than skip. One request is in flight at a
   * time; the second waits for it and then sends what accumulated.
   */
  flush(): Promise<void> {
    if (!this.flushFn) return Promise.resolve();
    const run = (this.inflight ?? Promise.resolve()).then(() => this.send());
    // The chain must not break on a failure — send() already swallows its own.
    this.inflight = run.catch(() => {});
    return run;
  }

  private async send(): Promise<void> {
    if (!this.flushFn || !this.pending.length) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = [];
    try {
      await this.flushFn(batch);
    } catch {
      // Back on the queue, oldest first, to be retried with the next batch.
      this.pending = batch.concat(this.pending);
      this.schedule();
    }
  }

  /** How many records are waiting to reach the server. For a "saving…" hint. */
  get unsent(): number {
    return this.pending.length;
  }

  async reset(): Promise<void> {
    this.pending = [];
    this.seq = 0;
    this.strokeSeq.clear();
    await this.log.clear().catch(() => {});
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.log.close();
  }
}
