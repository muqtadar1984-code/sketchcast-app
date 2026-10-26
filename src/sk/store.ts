// SK B4 — the session store seam. Database tables (`sk_sessions`, `sk_events`,
// `item_attempts`, plan §10) arrive in a later step; until then the in-memory
// implementation below carries the same contract so the routes and the loop
// are written once:
//
//   * events are append-only and unique on (sessionId, eventId): a repeated
//     eventId returns the STORED result and performs no side effect
//     (contracts §5.3);
//   * a claim protocol lets a streaming route (the turn's SSE) mark an event
//     in flight, so a concurrent duplicate waits for the first instead of
//     running the model twice;
//   * graded attempts are unique on (sessionId, itemId, attemptNo) — grading
//     runs once (contracts §5.6).

import type { Turn } from "@/utils/assistant/provider";
import { uuidv7 } from "./ids";
import type { MachineState } from "./state";
import type { GradeOutcome, MasteryMap } from "./types";

export type SkSession = {
  id: string;
  studentId: string;
  productId: string;
  chapter: number;
  graphVersion: number;
  machine: MachineState;
  mastery: MasteryMap;
  /** Recent teacher turns (question → answer) for the Sonnet call's context. */
  history: Turn[];
  createdAt: number;
  updatedAt: number;
};

export type NewSession = Omit<SkSession, "id" | "createdAt" | "updatedAt">;

export type StoredEvent<T = unknown> = { sessionId: string; eventId: string; kind: string; result: T; at: number };

export type Attempt = {
  sessionId: string;
  eventId: string;
  itemId: string;
  attemptNo: number;
  response: unknown;
  modality: "typed" | "spoken";
  transcriptConfirmed: boolean;
  outcome: GradeOutcome;
  score: number;
  max: number;
  hintsUsed: number;
  independent: boolean;
  grader: "deterministic" | "llm" | "teacher";
  ruleVersion: string;
  gradedAt: number;
  /** B5: the item's teaching objective (`topic_questions.teaching_objective_id`).
   * Optional — the Supabase store resolves it from the item when absent;
   * `null` means the item is unmapped and gives no mastery evidence (plan §14). */
  teachingObjectiveId?: string | null;
};

export type Claim<T> = { status: "new" } | { status: "stored"; event: StoredEvent<T> } | { status: "inflight"; done: Promise<StoredEvent<T>> };

export class DuplicateAttemptError extends Error {
  constructor(public readonly existing: Attempt) {
    super(`attempt ${existing.itemId}#${existing.attemptNo} already graded`);
  }
}

export interface SessionStore {
  createSession(s: NewSession): Promise<SkSession>;
  getSession(id: string): Promise<SkSession | null>;
  /** The student's most recent session for this product/chapter (for resume). */
  findSession(studentId: string, productId: string, chapter: number): Promise<SkSession | null>;
  saveSession(s: SkSession): Promise<void>;

  /** Claim (sessionId, eventId). "new" → the caller runs the work and must
   * call completeEvent or releaseEvent; "stored" → replay; "inflight" → await. */
  claimEvent<T>(sessionId: string, eventId: string): Promise<Claim<T>>;
  completeEvent<T>(sessionId: string, eventId: string, kind: string, result: T): Promise<StoredEvent<T>>;
  /** The work failed: drop the claim so the client's retry can run it. */
  releaseEvent(sessionId: string, eventId: string, error: unknown): Promise<void>;
  listEvents(sessionId: string): Promise<StoredEvent[]>;

  getAttempt(sessionId: string, itemId: string, attemptNo: number): Promise<Attempt | null>;
  /** Insert; throws DuplicateAttemptError when (sessionId, itemId, attemptNo) exists. */
  putAttempt(a: Attempt): Promise<Attempt>;
  listAttempts(sessionId: string): Promise<Attempt[]>;
}

/** Run `work` once per (sessionId, eventId): a duplicate returns the stored
 * result (`replayed: true`); a concurrent duplicate waits for the first. */
export async function withEvent<T>(store: SessionStore, sessionId: string, eventId: string, kind: string, work: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
  const claim = await store.claimEvent<T>(sessionId, eventId);
  if (claim.status === "stored") return { result: claim.event.result, replayed: true };
  if (claim.status === "inflight") return { result: (await claim.done).result, replayed: true };
  try {
    const result = await work();
    await store.completeEvent(sessionId, eventId, kind, result);
    return { result, replayed: false };
  } catch (e) {
    await store.releaseEvent(sessionId, eventId, e);
    throw e;
  }
}

