// SK S5 slice B — a filter-honouring fake of `analytics_access_log` for the
// cap + audit suites. Not a test file. Unlike fixtures.ts's fakeSession (which
// ignores filters on purpose), the cap IS a filter — actor, scope, day, turn
// id — so this fake applies eq / in / gte / lte / order / limit, the JSON path
// `detail->>turnId`, `{count: "exact", head: true}`, and the aal_insert_self
// policy (actor_id = the signed-in user, else 42501).

/* eslint-disable @typescript-eslint/no-explicit-any */

export type AalRow = {
  id: string;
  actor_id: string;
  actor_role: string | null;
  school_id: string | null;
  scope: string;
  target_kind: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export type AuditLogFake = {
  rows: AalRow[];
  /** Rows this fake inserted (not the seeds). */
  inserted: AalRow[];
  from: (table: string) => any;
  /** Seed n rows for an actor at `at` (+ i ms each). */
  seed: (n: number, o: { actor: string; scope: string; at: Date; turnIds?: string[] }) => void;
};

export function fakeAuditLog(o: { user: string; failInsert?: boolean; failCount?: boolean; failLookup?: boolean } = { user: "" }): AuditLogFake {
  const rows: AalRow[] = [];
  const inserted: AalRow[] = [];
  let seq = 0;
  let last = 0;
  const stamp = (): string => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last).toISOString();
  };
  const val = (r: AalRow, col: string): unknown => {
    if (col === "detail->>turnId") return r.detail?.turnId ?? null;
    return (r as unknown as Record<string, unknown>)[col];
  };
  const builder = () => {
    const filters: Array<(r: AalRow) => boolean> = [];
    let head = false;
    let counting = false;
    let limit = Infinity;
    let toInsert: Record<string, unknown> | null = null;
    let single = false;
    const b: any = {};
    b.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.count) counting = true;
      if (opts?.head) head = true;
      return b;
    };
    b.eq = (col: string, v: unknown) => (filters.push((r) => val(r, col) === v), b);
    b.in = (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(val(r, col))), b);
    b.gte = (col: string, v: string) => (filters.push((r) => String(val(r, col)) >= v), b);
    b.lte = (col: string, v: string) => (filters.push((r) => String(val(r, col)) <= v), b);
    b.order = () => b;
    b.limit = (n: number) => ((limit = n), b);
    b.insert = (row: Record<string, unknown>) => ((toInsert = row), b);
    b.single = () => ((single = true), b);
    b.maybeSingle = b.single;
    const run = () => {
      if (toInsert) {
        if (o.failInsert) return { data: null, error: { message: "insert failed (fake)" } };
        if (toInsert.actor_id !== o.user) return { data: null, error: { code: "42501", message: 'new row violates row-level security policy for table "analytics_access_log"' } };
        const row: AalRow = {
          id: `aal-${++seq}`,
          actor_id: String(toInsert.actor_id),
          actor_role: (toInsert.actor_role as string) ?? null,
          school_id: (toInsert.school_id as string) ?? null,
          scope: String(toInsert.scope),
          target_kind: (toInsert.target_kind as string) ?? null,
          target_id: (toInsert.target_id as string) ?? null,
          detail: (toInsert.detail as Record<string, unknown>) ?? null,
          created_at: stamp(),
        };
        rows.push(row);
        inserted.push(row);
        return { data: single ? { id: row.id, created_at: row.created_at } : null, error: null };
      }
      if (counting && o.failCount) return { data: null, error: { message: "count failed (fake)" }, count: null };
      if (!counting && o.failLookup) return { data: null, error: { message: "lookup failed (fake)" } };
      // RLS aal_self_read: an actor reads their own rows.
      const hit = rows.filter((r) => r.actor_id === o.user && filters.every((f) => f(r)));
      const data = hit.slice(0, limit);
      return { data: head ? null : single ? (data[0] ?? null) : data, error: null, count: counting ? hit.length : null };
    };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej);
    return b;
  };
  return {
    rows,
    inserted,
    from: (table: string) => {
      if (table !== "analytics_access_log") throw new Error(`audit-log fake: unexpected table ${table}`);
      return builder();
    },
    seed: (n, s) => {
      for (let i = 0; i < n; i++) {
        rows.push({
          id: `seed-${++seq}`,
          actor_id: s.actor,
          actor_role: "school_admin",
          school_id: null,
          scope: s.scope,
          target_kind: s.scope === "sk_school" ? "sk_capability" : "school",
          target_id: null,
          detail: s.turnIds?.[i] ? { turnId: s.turnIds[i] } : {},
          created_at: new Date(s.at.getTime() + i).toISOString(),
        });
      }
      last = Math.max(last, s.at.getTime() + n);
    },
  };
}

/** A session whose `analytics_access_log` is the fake; every other table is `base`'s. */
export function withAuditLog<T extends { from: (t: string) => any }>(base: T, aal: AuditLogFake): T {
  return new Proxy(base, {
    get(target, prop, recv) {
      if (prop === "from") return (t: string) => (t === "analytics_access_log" ? aal.from(t) : target.from(t));
      return Reflect.get(target, prop, recv);
    },
  });
}
