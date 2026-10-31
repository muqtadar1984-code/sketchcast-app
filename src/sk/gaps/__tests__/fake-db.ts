// A small in-memory stand-in for the service-role client, for the SK gaps
// suites (not a test file: vitest only picks *.test.ts). Supports the chains
// group.ts / purge.ts use: select / insert / update(patch, {count}) / delete,
// filtered by eq / neq / is / in / lt, with order / limit and a returning
// select(). Every call is logged so a test can assert the query shape.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;
export type Call = { table: string; op: string; patch?: unknown; options?: unknown; filters: [string, string, unknown][]; order: unknown[]; limit?: number };

export class FakeDb {
  readonly calls: Call[] = [];
  failOn: { table: string; op: string; message: string } | null = null;
  constructor(readonly tables: Record<string, Row[]>) {}

  from(table: string): any {
    const rows = (this.tables[table] ??= []);
    const call: Call = { table, op: "select", filters: [], order: [] };
    this.calls.push(call);
    let payload: Row[] = [];
    let returning = false;
    const match = (r: Row) =>
      call.filters.every(([op, col, v]) => {
        const x = r[col];
        if (op === "eq") return x === v;
        if (op === "neq") return x !== v;
        if (op === "is") return v === null ? x === null || x === undefined : x === v;
        if (op === "not_is") return !(x === null || x === undefined);
        if (op === "in") return (v as unknown[]).includes(x);
        if (op === "lt") return String(x) < String(v);
        return true;
      });
    const run = () => {
      const fail = this.failOn;
      if (fail && fail.table === table && fail.op === call.op) return { data: null, error: { message: fail.message }, count: null };
      if (call.op === "insert") {
        for (const p of payload) rows.push({ ...p });
        return { data: returning ? payload : null, error: null };
      }
      if (call.op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, call.patch as Row);
        const count = (call.options as { count?: string } | undefined)?.count ? hit.length : null;
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null, count };
      }
      if (call.op === "delete") {
        const keep = rows.filter((r) => !match(r));
        rows.splice(0, rows.length, ...keep);
        return { data: null, error: null };
      }
      let out = rows.filter(match);
      for (const o of call.order as { col: string; asc: boolean }[]) {
        out = out.slice().sort((a, b) => (String(a[o.col] ?? "") < String(b[o.col] ?? "") ? -1 : String(a[o.col] ?? "") > String(b[o.col] ?? "") ? 1 : 0) * (o.asc ? 1 : -1));
      }
      if (call.limit !== undefined) out = out.slice(0, call.limit);
      return { data: out.map((r) => ({ ...r })), error: null };
    };
    const q: any = {
      select: () => {
        if (call.op === "select") return q;
        returning = true;
        return q;
      },
      insert: (p: Row | Row[]) => {
        call.op = "insert";
        payload = Array.isArray(p) ? p : [p];
        call.patch = payload;
        return q;
      },
      update: (p: Row, options?: unknown) => {
        call.op = "update";
        call.patch = p;
        call.options = options;
        return q;
      },
      delete: () => {
        call.op = "delete";
        return q;
      },
      eq: (c: string, v: unknown) => (call.filters.push(["eq", c, v]), q),
      neq: (c: string, v: unknown) => (call.filters.push(["neq", c, v]), q),
      is: (c: string, v: unknown) => (call.filters.push(["is", c, v]), q),
      in: (c: string, v: unknown[]) => (call.filters.push(["in", c, v]), q),
      lt: (c: string, v: unknown) => (call.filters.push(["lt", c, v]), q),
      // only `.not(col, "is", null)` is used
      not: (c: string) => (call.filters.push(["not_is", c, null]), q),
      order: (col: string, o?: { ascending?: boolean }) => (call.order.push({ col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((call.limit = n), q),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  }
}
