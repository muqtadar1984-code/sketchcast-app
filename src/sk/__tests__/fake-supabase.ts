// SK B5 tests — a small in-memory fake of the supabase-js query builder (the
// slice SkDb declares): from → select / insert / update / upsert / delete,
// eq / in / order / limit, maybeSingle / single / await. No network, no timers
// of its own.
//
// Since 2026-10-27 the fake also knows the SCHEMA of the tables the loop
// writes (migrations 0156/0157): column types, NOT NULL, CHECK constraints,
// unique keys and foreign keys. Five production defects in a row were
// contracts the in-memory store satisfied and the real tables did not —
// `graph_version >= 1`, a scope key in a uuid column (22P02), string item ids
// against a uuid FK, string objective ids — and every one of them passed the
// fake because it accepted any value in any column. It now refuses what
// Postgres refuses, with the same SQLSTATE codes, in the order Postgres
// raises them:
//
//   42703 / PGRST204  unknown column (filter / payload) on a strict table
//   22P02 / 22007     a value the column type cannot take (also in a filter)
//   23502             NOT NULL
//   23514             CHECK (per column, and row-level)
//   23505             UNIQUE (incl. partial indexes)
//   23503             FOREIGN KEY
//
// `seed()` bypasses all of it: fixtures are the test's own statement about
// the database and may be partial rows.
import type { DbResult, DbRow, SkDb, SkQuery } from "../store-supabase";
import { uuidv7 } from "../ids";

export type ColumnType = "uuid" | "int" | "numeric" | "bool" | "text" | "jsonb" | "timestamptz";

export type ColumnSpec = {
  type: ColumnType;
  notNull?: boolean;
  /** Applied when the payload has no such key (an explicit null is a NULL). */
  default?: () => unknown;
  /** CHECK (col in (...)). */
  in?: readonly string[];
  /** Any other single-column CHECK; skipped on NULL like SQL. */
  check?: (v: unknown) => boolean;
  /** FOREIGN KEY: a row of `table` must have `column` (default "id") equal to the value. */
  references?: { table: string; column?: string };
};

export type TableSpec = {
  /** Unique keys; a `where` makes it a partial index (0157's one-open-session). */
  unique?: { cols: string[]; where?: (r: DbRow) => boolean }[];
  /** Column defaults applied on insert (e.g. ids and timestamps). Prefer `columns[x].default`. */
  defaults?: (r: DbRow) => DbRow;
  /** Column types and constraints. */
  columns?: Record<string, ColumnSpec>;
  /** With `columns`, a column outside the list is an error (production's schema cache). */
  strictColumns?: boolean;
  /** Row-level CHECK constraints by name, run on the full row (after defaults). */
  checks?: Record<string, (r: DbRow) => boolean>;
};

type Op = "select" | "insert" | "update" | "upsert" | "delete";
type Filter = { col: string; op: "eq" | "in"; value: unknown };
type Violation = { code: string; message: string };

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Postgres's uuid input: 32 hex digits, hyphenated in the standard groups or
 * bare. Any version nibble — unlike the app's UUID_RE, which insists on
 * 1–8, the TYPE does not care. */
export const PG_UUID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/** Does `v` pass the column type's input function? (null is handled by NOT NULL, not here.) */
export function typeAccepts(type: ColumnType, v: unknown): boolean {
  switch (type) {
    case "uuid":
      return typeof v === "string" && PG_UUID_RE.test(v);
    case "int":
      return (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v));
    case "numeric":
      return (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
    case "bool":
      return typeof v === "boolean" || (typeof v === "string" && /^(t|f|true|false|yes|no|on|off|1|0)$/i.test(v.trim()));
    case "timestamptz":
      return typeof v === "string" && Number.isFinite(Date.parse(v));
    case "text":
      return typeof v !== "object"; // json scalars take the text input function; an object would not
    case "jsonb":
      return true;
  }
}

const typeError = (type: ColumnType, v: unknown): Violation =>
  type === "timestamptz" ? { code: "22007", message: `invalid input syntax for type timestamp with time zone: "${String(v)}"` } : { code: "22P02", message: `invalid input syntax for type ${type === "int" ? "integer" : type === "bool" ? "boolean" : type}: "${typeof v === "object" ? JSON.stringify(v) : String(v)}"` };

