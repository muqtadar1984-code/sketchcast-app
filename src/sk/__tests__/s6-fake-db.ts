// SK S6 tests — a tiny in-memory stand-in for the supabase-js builder the S6
// modules use (consent.ts, facts.ts, memory-delete.ts, memory-sweep.ts):
// from → select / insert / upsert / update / delete (+ .select() after a
// mutation, returning the touched rows), eq / in / gt, order, limit,
// maybeSingle, await; rpc(fn, args) through handlers. It records every call
// (`log`) so a test can assert WHICH client touched WHICH table. `fail` makes
// one table answer with an error. No schema checks: the 0173 lint and the
// production dry run hold the database's side.

type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "in" | "gt"; value: unknown };
type Op = "select" | "insert" | "upsert" | "update" | "delete";

export type Call = { table: string; op: Op; filters: Filter[]; payload?: unknown };

export class S6Db {
  tables: Record<string, Row[]> = {};
  log: Call[] = [];
  rpcs: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string } | null }> = {};
  fail = new Set<string>();

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables[t] = rows.map((r) => ({ ...r }));
  }

  rows(t: string): Row[] {
    return (this.tables[t] ??= []);
  }

  from(table: string): Builder {
    return new Builder(this, table);
  }

  async rpc(fn: string, args: Record<string, unknown> = {}) {
    this.log.push({ table: `rpc:${fn}`, op: "select", filters: [], payload: args });
    const h = this.rpcs[fn];
    if (!h) return { data: null, error: { code: "PGRST202", message: `function ${fn} not found` } };
    return { error: null, ...h(args) };
  }

  touched(table: string, op?: Op): Call[] {
    return this.log.filter((c) => c.table === table && (!op || c.op === op));
  }
}

class Builder implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private op: Op = "select";
  private filters: Filter[] = [];
  private payload: unknown;
  private onConflict: string[] = [];
  private returning = false;
  private single = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max = Infinity;

  constructor(
    private readonly db: S6Db,
    private readonly table: string,
  ) {}

  select() {
    if (this.op === "select") return this;
    this.returning = true;
    return this;
  }
  insert(row: Row | Row[]) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  upsert(row: Row, opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = row;
    this.onConflict = (opts?.onConflict ?? "id").split(",").map((s) => s.trim());
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push({ col, op: "eq", value });
    return this;
  }
  in(col: string, value: unknown[]) {
    this.filters.push({ col, op: "in", value });
    return this;
  }
  gt(col: string, value: unknown) {
    this.filters.push({ col, op: "gt", value });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private match(r: Row): boolean {
    return this.filters.every((f) =>
      f.op === "eq" ? r[f.col] === f.value : f.op === "in" ? (f.value as unknown[]).includes(r[f.col]) : String(r[f.col] ?? "") > String(f.value),
    );
  }

  private run(): { data: unknown; error: { message: string } | null } {
    this.db.log.push({ table: this.table, op: this.op, filters: this.filters, payload: this.payload });
    if (this.db.fail.has(this.table)) return { data: null, error: { message: `${this.table} failed` } };
    const rows = this.db.rows(this.table);
    switch (this.op) {
      case "select": {
        let out = rows.filter((r) => this.match(r));
        if (this.orderBy) {
          const { col, asc } = this.orderBy;
          out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        out = out.slice(0, this.max).map((r) => ({ ...r }));
        return { data: this.single ? (out[0] ?? null) : out, error: null };
      }
      case "insert": {
        const add = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        for (const r of add) rows.push({ id: `row-${rows.length + 1}`, ...r });
        return { data: this.returning ? add : null, error: null };
      }
      case "upsert": {
        const r = this.payload as Row;
        const hit = rows.find((x) => this.onConflict.every((c) => x[c] === r[c]));
        if (hit) Object.assign(hit, r);
        else rows.push({ id: `row-${rows.length + 1}`, ...r });
        return { data: null, error: null };
      }
      case "update": {
        const hit = rows.filter((r) => this.match(r));
        for (const r of hit) Object.assign(r, this.payload as Row);
        return { data: this.returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      case "delete": {
        const gone = rows.filter((r) => this.match(r));
        this.db.tables[this.table] = rows.filter((r) => !this.match(r));
        return { data: this.returning ? gone : null, error: null };
      }
    }
  }

  then<A = { data: unknown; error: { message: string } | null }, B = never>(
    ok?: ((v: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}

export const PARENT = "11111111-1111-4111-8111-111111111111";
export const CHILD = "22222222-2222-4222-8222-222222222222";
export const OTHER_PARENT = "33333333-3333-4333-8333-333333333333";
export const SCHOOL_CHILD = "44444444-4444-4444-8444-444444444444";
export const TEACHER = "55555555-5555-4555-8555-555555555555";
export const SCHOOL = "66666666-6666-4666-8666-666666666666";
export const UNLINKED_CHILD = "77777777-7777-4777-8777-777777777777";

/** A small world: one home learner (CHILD) with a verified parent, one
 *  school learner, an unlinked child, a teacher. No consents yet. */
export function s6World(over: { switchOn?: boolean } = {}): S6Db {
  return new S6Db({
    profiles: [
      { id: PARENT, role: "parent", school_id: null },
      { id: CHILD, role: "student", school_id: null },
      { id: OTHER_PARENT, role: "parent", school_id: null },
      { id: SCHOOL_CHILD, role: "student", school_id: SCHOOL },
      { id: TEACHER, role: "teacher", school_id: SCHOOL },
      { id: UNLINKED_CHILD, role: "student", school_id: null },
    ],
    schools: [{ id: SCHOOL, config: over.switchOn ? { sk_learning_memory: true } : {} }],
    parent_links: [
      { parent_id: PARENT, child_id: CHILD, verified_at: "2026-10-01T00:00:00Z" },
      // a link that was never verified must not count
      { parent_id: OTHER_PARENT, child_id: CHILD, verified_at: null },
    ],
    consents: [],
    sk_learning_facts: [],
    sk_workflow_facts: [],
  });
}
