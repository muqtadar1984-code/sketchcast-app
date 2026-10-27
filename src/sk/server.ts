// SK B4 — server-side wiring for the /api/sk routes: the graphs on disk, the
// segment/hit-map loaders (local files under public/ for the POC; S3 +
// CloudFront later), the two model providers, the in-memory session store, and
// the auth + feature gate every route runs. Everything a test needs to replace
// goes through `__setSkDepsForTests`.
//
// Never imported by client code (it reads the filesystem and env).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { claudeConfigured } from "@/utils/claude-backend";
import { skEnabled, skUserAllowed } from "@/utils/flags";
import type { LLMProvider } from "@/utils/assistant/provider";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { normaliseSegment, validateSegment, type Segment } from "./board/engine";
import { embedderConfigured, TitanEmbedder } from "./embed";
import { parseGraph } from "./graph";
import { CompositeItemBank, StaticItemBank, type ItemBank } from "./items";
import { UUID_RE } from "./ids";
import { SupabaseItemBank } from "./items-supabase";
import type { LoopDeps } from "./loop";
import { retrievalMode, selectRetrievalProvider, type RetrievalDb, type RetrievalProvider } from "./retrieval";
import { InMemorySessionStore, type SessionStore } from "./store";
import { SupabaseSessionStore, skDbFrom } from "./store-supabase";
import type { TeachingGraph } from "./types";

/** Graph manifests served from public/, as "<url path>" entries. The one-unit
 * stand-in stays alongside the B3 packager's Chapter 2 output so the check /
 * grading flow (which needs items the packager does not yet emit) can be tried. */
export const DEFAULT_GRAPH_URIS = ["/sk-s1/graph-ch2.json", "/sk-s1/ch02/graph.json"];

export type SkDeps = {
  store: SessionStore;
  items: ItemBank;
  graphs: TeachingGraph[];
  routerProvider?: LLMProvider;
  teacherProvider?: LLMProvider;
  retrieval?: RetrievalProvider;
  loadSegment: LoopDeps["loadSegment"];
  loadHitmapElementIds: LoopDeps["loadHitmapElementIds"];
};

const PUBLIC_DIR = () => path.join(process.cwd(), "public");

/** Only files under public/sk-s1/ may be read, by a clean absolute URL path. */
export function publicPathFor(uri: string): string {
  if (!/^\/sk-s1\/[a-z0-9_\-./]+$/i.test(uri) || uri.includes("..")) throw new Error(`refusing to read ${uri}`);
  return path.join(PUBLIC_DIR(), ...uri.split("/").filter(Boolean));
}

async function readJson(uri: string): Promise<unknown> {
  return JSON.parse(await readFile(publicPathFor(uri), "utf-8")) as unknown;
}

const segmentCache = new Map<string, Promise<Segment>>();
export function loadSegmentFromPublic(uri: string): Promise<Segment> {
  let p = segmentCache.get(uri);
  if (!p) {
    p = readJson(uri).then((raw) => validateSegment(normaliseSegment(raw as Segment)));
    p.catch(() => segmentCache.delete(uri));
    segmentCache.set(uri, p);
  }
  return p;
}

/** Hit-map target ids: element ids, each illustration key and "key.region". */
export async function loadHitmapTargetsFromPublic(uri: string): Promise<string[]> {
  const hm = (await readJson(uri)) as { elements?: Record<string, unknown>; asset?: Record<string, { regions?: Record<string, unknown> }> };
  const out = new Set<string>(Object.keys(hm.elements ?? {}));
  for (const [key, a] of Object.entries(hm.asset ?? {})) {
    out.add(key);
    for (const r of Object.keys(a.regions ?? {})) out.add(`${key}.${r}`);
  }
  return [...out];
}

async function loadGraphs(uris: string[]): Promise<TeachingGraph[]> {
  const out: TeachingGraph[] = [];
  for (const uri of uris) {
    try {
      out.push(parseGraph(await readJson(uri), uri.slice(0, uri.lastIndexOf("/") + 1)));
    } catch (e) {
      console.error(`[sk] graph ${uri} skipped:`, (e as Error).message);
    }
  }
  return out;
}

/** Which loaded graphs this store can actually run. The Supabase store keeps
 * attempts in item_attempts (item_id → topic_questions, a uuid FK) and mastery
 * against teaching_objectives, so a graph whose product has no sk_book_products
 * row — the hand-written stand-in, whose items and objective are strings —
 * cannot grade there: its Check opened, drew a question, then died at the
 * attempt insert with 22P02 (founder's run, 2026-10-27). On that store only
 * products the database knows are served; the in-memory store serves all. */
export function graphsForStore(graphs: TeachingGraph[], knownProducts: ReadonlySet<string> | null): TeachingGraph[] {
  if (!knownProducts) return graphs;
  return graphs.filter((g) => {
    if (knownProducts.has(g.product_id)) return true;
    console.error(`[sk] graph ${g.graph_id} withheld: product ${g.product_id} is not in sk_book_products (the Supabase store cannot grade it)`);
    return false;
  });
}

