// SK retrieval — the grounding seam for the question path (plan §6, R1 report).
//
// A RetrievalProvider turns the student's question into the book passages the
// teacher may ground on, or reports that the book has nothing on it. Two
// adapters, chosen by env SK_RETRIEVAL:
//   fts     (default) the OR-relaxed Postgres full-text leg alone
//           (sk_search_fts, 0160). No vectors, no Bedrock, no gate beyond
//           "no rows" — R1 showed FTS scores do not separate on-/off-chapter.
//   hybrid  sk_search_hybrid (0160): reciprocal rank fusion of that FTS leg
//           and a pgvector cosine leg over Titan v2 embeddings. The question
//           is embedded through Bedrock IN PARALLEL with the router call
//           (begin() starts it, result() awaits it: one embedding per turn)
//           and the gate is on the VECTOR score of the best row
//           (SK_RETRIEVAL_GATE, default 0.32 for Titan): below it the
//           provider reports "none" and the loop says it cannot find that in
//           the book instead of letting the model answer off-book.
//   off     no retrieval: the teacher grounds on the unit narration only
//           (what the loop did before this seam existed).
//
// Failures (no RPC yet, Bedrock denied, network) are reported as status
// "error", never thrown: the loop then answers from the unit narration as
// before, so a retrieval outage degrades grounding, it never breaks a turn.
//
// Filtering by product and chapter happens inside the SQL functions' WHERE;
// the provider also drops any row that disagrees, as belt and braces. The
// graph names the product by slug; the provider resolves it to the
// sk_book_products id once and caches it.

import type { Embedder } from "./embed";

export type RetrievalContext = {
  /** sk_book_products.id or slug (the teaching graph carries the slug). */
  product: string;
  chapter: number;
  signal?: AbortSignal;
};

export type RetrievedPassage = {
  blockId: string;
  /** contracts §1.2 SourceRef: book:<product>/<chapter>/<sid>#<block_index> */
  sourceRef: string;
  unitKey: string | null;
  blockType: string;
  text: string;
  score: number;
  ftsScore: number | null;
  vecScore: number | null;
};

export type RetrievalResult =
  | { status: "grounded"; passages: RetrievedPassage[]; bestVecScore: number | null; gate: number | null; ms: number }
  | { status: "none"; reason: "gate" | "empty"; bestVecScore: number | null; gate: number | null; ms: number }
  | { status: "error"; message: string; ms: number };

/** One turn's retrieval: created before the router call, awaited after it. */
export interface TurnRetrieval {
  result(): Promise<RetrievalResult>;
}

export interface RetrievalProvider {
  readonly id: "fts" | "hybrid";
  begin(query: string, ctx: RetrievalContext): TurnRetrieval;
}

export const DEFAULT_GATE = 0.32;
export const DEFAULT_K = 5;
export const DEFAULT_POOL = 20;
export const DEFAULT_RRF_K = 60;
const MAX_QUERY_CHARS = 600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The slice of supabase-js the providers use (an RPC and one product lookup). */
export interface RetrievalDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, value: unknown): { maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }> };
    };
  };
}

