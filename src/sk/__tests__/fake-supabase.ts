// SK B5 tests — a small in-memory fake of the supabase-js query builder (the
// slice SkDb declares): from → select / insert / update / upsert / delete,
// eq / order / limit, maybeSingle / single / await. Tables declare their
// unique keys so a duplicate fails with Postgres's 23505, which is the one
// behaviour the store's claim protocol and DuplicateAttemptError depend on.
// No network, no timers of its own.
import type { DbResult, DbRow, SkDb, SkQuery } from "../store-supabase";

export type TableSpec = {
  /** Unique keys; a `where` makes it a partial index (0157's one-open-session). */
  unique?: { cols: string[]; where?: (r: DbRow) => boolean }[];
  /** Column defaults applied on insert (e.g. ids and timestamps). */
  defaults?: (r: DbRow) => DbRow;
};

type Op = "select" | "insert" | "update" | "upsert" | "delete";
type Filter = { col: string; value: unknown };

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

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
  seed(table: string, rows: DbRow[]): void {
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows.map(clone)]);
  }
  rows(table: string): DbRow[] {
    return clone(this.tables.get(table) ?? []);
  }
  from(table: string): SkQuery {
    return new FakeQuery(this, table, this.tables.get(table) ?? this.create(table), this.specs[table] ?? {});
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
    this.filters.push({ col, value });
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

  private matches(r: DbRow): boolean {
    return this.filters.every((f) => String(r[f.col] ?? "\u0000null") === String(f.value ?? "\u0000null"));
  }
  private violation(candidate: DbRow, except?: DbRow): string | null {
    for (const u of this.spec.unique ?? []) {
      if (u.where && !u.where(candidate)) continue;
      for (const r of this.rows) {
        if (r === except) continue;
        if (u.where && !u.where(r)) continue;
        if (u.cols.every((c) => String(r[c]) === String(candidate[c]))) return `duplicate key value violates unique constraint "${this.table}_${u.cols.join("_")}_key"`;
      }
    }
    return null;
  }
  private async exec(): Promise<DbResult<DbRow[]>> {
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
        const row = { ...(this.spec.defaults?.(this.payload!) ?? {}), ...clone(this.payload!) };
        const v = this.violation(row);
        if (v) return { data: null, error: { code: "23505", message: v } };
        this.rows.push(row);
        return { data: [clone(row)], error: null };
      }
      case "upsert": {
        const row = { ...(this.spec.defaults?.(this.payload!) ?? {}), ...clone(this.payload!) };
        const existing = this.rows.find((r) => this.onConflict.length > 0 && this.onConflict.every((c) => String(r[c]) === String(row[c])));
        if (existing) {
          Object.assign(existing, row);
          return { data: [clone(existing)], error: null };
        }
        const v = this.violation(row);
        if (v) return { data: null, error: { code: "23505", message: v } };
        this.rows.push(row);
        return { data: [clone(row)], error: null };
      }
      case "update": {
        const hit = this.rows.filter((r) => this.matches(r));
        for (const r of hit) {
          const next = { ...r, ...clone(this.payload!) };
          const v = this.violation(next, r);
          if (v) return { data: null, error: { code: "23505", message: v } };
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

/** The 0157 tables with their unique keys, plus the two 0156 tables the item
 * bank reads, for a store/bank test. */
export function skFakeDb(now: () => number = () => Date.now()): FakeDb {
  const db: FakeDb = new FakeDb(
    {
      sk_sessions: { unique: [{ cols: ["id"] }, { cols: ["student_id", "product_id", "chapter"], where: (r) => r.status === "open" }] },
      sk_events: { unique: [{ cols: ["session_id", "event_id"] }], defaults: () => ({ status: "inflight", result: null, kind: null, at: null }) },
      item_attempts: {
        unique: [{ cols: ["session_id", "item_id", "attempt_no"] }, { cols: ["session_id", "event_id"] }],
        defaults: (): DbRow => ({ id: `att-${Math.random().toString(36).slice(2, 10)}`, at: db.stamp() }),
      },
      mastery_state: { unique: [{ cols: ["student_id", "teaching_objective_id"] }] },
      topic_questions: { unique: [{ cols: ["id"] }] },
      teaching_objectives: { unique: [{ cols: ["id"] }, { cols: ["product_id", "chapter", "unit_key"] }] },
      sk_book_products: { unique: [{ cols: ["id"] }, { cols: ["slug"] }] },
    },
    now,
  );
  return db;
}
