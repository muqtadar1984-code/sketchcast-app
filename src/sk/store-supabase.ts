// SK B5 — the durable SessionStore on Supabase (migration 0157: sk_sessions,
// sk_events, item_attempts, mastery_state). Same contract as the in-memory
// store in ./store.ts, so the loop and the routes do not change:
//
//   * sessions: one OPEN row per student × product × chapter (opening a new
//     one closes the old); the whole machine is stored as jsonb so a resume is
//     exact, with state / phase / cursor / bookmarks / rate denormalised for
//     queries;
//   * events: the claim protocol on the primary key (session_id, event_id).
//     `claimEvent` INSERTS an `inflight` row — a unique violation means the
//     event exists: `stored` → replay its result, `inflight` → wait (poll)
//     for the first run to finish. `completeEvent` fills the row in exactly
//     once; `releaseEvent` deletes the claim so the client's retry can run. A
//     claim older than `staleClaimMs` (a function that died mid-turn) is
//     taken over;
//   * attempts: UNIQUE (session_id, item_id, attempt_no) → DuplicateAttemptError
//     carrying the stored row (code 23505). The row is stamped with the check
//     it belongs to (from the session's open check) and the item's teaching
//     objective, then the objective's `mastery_state` is RECOMPUTED from all
//     of the student's attempts by the rule in ./mastery.ts.
//
// Uses the admin (service-role) client: the tables are not writable from
// `authenticated` (0157). Never imported by client code.

import type { SupabaseClient } from "@supabase/supabase-js";
import { UUID_RE, uuidv7 } from "./ids";
import { MASTERY_RULE_VERSION, masteryFromAttempts, type AttemptRecord, type CheckPurpose, type MasteryOptions, type MasteryStateV1 } from "./mastery";
import { phaseOf, type MachineState, type OpenCheck } from "./state";
import { DuplicateAttemptError, type Attempt, type Claim, type NewSession, type SessionStore, type SkSession, type StoredEvent } from "./store";

// ── The slice of supabase-js this store uses (so a test can fake it) ───────
export type DbError = { code?: string; message: string };
export type DbRow = Record<string, unknown>;
export type DbResult<T> = { data: T | null; error: DbError | null };

