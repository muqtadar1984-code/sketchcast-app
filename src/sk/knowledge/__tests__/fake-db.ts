// An in-memory stand-in for the service-role Supabase client: just the query
// builder calls and RPCs the knowledge importers make, with 0174's
// sk_knowledge_replace / _versions / _prune semantics.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { KnowledgeBlock, KnowledgeDb } from "../store";

type Row = Record<string, any>;
type Filter = (r: Row) => boolean;

function get(r: Row, col: string): any {
  if (col.includes("->")) {
    const [c, k] = col.split("->");
    return r[c]?.[k];
  }
  return r[col];
}

export type FakeDb = KnowledgeDb & {
  tables: Record<string, Row[]>;
  blocks: (KnowledgeBlock & { id: number; created_at: string })[];
  calls: { rpc: string; args: any }[];
};

export function fakeDb(init: Record<string, Row[]> = {}, opts: { missing?: string[]; now?: () => string } = {}): FakeDb {
  const tables: Record<string, Row[]> = { sk_book_products: [], sk_release_imports: [], ...structuredClone(init) };
  const blocks: FakeDb["blocks"] = [];
  const calls: FakeDb["calls"] = [];
  let seq = 0;
  const now = opts.now ?? (() => new Date().toISOString());

  function query(table: string) {
    const filters: Filter[] = [];
    let op: "select" | "update" | "insert" | "upsert" = "select";
    let payload: any = null;
    let conflict: string | null = null;
    let orders: [string, boolean][] = [];
    let range: [number, number] | null = null;
    let mode: "many" | "maybe" | "single" = "many";
    const run = () => {
      if (opts.missing?.includes(table)) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` } };
      const t = (tables[table] ??= []);
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: r.id ?? `${table}-${++seq}`, ...r }));
        t.push(...rows);
        return { data: mode === "many" ? rows : rows[0], error: null };
      }
      if (op === "upsert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const r of rows) {
          const i = t.findIndex((x) => x[conflict!] === r[conflict!]);
          if (i >= 0) t[i] = { ...t[i], ...r };
          else t.push({ ...r });
        }
        return { data: null, error: null };
      }
      let rows = t.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        rows.forEach((r) => Object.assign(r, payload));
        return { data: null, error: null };
      }
      for (const [c, asc] of [...orders].reverse()) rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      rows = rows.map((r) => ({ ...r }));
      if (mode === "single") return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "not one row" } };
      if (mode === "maybe") return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => (filters.push((r) => get(r, c) === v), b),
      is: (c: string, v: any) => (filters.push((r) => (get(r, c) ?? null) === v), b),
      not: (c: string, o: string, v: any) => (filters.push((r) => (o === "is" ? (get(r, c) ?? null) !== v : true)), b),
      in: (c: string, vs: any[]) => (filters.push((r) => vs.includes(get(r, c))), b),
      gte: (c: string, v: any) => (filters.push((r) => get(r, c) >= v), b),
      order: (c: string, o?: { ascending?: boolean }) => (orders.push([c, o?.ascending !== false]), b),
      range: (f: number, t: number) => ((range = [f, t]), b),
      maybeSingle: () => ((mode = "maybe"), b),
      single: () => ((mode = "single"), b),
      update: (p: any) => ((op = "update"), (payload = p), b),
      insert: (p: any) => ((op = "insert"), (payload = p), b),
      upsert: (p: any, o?: { onConflict?: string }) => ((op = "upsert"), (payload = p), (conflict = o?.onConflict ?? "id"), b),
      then: (res: any, rej: any) => Promise.resolve().then(run).then(res, rej),
    };
    orders = [];
    return b;
  }

  const inScope = (b: Row, s: Row) =>
    s.source_kind === b.source_kind && s.source_id === b.source_id && (s.language == null || s.language === b.language) && (s.chapter == null || s.chapter === b.chapter);

  async function rpc(fn: string, args: any = {}) {
    calls.push({ rpc: fn, args: structuredClone(args) });
    if (opts.missing?.includes(fn)) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
    if (fn === "sk_knowledge_replace") {
      const { p_scopes: scopes, p_blocks: bs } = args;
      const outside = bs.filter((b: Row) => !scopes.some((s: Row) => inScope(b, s)));
      if (outside.length) return { data: null, error: { code: "22023", message: `${outside.length} block(s) outside the given scopes` } };
      const before = blocks.length;
      for (let i = blocks.length - 1; i >= 0; i--) if (scopes.some((s: Row) => inScope(blocks[i], s))) blocks.splice(i, 1);
      const deleted = before - blocks.length;
      for (const b of bs) {
        if (!b.text || b.text.length > 8000) return { data: null, error: { code: "23514", message: "text check" } };
        blocks.push({ ...b, id: ++seq, created_at: now() });
      }
      return { data: { deleted, inserted: bs.length }, error: null };
    }
    if (fn === "sk_knowledge_versions") {
      const m = new Map<string, any>();
      for (const b of blocks.filter((x) => x.source_kind === args.p_source_kind)) {
        const k = `${b.source_id}|${b.language}|${b.chapter}|${b.version}`;
        const r = m.get(k) ?? { source_id: b.source_id, language: b.language, chapter: b.chapter, version: b.version, blocks: 0, imported_at: b.created_at };
        r.blocks++;
        if (b.created_at > r.imported_at) r.imported_at = b.created_at;
        m.set(k, r);
      }
      return { data: [...m.values()], error: null };
    }
    if (fn === "sk_knowledge_prune") {
      const arts = tables.topic_articles ?? [];
      const books = tables.books ?? [];
      let a = 0;
      let u = 0;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const k = blocks[i];
        if (k.source_kind === "article") {
          const row = arts.find((x) => String(x.id) === k.source_id);
          const ok = row && row.status === "approved" && !arts.some((n) => n.topic_id === row.topic_id && n.language === row.language && n.status === "approved" && n.version > row.version);
          if (!ok) (blocks.splice(i, 1), a++);
        } else if (k.source_kind === "user_book") {
          if (!books.some((b) => String(b.id) === k.source_id && !b.removed_at)) (blocks.splice(i, 1), u++);
        }
      }
      return { data: { articles: a, user_books: u }, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  }

  return { tables, blocks, calls, from: (t: string) => query(t), rpc };
}
