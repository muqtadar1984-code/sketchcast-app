// Shared fakes for the SK Shell suites. Not a test file (vitest only picks
// *.test.ts). No network, no Supabase: a table→rows map behind a chainable
// builder that ignores filters — deliberately, so the "RLS leaked a foreign
// row" case can be simulated and the handlers' own ownership filter tested.

import type { SkContext, SkHat, SkRole } from "../types";
import { buildContext } from "../context";

export const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_TEACHER_ID = "22222222-2222-4222-8222-222222222222";
export const SCHOOL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_SCHOOL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const NOW = new Date("2026-10-28T08:30:00.000Z");

export const ALL_FLAGS: Record<string, boolean> = {
  analytics: true,
  timetable: true,
  calendar: true,
  diary: true,
  kits: true,
  board: true,
  hats: true,
  parentPortal: true,
  sk: true,
  hasChildren: true,
  schoolParent: false,
  staff: false,
};

export type CtxOverrides = {
  role?: SkRole | string;
  hat?: SkHat;
  schoolId?: string | null;
  scope?: Array<{ grade: string | null; subject: string | null }>;
  plan?: string;
  staff?: boolean;
  flags?: Record<string, boolean>;
  path?: string;
  selection?: Record<string, string>;
  locale?: string;
  userId?: string;
};

export function makeCtx(o: CtxOverrides = {}): SkContext {
  return buildContext({
    user: { id: o.userId ?? TEACHER_ID, email: "t@school.example" },
    role: o.role ?? "teacher",
    schoolId: o.schoolId === undefined ? SCHOOL_ID : o.schoolId,
    hat: o.hat === undefined ? "teacher" : o.hat,
    coordinatorScope: o.scope ?? [],
    plan: o.plan ?? "school",
    staff: o.staff ?? false,
    flags: { ...ALL_FLAGS, ...(o.flags ?? {}) },
    collector: { path: o.path ?? "/dashboard", selection: o.selection, locale: o.locale },
    now: NOW,
  });
}

export type Rows = Record<string, unknown>[];

/* eslint-disable @typescript-eslint/no-explicit-any */
export function fakeSession(tables: Record<string, Rows>, opts: { user?: { id: string; email?: string; email_confirmed_at?: string } | null; log?: string[] } = {}) {
  const log = opts.log ?? [];
  const builder = (table: string) => {
    const rows = tables[table] ?? [];
    let single = false;
    const b: any = {};
    const chain = (name: string) => (...args: unknown[]) => {
      log.push(`${table}.${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
      return b;
    };
    for (const m of ["select", "eq", "neq", "ilike", "in", "is", "not", "gte", "lte", "order", "limit", "insert", "update"]) b[m] = chain(m);
    b.maybeSingle = () => {
      single = true;
      log.push(`${table}.maybeSingle()`);
      return b;
    };
    b.single = b.maybeSingle;
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length }).then(res, rej);
    return b;
  };
  return {
    log,
    auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" } : opts.user } }) },
    from: builder,
    rpc: (fn: string, args?: Record<string, unknown>) => {
      log.push(`rpc.${fn}(${JSON.stringify(args ?? {})})`);
      return Promise.resolve({ data: null, error: null });
    },
  };
}

export function fakeAdmin(plan: string | null = "school", staffIds: string[] = []) {
  const inserts: { table: string; row: unknown }[] = [];
  let seq = 0;
  return {
    inserts,
    from: (table: string) => {
      const b: any = {
        insert: (row: unknown) => {
          inserts.push({ table, row });
          // Awaitable as before (the audit sink), and chainable with
          // `.select("id").single()` for tokens.ts's issue path (S1).
          const id = `33333333-3333-4333-8333-${String(++seq).padStart(12, "0")}`;
          const p: any = Promise.resolve({ data: null, error: null });
          p.select = () => ({ single: async () => ({ data: { id }, error: null }) });
          return p;
        },
        select: () => b,
        is: () => Promise.resolve({ data: staffIds.map((user_id) => ({ user_id })), error: null }),
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return b;
    },
    rpc: async (fn: string) => (fn === "plan_tier" ? { data: plan, error: null } : { data: null, error: null }),
    auth: { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Parse an SSE body of `data: {json}` frames into events, in order. */
export async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
}