async function servableGraphs(graphs: TeachingGraph[]): Promise<TeachingGraph[]> {
  if (process.env.SK_STORE !== "supabase" || graphs.length === 0) return graphs;
  const db = createAdminClient();
  const { data, error } = await db.from("sk_book_products").select("slug").in("slug", graphs.map((g) => g.product_id));
  if (error) throw new Error(`[sk] products: ${error.message}`);
  return graphsForStore(graphs, new Set((data ?? []).map((r: { slug: string }) => r.slug)));
}

function providers(): Pick<SkDeps, "routerProvider" | "teacherProvider"> {
  if (!claudeConfigured()) return {};
  // Lazy so a missing SDK key never breaks the regex-only path.
  return {
    get routerProvider() {
      return lazyProvider(process.env.SK_ROUTER_MODEL || "claude-haiku-5-5");
    },
    get teacherProvider() {
      return lazyProvider(process.env.SK_TEACHER_MODEL || "claude-sonnet-5-5");
    },
  };
}

const providerCache = new Map<string, LLMProvider>();
function lazyProvider(model: string): LLMProvider {
  let p = providerCache.get(model);
  if (!p) {
    p = {
      id: "anthropic",
      model,
      async *stream(opts) {
        const { AnthropicProvider } = await import("@/utils/assistant/providers/anthropic");
        yield* new AnthropicProvider(model).stream(opts);
      },
    };
    providerCache.set(model, p);
  }
  return p;
}

let deps: Promise<SkDeps> | null = null;
let override: Partial<SkDeps> | null = null;

/** B5: `SK_STORE=supabase` keeps sessions, events, attempts and mastery in
 * the 0157 tables through the admin client, and serves items from
 * `topic_questions`. Unset (the default) is the B4 in-memory store and the
 * U4 stand-in items — nothing changes until the flag is set. */
export function persistence(): Pick<SkDeps, "store" | "items"> {
  if (process.env.SK_STORE === "supabase") {
    const db = skDbFrom(createAdminClient());
    // The stand-in chapter's string ids fall through to the static items (live fix 2026-10-27).
    return { store: new SupabaseSessionStore(db), items: new CompositeItemBank(new SupabaseItemBank(db), new StaticItemBank(), (id) => UUID_RE.test(id)) };
  }
  return { store: new InMemorySessionStore(), items: new StaticItemBank() };
}

/** R1: `SK_RETRIEVAL=fts` (default) grounds questions on the OR-relaxed
 * full-text leg of 0160; `hybrid` adds the Titan-v2 pgvector leg and the
 * vector-score gate (`SK_RETRIEVAL_GATE`, default 0.32); `off` leaves the
 * teacher on the unit narration alone. Both adapters go through the admin
 * client (the 0160 functions are service-role only); without the service key
 * (local dev) there is no retrieval, logged. */
export function retrieval(): Pick<SkDeps, "retrieval"> {
  if (retrievalMode() === "off") return {};
  try {
    const db = createAdminClient() as unknown as RetrievalDb;
    const provider = selectRetrievalProvider({ db, embedder: new TitanEmbedder(), embedderConfigured });
    return provider ? { retrieval: provider } : {};
  } catch (e) {
    console.error("[sk] retrieval disabled:", (e as Error).message);
    return {};
  }
}

export function skDeps(): Promise<SkDeps> {
  if (!deps) {
    deps = (async () => {
      const uris = (process.env.SK_GRAPHS || "").split(",").map((s) => s.trim()).filter(Boolean);
      const base: SkDeps = {
        ...persistence(),
        graphs: await servableGraphs(await loadGraphs(uris.length ? uris : DEFAULT_GRAPH_URIS)),
        loadSegment: loadSegmentFromPublic,
        loadHitmapElementIds: loadHitmapTargetsFromPublic,
        ...providers(),
        ...retrieval(),
      };
      return { ...base, ...(override ?? {}) };
    })();
  }
  return deps;
}

/** Tests: replace any part of the wiring; `null` resets to the real thing. */
export function __setSkDepsForTests(d: Partial<SkDeps> | null): void {
  override = d;
  deps = null;
}

/** The LoopDeps for one graph (the loop is single-graph; the session names it). */
export function loopDepsFor(d: SkDeps, productId: string, chapter: number): LoopDeps | null {
  const graph = d.graphs.find((g) => g.product_id === productId && g.chapter === chapter);
  if (!graph) return null;
  return { store: d.store, items: d.items, graph, routerProvider: d.routerProvider, teacherProvider: d.teacherProvider, retrieval: d.retrieval, loadSegment: d.loadSegment, loadHitmapElementIds: d.loadHitmapElementIds };
}

// ── Gate + auth, shared by every route ──────────────────────────────────────
export type Gate = { ok: true; userId: string } | { ok: false; response: NextResponse };

export async function gate(): Promise<Gate> {
  if (!skEnabled()) return { ok: false, response: NextResponse.json({ error: "Not available." }, { status: 404 }) };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Restricted live (SK_ALLOWED_EMAILS set): anyone off the list — signed in
  // or not — sees the same 404 as when the flag is off, so the surface does
  // not even admit it exists. With the list unset this is a no-op.
  if (!skUserAllowed(user)) return { ok: false, response: NextResponse.json({ error: "Not available." }, { status: 404 }) };
  if (!user) return { ok: false, response: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  return { ok: true, userId: user.id };
}

export async function readBody<T extends Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as T) : null;
  } catch {
    return null;
  }
}
