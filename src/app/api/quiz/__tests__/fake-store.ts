/**
 * The injectable store the quiz tests run against — same shape and spirit as
 * the lemonsqueezy ClaimDb fake. Shared by quiz.test.ts (the logic core) and
 * routes.test.ts (the two Route Handlers), so both exercise ONE model of the
 * database rather than drifting apart.
 *
 * Not a *.test.ts file on purpose: vitest collects `src/**\/__tests__/**\/*.test.ts`,
 * so this sits beside them without being run as a suite.
 *
 * It models the three things submitQuizWith now depends on and a naive stub
 * would paper over:
 *   * INSERT raises a unique violation on (generation_id, student_id) — the
 *     lost-race path for a first submission;
 *   * UPDATE applies `eq` filters and REPORTS WHICH ROWS IT HIT, so a
 *     compare-and-swap that matches nothing is observably different from one
 *     that succeeds;
 *   * every write is recorded, so a refusal can assert nothing was written.
 */

export type Row = Record<string, unknown>;

export type Write =
  | { op: "insert"; table: string; row: Row }
  | { op: "update"; table: string; row: Row; match: Array<[string, unknown]>; hit: number };

export class FakeStore {
  tables: Record<string, Row[]>;
  /** storage path → file text. A missing path models a download failure. */
  files: Record<string, string>;
  writes: Write[] = [];
  /** Forced error for the next write, whichever kind it is. */
  writeError: { message: string; code?: string } | null = null;
  /** Runs immediately before a write lands — the hook a concurrency test uses
   * to let another request win the race. */
  beforeWrite: (() => void) | null = null;

  constructor(tables: Record<string, Row[]> = {}, files: Record<string, string> = {}) {
    this.tables = tables;
    this.files = files;
  }

  private rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  from(table: string) {
    const selectFilters: Array<[string, unknown]> = [];
    const matching = () => this.rows(table).filter((r) => selectFilters.every(([c, v]) => r[c] === v));
    const filter = {
      eq(col: string, v: unknown) {
        selectFilters.push([col, v]);
        return filter;
      },
      maybeSingle: async () => ({ data: matching()[0] ?? null }),
      then<A, B>(ok?: ((v: { data: Row[] | null }) => A) | null, no?: ((e: unknown) => B) | null) {
        return Promise.resolve({ data: matching() }).then(ok, no);
      },
    };

    // Everything below is an arrow function on purpose: `this` stays the
    // FakeStore instance without aliasing it to a local.
    return {
      select: () => filter,

      insert: async (row: Row) => {
        this.beforeWrite?.();
        if (this.writeError) return { error: this.writeError };
        const list = this.rows(table);
        // The real UNIQUE (generation_id, student_id) constraint.
        if (
          table === "submissions" &&
          list.some((r) => r.generation_id === row.generation_id && r.student_id === row.student_id)
        )
          return {
            error: {
              code: "23505",
              message: 'duplicate key value violates unique constraint "submissions_generation_id_student_id_key"',
            },
          };
        list.push({ ...row });
        this.writes.push({ op: "insert", table, row });
        return { error: null };
      },

      update: (row: Row) => {
        const match: Array<[string, unknown]> = [];
        const upd = {
          eq: (col: string, v: unknown) => {
            match.push([col, v]);
            return upd;
          },
          select: () => upd,
          then: <A, B>(
            ok?: ((v: { data: Row[] | null; error: unknown }) => A) | null,
            no?: ((e: unknown) => B) | null,
          ) => {
            this.beforeWrite?.();
            if (this.writeError) return Promise.resolve({ data: null, error: this.writeError }).then(ok, no);
            const hits = this.rows(table).filter((r) => match.every(([c, v]) => r[c] === v));
            for (const r of hits) Object.assign(r, row);
            this.writes.push({ op: "update", table, row, match, hit: hits.length });
            return Promise.resolve({ data: hits.map((r) => ({ id: r.id ?? null })), error: null }).then(ok, no);
          },
        };
        return upd;
      },
    };
  }

  get storage() {
    return {
      from: () => ({
        download: async (path: string) => {
          const text = this.files[path];
          if (text === undefined) return { data: null, error: { message: "not found" } };
          return { data: { text: async () => text }, error: null };
        },
      }),
    };
  }

  /** The submissions rows as they now stand. */
  subs(): Row[] {
    return this.tables["submissions"] ?? [];
  }

  /** The row a write actually put on the wire, in order. */
  written(): Row[] {
    return this.writes.map((w) => w.row);
  }
}