type SearchRow = {
  id: string;
  product_id: string;
  chapter: number;
  section_sid: string;
  block_index: number;
  unit_key: string | null;
  block_type: string;
  content: string;
  score: number;
  fts_score?: number | null;
  vec_score?: number | null;
  best_vec_score?: number | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Rows → passages, in score order, dropping anything outside the requested
 * product/chapter (the SQL already filters; this makes a regression loud). */
export function toPassages(rows: unknown, productId: string, chapter: number, productLabel: string): { passages: RetrievedPassage[]; dropped: number } {
  const passages: RetrievedPassage[] = [];
  let dropped = 0;
  for (const raw of Array.isArray(rows) ? (rows as SearchRow[]) : []) {
    if (!raw || typeof raw !== "object" || raw.product_id !== productId || Number(raw.chapter) !== chapter || typeof raw.content !== "string") {
      dropped += 1;
      continue;
    }
    passages.push({
      blockId: String(raw.id),
      sourceRef: `book:${productLabel}/${chapter}/${raw.section_sid}#${raw.block_index}`,
      unitKey: raw.unit_key ?? null,
      blockType: String(raw.block_type),
      text: raw.content,
      score: num(raw.score) ?? 0,
      ftsScore: num(raw.fts_score),
      vecScore: num(raw.vec_score),
    });
  }
  passages.sort((a, b) => b.score - a.score);
  return { passages, dropped };
}

/** The gate decision, kept pure for the tests: the best vector score of the
 * call (the vector leg's top-1, reported on every row) against the gate.
 * No vector score at all (nothing embedded yet) → not gated: the FTS leg's
 * rows stand, logged once, so an un-embedded chapter still grounds. */
export function gateDecision(bestVecScore: number | null, gate: number): "grounded" | "gate" | "ungated" {
  if (bestVecScore == null) return "ungated";
  return bestVecScore >= gate ? "grounded" : "gate";
}

/** Shared: resolve the graph's product (slug or id) to the sk_book_products id. */
class ProductResolver {
  private readonly cache = new Map<string, Promise<string>>();
  constructor(private readonly db: RetrievalDb) {}
  resolve(product: string): Promise<string> {
    if (UUID_RE.test(product)) return Promise.resolve(product.toLowerCase());
    let p = this.cache.get(product);
    if (!p) {
      p = (async () => {
        const { data, error } = await this.db.from("sk_book_products").select("id").eq("slug", product).maybeSingle();
        if (error) throw new Error(`product lookup failed: ${error.message}`);
        const id = (data as { id?: string } | null)?.id;
        if (!id) throw new Error(`no sk_book_products row for slug "${product}"`);
        return id;
      })();
      p.catch(() => this.cache.delete(product));
      this.cache.set(product, p);
    }
    return p;
  }
}

const settle = (p: Promise<RetrievalResult>): TurnRetrieval => {
  // Start now, report later: a rejection is folded into the result so an
  // un-awaited turn (a command, not a question) never surfaces as unhandled.
  const safe = p.catch((e): RetrievalResult => ({ status: "error", message: (e as Error).message, ms: 0 }));
  return { result: () => safe };
};

const warnOnce = new Set<string>();
function warn(key: string, message: string): void {
  if (warnOnce.has(key)) return;
  warnOnce.add(key);
  console.error(`[sk retrieval] ${message}`);
}
/** Test hook. */
export function __resetRetrievalWarnings(): void {
  warnOnce.clear();
}

export type ProviderOptions = { k?: number; now?: () => number };

// ── FTS (default) ───────────────────────────────────────────────────────────
export class FtsRetrievalProvider implements RetrievalProvider {
  readonly id = "fts" as const;
  private readonly products: ProductResolver;
  private readonly k: number;
  private readonly now: () => number;
  constructor(
    private readonly db: RetrievalDb,
    opts: ProviderOptions = {},
  ) {
    this.products = new ProductResolver(db);
    this.k = opts.k ?? DEFAULT_K;
    this.now = opts.now ?? Date.now;
  }
  begin(query: string, ctx: RetrievalContext): TurnRetrieval {
    const q = query.trim().slice(0, MAX_QUERY_CHARS);
    const t0 = this.now();
    return settle(
      (async (): Promise<RetrievalResult> => {
        if (!q) return { status: "none", reason: "empty", bestVecScore: null, gate: null, ms: 0 };
        const productId = await this.products.resolve(ctx.product);
        const { data, error } = await this.db.rpc("sk_search_fts", { q, p_product: productId, p_chapter: ctx.chapter, k: this.k });
        if (error) {
          warn("fts", `sk_search_fts failed (is 0160 applied?): ${error.message}`);
          return { status: "error", message: error.message, ms: this.now() - t0 };
        }
        const { passages, dropped } = toPassages(data, productId, ctx.chapter, ctx.product);
        if (dropped) warn("fts-drop", `sk_search_fts returned ${dropped} row(s) outside the requested product/chapter — dropped`);
        const ms = this.now() - t0;
        return passages.length ? { status: "grounded", passages, bestVecScore: null, gate: null, ms } : { status: "none", reason: "empty", bestVecScore: null, gate: null, ms };
      })(),
    );
  }
}

// ── Hybrid (FTS + pgvector, RRF, vector-score gate) ─────────────────────────
export type HybridOptions = ProviderOptions & { gate?: number; pool?: number; rrfK?: number };

export class HybridRetrievalProvider implements RetrievalProvider {
  readonly id = "hybrid" as const;
  readonly gate: number;
  private readonly products: ProductResolver;
  private readonly k: number;
  private readonly pool: number;
  private readonly rrfK: number;
  private readonly now: () => number;
  constructor(
    private readonly db: RetrievalDb,
    private readonly embedder: Embedder,
    opts: HybridOptions = {},
  ) {
    this.products = new ProductResolver(db);
    this.gate = opts.gate ?? DEFAULT_GATE;
    this.k = opts.k ?? DEFAULT_K;
    this.pool = opts.pool ?? DEFAULT_POOL;
    this.rrfK = opts.rrfK ?? DEFAULT_RRF_K;
    this.now = opts.now ?? Date.now;
  }

  /** begin() starts the embedding (and the product lookup) at once — in
   * parallel with whatever the caller does next (the router call) — and the
   * search as soon as both are in. result() returns the same promise however
   * often it is called: one embedding, one RPC per turn. */
  begin(query: string, ctx: RetrievalContext): TurnRetrieval {
    const q = query.trim().slice(0, MAX_QUERY_CHARS);
    const t0 = this.now();
    return settle(
      (async (): Promise<RetrievalResult> => {
        if (!q) return { status: "none", reason: "empty", bestVecScore: null, gate: this.gate, ms: 0 };
        const [productId, qv] = await Promise.all([this.products.resolve(ctx.product), this.embedder.embed(q, ctx.signal)]);
        const { data, error } = await this.db.rpc("sk_search_hybrid", { q, qv, p_product: productId, p_chapter: ctx.chapter, k: this.k, pool: this.pool, rrf_k: this.rrfK });
        if (error) {
          warn("hybrid", `sk_search_hybrid failed (is 0160 applied?): ${error.message}`);
          return { status: "error", message: error.message, ms: this.now() - t0 };
        }
        const { passages, dropped } = toPassages(data, productId, ctx.chapter, ctx.product);
        if (dropped) warn("hybrid-drop", `sk_search_hybrid returned ${dropped} row(s) outside the requested product/chapter — dropped`);
        const rows = Array.isArray(data) ? (data as SearchRow[]) : [];
        let bestVecScore: number | null = null;
        for (const r of rows) {
          const b = num(r?.best_vec_score);
          if (b != null && (bestVecScore == null || b > bestVecScore)) bestVecScore = b;
        }
        const ms = this.now() - t0;
        if (!passages.length) return { status: "none", reason: "empty", bestVecScore, gate: this.gate, ms };
        const decision = gateDecision(bestVecScore, this.gate);
        if (decision === "gate") return { status: "none", reason: "gate", bestVecScore, gate: this.gate, ms };
        if (decision === "ungated") warn("hybrid-unembedded", `no block of ${ctx.product}/${ctx.chapter} has an embedding — hybrid is running on the FTS leg alone (run tools/sk/embed-blocks.ts)`);
        return { status: "grounded", passages, bestVecScore, gate: this.gate, ms };
      })(),
    );
  }
}

// ── Selection by env ────────────────────────────────────────────────────────
export type RetrievalMode = "fts" | "hybrid" | "off";
/** process.env, or a plain record in tests. */
export type Env = Record<string, string | undefined>;

export function retrievalMode(env: Env = process.env): RetrievalMode {
  const raw = (env.SK_RETRIEVAL || "fts").trim().toLowerCase();
  if (raw === "hybrid" || raw === "off" || raw === "fts") return raw;
  warn("mode", `SK_RETRIEVAL="${env.SK_RETRIEVAL}" is not fts|hybrid|off — using fts`);
  return "fts";
}

export function retrievalGate(env: Env = process.env): number {
  const raw = env.SK_RETRIEVAL_GATE;
  if (raw == null || raw.trim() === "") return DEFAULT_GATE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    warn("gate", `SK_RETRIEVAL_GATE="${raw}" is not a number in [0, 1] — using ${DEFAULT_GATE}`);
    return DEFAULT_GATE;
  }
  return n;
}

/** The provider for this process, or undefined when retrieval is off. The
 * hybrid needs an embedder; without AWS credentials it falls back to FTS and
 * says so once, so a half-configured deploy still grounds on the book. */
export function selectRetrievalProvider(input: { db: RetrievalDb; embedder?: Embedder; embedderConfigured: () => boolean; env?: Env; now?: () => number }): RetrievalProvider | undefined {
  const env = input.env ?? process.env;
  const mode = retrievalMode(env);
  if (mode === "off") return undefined;
  if (mode === "hybrid") {
    if (input.embedder && input.embedderConfigured()) return new HybridRetrievalProvider(input.db, input.embedder, { gate: retrievalGate(env), now: input.now });
    warn("hybrid-creds", "SK_RETRIEVAL=hybrid but no AWS credentials (AWS_ROLE_ARN or keys) for the embedder — using fts");
  }
  return new FtsRetrievalProvider(input.db, { now: input.now });
}