export interface SkQuery {
  select(columns?: string): SkQuery;
  insert(row: DbRow): SkQuery;
  update(patch: DbRow): SkQuery;
  upsert(row: DbRow, opts?: { onConflict?: string }): SkQuery;
  delete(): SkQuery;
  eq(column: string, value: unknown): SkQuery;
  order(column: string, opts?: { ascending?: boolean }): SkQuery;
  limit(n: number): SkQuery;
  maybeSingle(): Promise<DbResult<DbRow>>;
  single(): Promise<DbResult<DbRow>>;
  then<R1 = DbResult<DbRow[]>, R2 = never>(onfulfilled?: ((value: DbResult<DbRow[]>) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2>;
}
export interface SkDb {
  from(table: string): SkQuery;
}

/** The real client, narrowed to what the store uses. */
export function skDbFrom(client: SupabaseClient): SkDb {
  return client as unknown as SkDb;
}

const UNIQUE_VIOLATION = "23505";

export type SupabaseStoreOptions = {
  now?: () => number;
  /** How often a waiting duplicate re-reads an in-flight event. */
  pollMs?: number;
  /** How long a waiting duplicate waits before giving up (the client retries). */
  inflightTimeoutMs?: number;
  /** An in-flight claim older than this is abandoned (a dead function) and taken over. */
  staleClaimMs?: number;
  /** Item → teaching objective; default reads `topic_questions.teaching_objective_id`. */
  objectiveForItem?: (itemId: string) => Promise<string | null>;
  mastery?: MasteryOptions;
};

export class SupabaseSessionStore implements SessionStore {
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly inflightTimeoutMs: number;
  private readonly staleClaimMs: number;
  private readonly objectiveForItemFn: (itemId: string) => Promise<string | null>;
  private readonly masteryOpts: MasteryOptions;
  /** The last mastery recompute failure (an attempt is stored even when the derived row could not be). */
  lastMasteryError: unknown = null;

  constructor(
    private readonly db: SkDb,
    opts: SupabaseStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 250;
    this.inflightTimeoutMs = opts.inflightTimeoutMs ?? 30_000;
    this.staleClaimMs = opts.staleClaimMs ?? 120_000;
    this.objectiveForItemFn = opts.objectiveForItem ?? ((itemId) => this.lookupObjective(itemId));
    this.masteryOpts = opts.mastery ?? {};
  }

  // ── sessions ──────────────────────────────────────────────────────────────
  async createSession(s: NewSession): Promise<SkSession> {
    const t = this.now();
    const session: SkSession = { ...s, id: uuidv7(t), createdAt: t, updatedAt: t };
    // One open session per student × product × chapter (0157 partial unique index).
    const closed = await this.db.from("sk_sessions").update({ status: "closed", closed_at: iso(t) }).eq("student_id", s.studentId).eq("product_id", s.productId).eq("chapter", s.chapter).eq("status", "open");
    fail(closed.error, "close previous session");
    const { data, error } = await this.db.from("sk_sessions").insert(toSessionRow(session)).select().single();
    fail(error, "create session");
    return fromSessionRow(data!);
  }

  async getSession(id: string): Promise<SkSession | null> {
    if (!UUID_RE.test(id)) return null;
    const { data, error } = await this.db.from("sk_sessions").select("*").eq("id", id).maybeSingle();
    fail(error, "get session");
    return data ? fromSessionRow(data) : null;
  }

  async findSession(studentId: string, productId: string, chapter: number): Promise<SkSession | null> {
    const { data, error } = await this.db.from("sk_sessions").select("*").eq("student_id", studentId).eq("product_id", productId).eq("chapter", chapter).eq("status", "open").order("updated_at", { ascending: false }).limit(1);
    fail(error, "find session");
    const row = data?.[0];
    return row ? fromSessionRow(row) : null;
  }

  async saveSession(s: SkSession): Promise<void> {
    const t = this.now();
    const row = toSessionRow({ ...s, updatedAt: t });
    // Identity, ownership and status never change through save; the machine and its denormalised columns do.
    const patch: DbRow = { graph_version: row.graph_version, state: row.state, phase: row.phase, cursor: row.cursor, bookmarks: row.bookmarks, rate: row.rate, machine: row.machine, mastery: row.mastery, history: row.history, updated_at: row.updated_at };
    const { data, error } = await this.db.from("sk_sessions").update(patch).eq("id", s.id).select("id");
    fail(error, "save session");
    if (!data || data.length === 0) throw new Error(`unknown session ${s.id}`);
  }

  // ── events: the claim protocol ────────────────────────────────────────────
  async claimEvent<T>(sessionId: string, eventId: string): Promise<Claim<T>> {
    for (let round = 0; round < 3; round++) {
      const t = this.now();
      const ins = await this.db.from("sk_events").insert({ session_id: sessionId, event_id: eventId, status: "inflight", claimed_at: iso(t) });
      if (!ins.error) return { status: "new" };
      if (ins.error.code !== UNIQUE_VIOLATION) fail(ins.error, "claim event");
      const { data: row, error } = await this.db.from("sk_events").select("status, kind, result, at, claimed_at").eq("session_id", sessionId).eq("event_id", eventId).maybeSingle();
      fail(error, "read claim");
      if (!row) continue; // released between our insert and read: claim again
      if (row.status === "stored") return { status: "stored", event: fromEventRow(sessionId, eventId, row) as StoredEvent<T> };
      const claimedAt = Date.parse(String(row.claimed_at));
      if (Number.isFinite(claimedAt) && t - claimedAt > this.staleClaimMs) {
        // A dead run: take the claim over (delete only that exact claim).
        await this.db.from("sk_events").delete().eq("session_id", sessionId).eq("event_id", eventId).eq("status", "inflight").eq("claimed_at", row.claimed_at);
        continue;
      }
      return { status: "inflight", done: this.waitForStored<T>(sessionId, eventId) };
    }
    throw new Error(`could not claim event ${eventId}`);
  }

  private async waitForStored<T>(sessionId: string, eventId: string): Promise<StoredEvent<T>> {
    const deadline = this.now() + this.inflightTimeoutMs;
    for (;;) {
      await sleep(this.pollMs);
      const { data: row, error } = await this.db.from("sk_events").select("status, kind, result, at").eq("session_id", sessionId).eq("event_id", eventId).maybeSingle();
      fail(error, "poll claim");
      if (!row) throw new Error(`event ${eventId} was released by the first run`);
      if (row.status === "stored") return fromEventRow(sessionId, eventId, row) as StoredEvent<T>;
      if (this.now() > deadline) throw new Error(`event ${eventId} is still in flight after ${this.inflightTimeoutMs} ms`);
    }
  }

  async completeEvent<T>(sessionId: string, eventId: string, kind: string, result: T): Promise<StoredEvent<T>> {
    const t = this.now();
    const { data, error } = await this.db.from("sk_events").update({ status: "stored", kind, result: result === undefined ? null : result, at: iso(t) }).eq("session_id", sessionId).eq("event_id", eventId).eq("status", "inflight").select("event_id");
    fail(error, "complete event");
    if (!data || data.length === 0) throw new Error(`event ${eventId} already stored or not claimed`);
    return { sessionId, eventId, kind, result, at: t };
  }

  /** The work failed (the error is the caller's to report): drop the claim. */
  async releaseEvent(sessionId: string, eventId: string): Promise<void> {
    const { error } = await this.db.from("sk_events").delete().eq("session_id", sessionId).eq("event_id", eventId).eq("status", "inflight");
    fail(error, "release event");
  }

  async listEvents(sessionId: string): Promise<StoredEvent[]> {
    const { data, error } = await this.db.from("sk_events").select("event_id, kind, result, at").eq("session_id", sessionId).eq("status", "stored").order("at", { ascending: true });
    fail(error, "list events");
    return (data ?? []).map((r) => fromEventRow(sessionId, String(r.event_id), r));
  }

  // ── attempts ──────────────────────────────────────────────────────────────
  async getAttempt(sessionId: string, itemId: string, attemptNo: number): Promise<Attempt | null> {
    const { data, error } = await this.db.from("item_attempts").select("*").eq("session_id", sessionId).eq("item_id", itemId).eq("attempt_no", attemptNo).maybeSingle();
    fail(error, "get attempt");
    return data ? fromAttemptRow(data) : null;
  }

  async putAttempt(a: Attempt): Promise<Attempt> {
    if (!UUID_RE.test(a.itemId)) throw new Error(`item ${a.itemId} is not a topic_questions id — the Supabase store needs items from the Supabase item bank`);
    const { data: session, error } = await this.db.from("sk_sessions").select("student_id, machine").eq("id", a.sessionId).maybeSingle();
    fail(error, "read session for attempt");
    if (!session) throw new Error(`unknown session ${a.sessionId}`);
    const studentId = String(session.student_id);
    const check = await this.checkContext(a, (session.machine as MachineState | null)?.openCheck ?? null);
    const teachingObjectiveId = a.teachingObjectiveId !== undefined ? a.teachingObjectiveId : await this.objectiveForItemFn(a.itemId);

    const ins = await this.db.from("item_attempts").insert(toAttemptRow(a, studentId, teachingObjectiveId, check)).select().single();
    if (ins.error) {
      if (ins.error.code === UNIQUE_VIOLATION) {
        const existing = (await this.getAttempt(a.sessionId, a.itemId, a.attemptNo)) ?? (await this.attemptByEvent(a.sessionId, a.eventId));
        if (existing) throw new DuplicateAttemptError(existing);
      }
      fail(ins.error, "put attempt");
    }
    const stored = fromAttemptRow(ins.data!);
    if (teachingObjectiveId) {
      try {
        await this.recomputeMastery(studentId, teachingObjectiveId);
      } catch (e) {
        // The attempt is stored (graded once); the derived row catches up on the next recompute.
        this.lastMasteryError = e;
        console.error("[sk store] mastery recompute failed:", (e as Error).message);
      }
    }
    return stored;
  }

  async listAttempts(sessionId: string): Promise<Attempt[]> {
    const { data, error } = await this.db.from("item_attempts").select("*").eq("session_id", sessionId).order("at", { ascending: true });
    fail(error, "list attempts");
    return (data ?? []).map(fromAttemptRow);
  }

  private async attemptByEvent(sessionId: string, eventId: string): Promise<Attempt | null> {
    const { data } = await this.db.from("item_attempts").select("*").eq("session_id", sessionId).eq("event_id", eventId).maybeSingle();
    return data ? fromAttemptRow(data) : null;
  }

  /** Which check this attempt belongs to, from the session's open check: the
   * first attempt on the first item OPENS a check (check_key = its event id);
   * later attempts join the most recent check on that unit and purpose. */
  private async checkContext(a: Attempt, oc: OpenCheck | null): Promise<CheckContext> {
    if (!oc || oc.itemIds[oc.index] !== a.itemId) return { purpose: null, unitKey: null, checkKey: null, checkSize: null };
    const base = { purpose: oc.purpose, unitKey: oc.unitKey, checkSize: oc.itemIds.length };
    if (oc.index === 0 && a.attemptNo === 1) return { ...base, checkKey: a.eventId };
    const { data } = await this.db.from("item_attempts").select("check_key").eq("session_id", a.sessionId).eq("unit_key", oc.unitKey).eq("purpose", oc.purpose).order("at", { ascending: false }).limit(1);
    const prev = data?.[0]?.check_key;
    return { ...base, checkKey: typeof prev === "string" ? prev : a.eventId };
  }

  private async lookupObjective(itemId: string): Promise<string | null> {
    const { data, error } = await this.db.from("topic_questions").select("teaching_objective_id").eq("id", itemId).maybeSingle();
    fail(error, "item objective");
    const v = data?.teaching_objective_id;
    return typeof v === "string" ? v : null;
  }

  // ── mastery (derived) ─────────────────────────────────────────────────────
  /** Recompute one objective's mastery_state from every attempt the student
   * has on it (rule sk-b5.1) and upsert it. Returns the state, or null when
   * the attempts give no evidence (nothing is written then). */
  async recomputeMastery(studentId: string, teachingObjectiveId: string): Promise<MasteryStateV1 | null> {
    const { data, error } = await this.db.from("item_attempts").select("*").eq("student_id", studentId).eq("teaching_objective_id", teachingObjectiveId).order("at", { ascending: true });
    fail(error, "read attempts for mastery");
    const state = masteryFromAttempts(teachingObjectiveId, (data ?? []).map(toAttemptRecord), this.masteryOpts);
    if (!state) return null;
    const up = await this.db.from("mastery_state").upsert(
      { student_id: studentId, teaching_objective_id: teachingObjectiveId, status: state.status, independent: state.independent, evidence: state.evidence, rule_version: MASTERY_RULE_VERSION, updated_at: iso(this.now()) },
      { onConflict: "student_id,teaching_objective_id" },
    );
    fail(up.error, "upsert mastery");
    return state;
  }

  async getMastery(studentId: string, teachingObjectiveId: string): Promise<MasteryStateV1 | null> {
    const { data, error } = await this.db.from("mastery_state").select("*").eq("student_id", studentId).eq("teaching_objective_id", teachingObjectiveId).maybeSingle();
    fail(error, "get mastery");
    return data ? { status: data.status as MasteryStateV1["status"], independent: !!data.independent, evidence: data.evidence as MasteryStateV1["evidence"], rule_version: MASTERY_RULE_VERSION } : null;
  }
}

// ── row mapping ─────────────────────────────────────────────────────────────
type CheckContext = { purpose: CheckPurpose | null; unitKey: string | null; checkKey: string | null; checkSize: number | null };

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (v: unknown) => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : 0;
};
const sleep = (t: number) => new Promise<void>((r) => setTimeout(r, t));

function fail(error: DbError | null | undefined, what: string): void {
  if (error) throw new Error(`[sk store] ${what}: ${error.message}${error.code ? ` (${error.code})` : ""}`);
}

export function toSessionRow(s: SkSession): DbRow {
  const m = s.machine;
  return {
    id: s.id,
    student_id: s.studentId,
    product_id: s.productId,
    chapter: s.chapter,
    graph_version: s.graphVersion,
    status: "open",
    state: m.state,
    phase: phaseOf(m.state),
    cursor: m.cursor,
    bookmarks: m.bookmarks,
    rate: m.rate,
    machine: m,
    mastery: s.mastery,
    history: s.history,
    created_at: iso(s.createdAt),
    updated_at: iso(s.updatedAt),
  };
}

export function fromSessionRow(r: DbRow): SkSession {
  return {
    id: String(r.id),
    studentId: String(r.student_id),
    productId: String(r.product_id),
    chapter: Number(r.chapter),
    graphVersion: Number(r.graph_version),
    machine: r.machine as MachineState,
    mastery: (r.mastery ?? {}) as SkSession["mastery"],
    history: (r.history ?? []) as SkSession["history"],
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
  };
}

function fromEventRow(sessionId: string, eventId: string, r: DbRow): StoredEvent {
  return { sessionId, eventId, kind: String(r.kind ?? ""), result: r.result, at: ms(r.at) };
}

export function toAttemptRow(a: Attempt, studentId: string, teachingObjectiveId: string | null, c: CheckContext): DbRow {
  return {
    event_id: a.eventId,
    session_id: a.sessionId,
    student_id: studentId,
    item_id: a.itemId,
    teaching_objective_id: teachingObjectiveId,
    attempt_no: a.attemptNo,
    response: a.response === undefined ? null : a.response,
    outcome: a.outcome,
    score: a.score,
    max_score: a.max,
    independent: a.independent,
    hint_used: a.hintsUsed > 0,
    hints_used: a.hintsUsed,
    modality: a.modality,
    transcript_confirmed: a.transcriptConfirmed,
    grader: a.grader,
    purpose: c.purpose,
    unit_key: c.unitKey,
    check_key: c.checkKey,
    check_size: c.checkSize,
    rule_version: a.ruleVersion,
    at: iso(a.gradedAt),
  };
}

export function fromAttemptRow(r: DbRow): Attempt {
  return {
    sessionId: String(r.session_id),
    eventId: String(r.event_id),
    itemId: String(r.item_id),
    attemptNo: Number(r.attempt_no),
    response: r.response,
    modality: r.modality as Attempt["modality"],
    transcriptConfirmed: !!r.transcript_confirmed,
    outcome: r.outcome as Attempt["outcome"],
    score: Number(r.score),
    max: Number(r.max_score),
    hintsUsed: Number(r.hints_used ?? 0),
    independent: !!r.independent,
    grader: r.grader as Attempt["grader"],
    ruleVersion: String(r.rule_version),
    gradedAt: ms(r.at),
    teachingObjectiveId: typeof r.teaching_objective_id === "string" ? r.teaching_objective_id : null,
  };
}

/** An item_attempts row as the mastery rule reads it. */
export function toAttemptRecord(r: DbRow): AttemptRecord {
  return {
    id: String(r.event_id),
    itemId: String(r.item_id),
    teachingObjectiveId: typeof r.teaching_objective_id === "string" ? r.teaching_objective_id : null,
    attemptNo: Number(r.attempt_no),
    outcome: r.outcome as AttemptRecord["outcome"],
    independent: !!r.independent,
    hintsUsed: Number(r.hints_used ?? 0),
    grader: (r.grader ?? "deterministic") as AttemptRecord["grader"],
    checkKey: typeof r.check_key === "string" ? r.check_key : null,
    purpose: (r.purpose ?? null) as AttemptRecord["purpose"],
    checkSize: r.check_size == null ? null : Number(r.check_size),
    at: ms(r.at),
  };
}