const key = (a: string, b: string | number, c?: string | number) => (c == null ? `${a}\u0000${b}` : `${a}\u0000${b}\u0000${c}`);

type Pending = { promise: Promise<StoredEvent>; resolve: (e: StoredEvent) => void; reject: (e: unknown) => void };

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SkSession>();
  private events = new Map<string, StoredEvent>();
  private order: StoredEvent[] = [];
  private pending = new Map<string, Pending>();
  private attempts = new Map<string, Attempt>();
  /** Insertion order, so two sessions created in the same millisecond still have a "most recent". */
  private seq = new Map<string, number>();
  private nextSeq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async createSession(s: NewSession): Promise<SkSession> {
    const t = this.now();
    const session: SkSession = { ...s, id: uuidv7(t), createdAt: t, updatedAt: t };
    this.sessions.set(session.id, clone(session));
    this.seq.set(session.id, this.nextSeq++);
    return clone(session);
  }
  async getSession(id: string): Promise<SkSession | null> {
    const s = this.sessions.get(id);
    return s ? clone(s) : null;
  }
  async findSession(studentId: string, productId: string, chapter: number): Promise<SkSession | null> {
    let best: SkSession | null = null;
    for (const s of this.sessions.values()) {
      if (s.studentId !== studentId || s.productId !== productId || s.chapter !== chapter) continue;
      if (!best || s.updatedAt > best.updatedAt || (s.updatedAt === best.updatedAt && (this.seq.get(s.id) ?? 0) > (this.seq.get(best.id) ?? 0))) best = s;
    }
    return best ? clone(best) : null;
  }
  async saveSession(s: SkSession): Promise<void> {
    if (!this.sessions.has(s.id)) throw new Error(`unknown session ${s.id}`);
    this.sessions.set(s.id, clone({ ...s, updatedAt: this.now() }));
    this.seq.set(s.id, this.nextSeq++);
  }

  async claimEvent<T>(sessionId: string, eventId: string): Promise<Claim<T>> {
    const k = key(sessionId, eventId);
    const stored = this.events.get(k);
    if (stored) return { status: "stored", event: stored as StoredEvent<T> };
    const inflight = this.pending.get(k);
    if (inflight) return { status: "inflight", done: inflight.promise as Promise<StoredEvent<T>> };
    let resolve!: Pending["resolve"];
    let reject!: Pending["reject"];
    const promise = new Promise<StoredEvent>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined); // a released claim must not become an unhandled rejection
    this.pending.set(k, { promise, resolve, reject });
    return { status: "new" };
  }
  async completeEvent<T>(sessionId: string, eventId: string, kind: string, result: T): Promise<StoredEvent<T>> {
    const k = key(sessionId, eventId);
    if (this.events.has(k)) throw new Error(`event ${eventId} already stored`);
    const ev: StoredEvent<T> = { sessionId, eventId, kind, result: clone(result), at: this.now() };
    this.events.set(k, ev);
    this.order.push(ev);
    this.pending.get(k)?.resolve(ev);
    this.pending.delete(k);
    return ev;
  }
  async releaseEvent(sessionId: string, eventId: string, error: unknown): Promise<void> {
    const k = key(sessionId, eventId);
    this.pending.get(k)?.reject(error);
    this.pending.delete(k);
  }
  async listEvents(sessionId: string): Promise<StoredEvent[]> {
    return this.order.filter((e) => e.sessionId === sessionId).map((e) => clone(e));
  }

  async getAttempt(sessionId: string, itemId: string, attemptNo: number): Promise<Attempt | null> {
    const a = this.attempts.get(key(sessionId, itemId, attemptNo));
    return a ? clone(a) : null;
  }
  async putAttempt(a: Attempt): Promise<Attempt> {
    const k = key(a.sessionId, a.itemId, a.attemptNo);
    const existing = this.attempts.get(k);
    if (existing) throw new DuplicateAttemptError(clone(existing));
    this.attempts.set(k, clone(a));
    return clone(a);
  }
  async listAttempts(sessionId: string): Promise<Attempt[]> {
    return [...this.attempts.values()].filter((a) => a.sessionId === sessionId).map((a) => clone(a));
  }

  /** Test/ops helper: how many sessions are held. */
  get size(): number {
    return this.sessions.size;
  }
}

/** Stored values are copies: a caller mutating its object must not mutate the store. */
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