export class FakeDb implements SkDb {
  private readonly tables = new Map<string, DbRow[]>();
  private tick = 0;
  constructor(
    private readonly specs: Record<string, TableSpec> = {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A monotonic timestamp for row defaults (two inserts in one ms still order). */
  stamp(): string {
    return new Date(this.now() + this.tick++ / 1000).toISOString();
  }
  /** Fixtures: rows go in as given, no constraint is checked. */
  seed(table: string, rows: DbRow[]): void {
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows.map(clone)]);
  }
  rows(table: string): DbRow[] {
    return clone(this.tables.get(table) ?? []);
  }
  /** The live rows of a table (for a foreign key to look at). */
  live(table: string): DbRow[] {
    return this.tables.get(table) ?? this.create(table);
  }
  spec(table: string): TableSpec {
    return this.specs[table] ?? {};
  }
  from(table: string): SkQuery {
    return new FakeQuery(this, table, this.live(table), this.spec(table));
  }
  private create(table: string): DbRow[] {
    const rows: DbRow[] = [];
    this.tables.set(table, rows);
    return rows;
  }
}

class FakeQuery implements SkQuery {
  private op: Op = "select";
  private payload: DbRow | null = null;
  private onConflict: string[] = [];
  private filters: Filter[] = [];
  private ordering: { col: string; asc: boolean } | null = null;
  private max: number | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
    private readonly rows: DbRow[],
    private readonly spec: TableSpec,
  ) {}

  select(): SkQuery {
    return this;
  }
  insert(row: DbRow): SkQuery {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(patch: DbRow): SkQuery {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  upsert(row: DbRow, opts?: { onConflict?: string }): SkQuery {
    this.op = "upsert";
    this.payload = row;
    this.onConflict = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return this;
  }
  delete(): SkQuery {
    this.op = "delete";
    return this;
  }
  eq(col: string, value: unknown): SkQuery {
    this.filters.push({ col, op: "eq", value });
    return this;
  }
  in(col: string, values: readonly unknown[]): SkQuery {
    this.filters.push({ col, op: "in", value: [...values] });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): SkQuery {
    this.ordering = { col, asc: opts?.ascending ?? true };
    return this;
  }
  limit(n: number): SkQuery {
    this.max = n;
    return this;
  }
  async maybeSingle(): Promise<DbResult<DbRow>> {
    const r = await this.exec();
    if (r.error) return { data: null, error: r.error };
    return { data: r.data?.[0] ?? null, error: null };
  }
  async single(): Promise<DbResult<DbRow>> {
    const r = await this.exec();
    if (r.error) return { data: null, error: r.error };
    const row = r.data?.[0];
    return row ? { data: row, error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
  }
  then<R1 = DbResult<DbRow[]>, R2 = never>(onfulfilled?: ((value: DbResult<DbRow[]>) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  // ── filters ───────────────────────────────────────────────────────────────
  private static same(a: unknown, b: unknown): boolean {
    return String(a ?? "\u0000null") === String(b ?? "\u0000null");
  }
  private matches(r: DbRow): boolean {
    return this.filters.every((f) => (f.op === "eq" ? FakeQuery.same(r[f.col], f.value) : (f.value as unknown[]).some((v) => FakeQuery.same(r[f.col], v))));
  }
  /** A filter is a typed comparison: `student_id = 'stu'` is a 22P02 in Postgres. */
  private filterViolation(): Violation | null {
    const cols = this.spec.columns;
    if (!cols) return null;
    for (const f of this.filters) {
      const c = cols[f.col];
      if (!c) {
        if (this.spec.strictColumns) return { code: "42703", message: `column ${this.table}.${f.col} does not exist` };
        continue;
      }
      for (const v of f.op === "in" ? (f.value as unknown[]) : [f.value]) if (v != null && !typeAccepts(c.type, v)) return typeError(c.type, v);
    }
    return null;
  }

  // ── constraints ───────────────────────────────────────────────────────────
  private unknownColumn(payload: DbRow): Violation | null {
    if (!this.spec.columns || !this.spec.strictColumns) return null;
    for (const k of Object.keys(payload)) if (!(k in this.spec.columns)) return { code: "PGRST204", message: `Could not find the '${k}' column of '${this.table}' in the schema cache` };
    return null;
  }
  /** Column types on the values this statement supplies. */
  private typeViolation(payload: DbRow): Violation | null {
    const cols = this.spec.columns;
    if (!cols) return null;
    for (const [k, v] of Object.entries(payload)) {
      const c = cols[k];
      if (c && v != null && !typeAccepts(c.type, v)) return typeError(c.type, v);
    }
    return null;
  }
  /** NOT NULL, CHECK and FOREIGN KEY on the row as it would be stored. */
  private rowViolation(row: DbRow, payload: DbRow): Violation | null {
    const cols = this.spec.columns ?? {};
    for (const [k, c] of Object.entries(cols)) {
      const v = row[k];
      // An explicit null, or no value and no default: NULL.
      if (c.notNull && (v === null || v === undefined) && (k in payload || !c.default)) return { code: "23502", message: `null value in column "${k}" of relation "${this.table}" violates not-null constraint` };
    }
    for (const [k, c] of Object.entries(cols)) {
      const v = row[k];
      if (v == null) continue;
      if (c.in && !c.in.includes(String(v))) return { code: "23514", message: `new row for relation "${this.table}" violates check constraint "${this.table}_${k}_check"` };
      if (c.check && !c.check(v)) return { code: "23514", message: `new row for relation "${this.table}" violates check constraint "${this.table}_${k}_check"` };
    }
    for (const [name, pred] of Object.entries(this.spec.checks ?? {})) if (!pred(row)) return { code: "23514", message: `new row for relation "${this.table}" violates check constraint "${name}"` };
    return null;
  }
  private fkViolation(row: DbRow): Violation | null {
    for (const [k, c] of Object.entries(this.spec.columns ?? {})) {
      const v = row[k];
      if (v == null || !c.references) continue;
      const col = c.references.column ?? "id";
      if (!this.db.live(c.references.table).some((r) => FakeQuery.same(r[col], v))) return { code: "23503", message: `insert or update on table "${this.table}" violates foreign key constraint "${this.table}_${k}_fkey": Key (${k})=(${String(v)}) is not present in table "${c.references.table}"` };
    }
    return null;
  }
  private uniqueViolation(candidate: DbRow, except?: DbRow): Violation | null {
    for (const u of this.spec.unique ?? []) {
      if (u.where && !u.where(candidate)) continue;
      for (const r of this.rows) {
        if (r === except) continue;
        if (u.where && !u.where(r)) continue;
        if (u.cols.every((c) => String(r[c]) === String(candidate[c]))) return { code: "23505", message: `duplicate key value violates unique constraint "${this.table}_${u.cols.join("_")}_key"` };
      }
    }
    return null;
  }
  /** Postgres's order: column types, NOT NULL, CHECK, UNIQUE, then the FK triggers. */
  private writeViolation(row: DbRow, payload: DbRow, except?: DbRow): Violation | null {
    return this.unknownColumn(payload) ?? this.typeViolation(payload) ?? this.rowViolation(row, payload) ?? this.uniqueViolation(row, except) ?? this.fkViolation(row);
  }
  private withDefaults(payload: DbRow): DbRow {
    const row: DbRow = { ...(this.spec.defaults?.(payload) ?? {}) };
    for (const [k, c] of Object.entries(this.spec.columns ?? {})) if (c.default && !(k in payload) && !(k in row)) row[k] = c.default();
    return { ...row, ...clone(payload) };
  }

  private async exec(): Promise<DbResult<DbRow[]>> {
    const fv = this.filterViolation();
    if (fv) return { data: null, error: fv };
    switch (this.op) {
      case "select": {
        let out = this.rows.filter((r) => this.matches(r));
        if (this.ordering) {
          const { col, asc } = this.ordering;
          out = [...out].sort((a, b) => {
            const x = a[col] as string | number;
            const y = b[col] as string | number;
            return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
          });
        }
        if (this.max != null) out = out.slice(0, this.max);
        return { data: clone(out), error: null };
      }
      case "insert": {
        const row = this.withDefaults(this.payload!);
        const v = this.writeViolation(row, this.payload!);
        if (v) return { data: null, error: v };
        this.rows.push(row);
        return { data: [clone(row)], error: null };
      }
      case "upsert": {
        const row = this.withDefaults(this.payload!);
        const existing = this.rows.find((r) => this.onConflict.length > 0 && this.onConflict.every((c) => String(r[c]) === String(row[c])));
        if (existing) {
          const next = { ...existing, ...clone(this.payload!) };
          const v = this.writeViolation(next, this.payload!, existing);
          if (v) return { data: null, error: v };
          Object.assign(existing, next);
          return { data: [clone(existing)], error: null };
        }
        const v = this.writeViolation(row, this.payload!);
        if (v) return { data: null, error: v };
        this.rows.push(row);
        return { data: [clone(row)], error: null };
      }
      case "update": {
        const hit = this.rows.filter((r) => this.matches(r));
        for (const r of hit) {
          const v = this.writeViolation({ ...r, ...clone(this.payload!) }, this.payload!, r);
          if (v) return { data: null, error: v };
        }
        // An UPDATE that touches no row still has its payload parsed (types, unknown columns).
        if (!hit.length) {
          const v = this.unknownColumn(this.payload!) ?? this.typeViolation(this.payload!);
          if (v) return { data: null, error: v };
        }
        for (const r of hit) Object.assign(r, clone(this.payload!));
        return { data: clone(hit), error: null };
      }
      case "delete": {
        const hit = this.rows.filter((r) => this.matches(r));
        for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
        return { data: clone(hit), error: null };
      }
    }
  }
}

// ── The SK schema, as the migrations declare it ─────────────────────────────
const col = (type: ColumnType, extra: Omit<ColumnSpec, "type"> = {}): ColumnSpec => ({ type, ...extra });
const req = (type: ColumnType, extra: Omit<ColumnSpec, "type"> = {}): ColumnSpec => ({ type, notNull: true, ...extra });
const gte = (n: number) => (v: unknown) => Number(v) >= n;
const bool = (v: unknown) => v === true || v === "true" || v === "t";

export const GRANT_SOURCES = ["code", "promo", "staff", "renewal", "purchase", "edition_code"] as const;

/** The four 0157 tables (+ 0170's objective_key and sk_objective_mastery) with every column, CHECK, unique key and FK; the 0156
 * tables the bank reads (typed where the loop's writes point at them);
 * `profiles` (+ school_id), which sk_sessions / item_attempts / mastery_state
 * reference; and the B8 access tables — `entitlements` (0022), and
 * `book_access_grants` + `sk_usage` (0158, grants as 0159 left them). Seed a
 * profiles row for every student a test opens a session for. */
export function skFakeDb(now: () => number = () => Date.now()): FakeDb {
  const db: FakeDb = new FakeDb(
    {
      schools: { unique: [{ cols: ["id"] }], columns: { id: req("uuid") } },
      profiles: { unique: [{ cols: ["id"] }], columns: { id: req("uuid"), school_id: col("uuid", { references: { table: "schools" } }) } },

      // 0022: the plan rows utils/stripe/entitlements.ts reads (a user's own; a school's under school_id)
      entitlements: {
        unique: [{ cols: ["id"] }, { cols: ["user_id", "plan_key"] }],
        strictColumns: true,
        columns: {
          id: req("uuid", { default: () => uuidv7(now()) }),
          school_id: col("uuid", { references: { table: "schools" } }),
          user_id: req("uuid", { references: { table: "profiles" } }),
          active: req("bool", { default: () => false }),
          plan_key: req("text"),
          status: col("text"),
          current_period_end: col("timestamptz"),
          updated_at: req("timestamptz", { default: () => db.stamp() }),
        },
      },

      // 0158 §grants, as 0159 left them: expires_at nullable (book access permanent), tutor_expires_at the tutoring window.
      // product_id is a bare uuid (no FK) — a slug in a filter here is the 22P02 B8 guards against.
      book_access_grants: {
        unique: [{ cols: ["id"] }],
        strictColumns: true,
        columns: {
          id: req("uuid", { default: () => uuidv7(now()) }),
          user_id: req("uuid", { references: { table: "profiles" } }),
          product_id: req("uuid"),
          source: req("text", { in: GRANT_SOURCES }),
          code_id: col("uuid"),
          publisher_id: col("uuid"),
          batch_id: col("uuid"),
          activated_at: req("timestamptz", { default: () => db.stamp() }),
          expires_at: col("timestamptz"),
          revoked_at: col("timestamptz"),
          renewal_of: col("uuid"),
          usage_allowance: col("jsonb"),
          granted_by: col("uuid"),
          created_at: req("timestamptz", { default: () => db.stamp() }),
          tutor_expires_at: col("timestamptz"),
          edition_code_id: col("uuid"),
        },
      },
      // 0158 §usage: PRIMARY KEY (user_id, product_id, period) — the B8 upsert key
      sk_usage: {
        unique: [{ cols: ["user_id", "product_id", "period"] }],
        strictColumns: true,
        columns: {
          user_id: req("uuid", { references: { table: "profiles" } }),
          product_id: req("uuid"),
          period: req("text"),
          live_turns: req("int", { default: () => 0 }),
          generated_segments: req("int", { default: () => 0 }),
          interactive_ms: req("int", { default: () => 0 }),
          updated_at: req("timestamptz", { default: () => db.stamp() }),
        },
      },

      // 0156
      sk_book_products: { unique: [{ cols: ["id"] }, { cols: ["slug"] }], columns: { id: req("uuid", { default: () => uuidv7(now()) }), slug: req("text"), status: col("text", { in: ["draft", "approved", "retired"] }) } },
      sk_book_units: {
        unique: [{ cols: ["id"] }, { cols: ["product_id", "chapter", "unit_key"] }, { cols: ["product_id", "chapter", "section_sid"] }],
        columns: { id: req("uuid", { default: () => uuidv7(now()) }), product_id: req("uuid", { references: { table: "sk_book_products" } }), chapter: req("int", { check: gte(1) }), unit_key: req("text"), section_sid: req("text") },
      },
      teaching_objectives: {
        unique: [{ cols: ["id"] }, { cols: ["product_id", "chapter", "unit_key"] }],
        columns: { id: req("uuid", { default: () => uuidv7(now()) }), product_id: req("uuid", { references: { table: "sk_book_products" } }), chapter: req("int", { check: gte(1) }), unit_key: req("text"), status: col("text", { in: ["draft", "validated"] }) },
      },
      topic_questions: {
        unique: [{ cols: ["id"] }],
        columns: { id: req("uuid", { default: () => uuidv7(now()) }), teaching_objective_id: col("uuid", { references: { table: "teaching_objectives" } }), status: col("text", { in: ["draft", "approved", "rejected", "retired"] }) },
      },

      // 0157 §1 sessions
      sk_sessions: {
        unique: [{ cols: ["id"] }, { cols: ["student_id", "product_id", "chapter"], where: (r) => r.status === "open" }],
        strictColumns: true,
        columns: {
          id: req("uuid"),
          student_id: req("uuid", { references: { table: "profiles" } }),
          product_id: req("text"),
          chapter: req("int", { check: gte(1) }),
          graph_version: req("int", { default: () => 1, check: gte(1) }),
          status: req("text", { default: () => "open", in: ["open", "closed"] }),
          state: req("text"),
          phase: req("text", { in: ["GUIDE", "TEACH", "ASSESS"] }),
          cursor: req("jsonb", { default: () => ({}) }),
          bookmarks: req("jsonb", { default: () => [] }),
          rate: req("numeric", { default: () => 1, check: (v) => Number(v) > 0 }),
          machine: req("jsonb"),
          mastery: req("jsonb", { default: () => ({}) }),
          history: req("jsonb", { default: () => [] }),
          created_at: req("timestamptz", { default: () => db.stamp() }),
          updated_at: req("timestamptz", { default: () => db.stamp() }),
          closed_at: col("timestamptz"),
        },
      },
      // 0157 §2 events: PRIMARY KEY (session_id, event_id) is the replay guard
      sk_events: {
        unique: [{ cols: ["session_id", "event_id"] }],
        strictColumns: true,
        columns: {
          session_id: req("uuid", { references: { table: "sk_sessions" } }),
          event_id: req("uuid"),
          status: req("text", { default: () => "inflight", in: ["inflight", "stored"] }),
          kind: col("text"),
          // `not null default 'null'::jsonb`: the default is a jsonb null (JS null here); an explicit null in a payload is SQL NULL.
          result: req("jsonb", { default: () => null }),
          claimed_at: req("timestamptz", { default: () => db.stamp() }),
          at: col("timestamptz"),
        },
        checks: { sk_events_check: (r) => r.status === "inflight" || (r.kind != null && r.at != null) },
      },
      // 0157 §3 attempts: graded once per item × attempt
      item_attempts: {
        unique: [{ cols: ["id"] }, { cols: ["session_id", "item_id", "attempt_no"] }, { cols: ["session_id", "event_id"] }],
        strictColumns: true,
        columns: {
          id: req("uuid", { default: () => uuidv7(now()) }),
          event_id: req("uuid"),
          session_id: req("uuid", { references: { table: "sk_sessions" } }),
          student_id: req("uuid", { references: { table: "profiles" } }),
          item_id: req("uuid", { references: { table: "topic_questions" } }),
          teaching_objective_id: col("uuid", { references: { table: "teaching_objectives" } }),
          // 0170: the kit item's article objective, "<article_id>:<objective_ref>"
          objective_key: col("text"),
          attempt_no: req("int", { check: gte(1) }),
          response: col("jsonb"),
          outcome: req("text", { in: ["correct", "partial", "incorrect", "needs_review"] }),
          score: req("numeric", { default: () => 0, check: gte(0) }),
          max_score: req("numeric", { default: () => 1, check: gte(0) }),
          independent: req("bool", { default: () => false }),
          hint_used: req("bool", { default: () => false }),
          hints_used: req("int", { default: () => 0, check: gte(0) }),
          modality: req("text", { in: ["typed", "spoken"] }),
          transcript_confirmed: req("bool", { default: () => false }),
          grader: req("text", { default: () => "deterministic", in: ["deterministic", "llm", "teacher"] }),
          purpose: col("text", { in: ["skip", "prereq", "unit", "practise"] }),
          unit_key: col("text"),
          check_key: col("uuid"),
          check_size: col("int", { check: gte(1) }),
          rule_version: req("text"),
          at: req("timestamptz", { default: () => db.stamp() }),
        },
        checks: {
          // independent evidence = attempt 1, no hint, auto-marked correct
          item_attempts_independent_check: (r) => !bool(r.independent) || (Number(r.attempt_no) === 1 && !bool(r.hint_used) && Number(r.hints_used) === 0 && r.outcome === "correct" && r.grader === "deterministic"),
          item_attempts_hint_used_check: (r) => bool(r.hint_used) === Number(r.hints_used) > 0,
          // a spoken answer is graded only after the student confirmed the transcript
          item_attempts_transcript_check: (r) => r.modality === "typed" || bool(r.transcript_confirmed),
        },
      },
      // 0157 §4 mastery (derived)
      mastery_state: {
        unique: [{ cols: ["student_id", "teaching_objective_id"] }],
        strictColumns: true,
        columns: {
          student_id: req("uuid", { references: { table: "profiles" } }),
          teaching_objective_id: req("uuid", { references: { table: "teaching_objectives" } }),
          status: req("text", { in: ["unknown", "in_progress", "mastered", "provisional", "needs_work"] }),
          independent: req("bool", { default: () => false }),
          evidence: req("jsonb", { default: () => ({}) }),
          rule_version: req("text"),
          updated_at: req("timestamptz", { default: () => db.stamp() }),
        },
        checks: { mastery_state_independent_check: (r) => !bool(r.independent) || r.status === "mastered" },
      },
      // 0170: mastery per KIT (article) objective, same shape and rules as mastery_state
      sk_objective_mastery: {
        unique: [{ cols: ["student_id", "objective_key"] }],
        strictColumns: true,
        columns: {
          student_id: req("uuid", { references: { table: "profiles" } }),
          objective_key: req("text", { check: (v) => /^[0-9a-f-]{36}:.+$/.test(String(v)) }),
          status: req("text", { in: ["unknown", "in_progress", "mastered", "provisional", "needs_work"] }),
          independent: req("bool", { default: () => false }),
          evidence: req("jsonb", { default: () => ({}) }),
          rule_version: req("text"),
          updated_at: req("timestamptz", { default: () => db.stamp() }),
        },
        checks: { sk_objective_mastery_independent_check: (r) => !bool(r.independent) || r.status === "mastered" },
      },
    },
    now,
  );
  return db;
}
