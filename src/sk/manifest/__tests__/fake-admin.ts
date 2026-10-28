// A small in-memory stand-in for the service-role Supabase client, for the
// manifest suites (not a test file: vitest only picks *.test.ts). Honours the
// filters the manifest modules use (eq / in / is, including `params->>key`
// columns), order / limit / maybeSingle, update(...).eq(...).select(), and
// insert with a primary-key conflict (23505). Storage downloads come from a
// path → text map. Everything is logged so a test can assert what was touched.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, unknown>;

const PKS: Record<string, string> = { sk_manifests: "generation_id", generations: "id", artifacts: "id" };

function get(row: Row, col: string): unknown {
  if (col.includes("->>")) {
    const [a, b] = col.split("->>");
    const o = row[a] as Row | null | undefined;
    return o && typeof o === "object" ? o[b] : undefined;
  }
  return row[col];
}

export class FakeAdmin {
  readonly log: string[] = [];
  constructor(
    readonly tables: Record<string, Row[]>,
    readonly files: Record<string, string> = {},
  ) {}

  storage = {
    from: () => ({
      download: async (path: string) => {
        this.log.push(`storage.download(${path})`);
        const text = this.files[path];
        return text === undefined ? { data: null, error: { message: "Object not found" } } : { data: { text: async () => text }, error: null };
      },
    }),
  };

  from(table: string): any {
    const rows = (this.tables[table] ??= []);
    const log = this.log;
    let op: "select" | "update" | "insert" = "select";
    let patch: Row = {};
    let inserted: Row | null = null;
    let returning = false;
    let single = false;
    const filters: Array<(r: Row) => boolean> = [];
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    const b: any = {};
    const chain = (name: string, fn: (...a: any[]) => void) => {
      b[name] = (...a: any[]) => {
        log.push(`${table}.${name}(${a.map((x) => (typeof x === "object" && x !== null && !Array.isArray(x) ? "{…}" : JSON.stringify(x))).join(",")})`);
        fn(...a);
        return b;
      };
    };
    chain("select", () => {
      if (op === "update" || op === "insert") returning = true;
    });
    chain("eq", (col: string, v: unknown) => filters.push((r) => get(r, col) === v));
    chain("in", (col: string, vs: unknown[]) => filters.push((r) => vs.includes(get(r, col))));
    chain("is", (col: string, v: unknown) => filters.push((r) => (v === null ? get(r, col) === null || get(r, col) === undefined : get(r, col) === v)));
    chain("order", (col: string, o?: { ascending?: boolean }) => {
      order = { col, asc: o?.ascending !== false };
    });
    chain("limit", (n: number) => {
      limit = n;
    });
    chain("maybeSingle", () => {
      single = true;
    });
    chain("update", (p: Row) => {
      op = "update";
      patch = p;
    });
    chain("insert", (r: Row) => {
      op = "insert";
      inserted = r;
    });
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const out = (() => {
        if (op === "insert") {
          const pk = PKS[table];
          if (pk && inserted && rows.some((r) => r[pk] === (inserted as Row)[pk])) return { data: null, error: { code: "23505", message: "duplicate key" } };
          rows.push({ ...(inserted as Row) });
          return { data: returning ? [inserted] : null, error: null };
        }
        let matched = rows.filter((r) => filters.every((f) => f(r)));
        if (order) {
          const { col, asc } = order;
          matched = matched.slice().sort((x, y) => (String(get(x, col)) < String(get(y, col)) ? -1 : 1) * (asc ? 1 : -1));
        }
        if (limit !== null) matched = matched.slice(0, limit);
        if (op === "update") {
          for (const r of matched) Object.assign(r, patch);
          return { data: returning ? matched.map((r) => ({ ...r })) : null, error: null };
        }
        const data = matched.map((r) => ({ ...r }));
        return { data: single ? (data[0] ?? null) : data, error: null, count: data.length };
      })();
      return Promise.resolve(out).then(res, rej);
    };
    return b;
  }
}
