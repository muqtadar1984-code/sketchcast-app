// SK B4 — server-side wiring for the /api/sk routes: the two model providers,
// the session store, the item bank, entitlements, and the auth + feature gate
// every route runs. Everything a test needs to replace goes through
// `__setSkDepsForTests`.
//
// S3 slice E retired the packager clip path: no teaching graph is read from
// public/ any more, so the graph loop (session/turn/answer/command) has no
// graph in production — every product/chapter it is asked for is "not found",
// and the student tutor runs on kit artifacts (kit-server.ts). The loop itself
// is unchanged and stays tested through injected graphs.
//
// Never imported by client code (it reads env and server-only clients).

import { NextResponse } from "next/server";
import { claudeConfigured } from "@/utils/claude-backend";
import { skAllowanceEnforced, skEnabled, skUserAllowed } from "@/utils/flags";
import type { LLMProvider } from "@/utils/assistant/provider";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { embedderConfigured, TitanEmbedder } from "./embed";
import { SupabaseEntitlements, type EntitlementSource } from "./entitlement";
import { CompositeItemBank, StaticItemBank, type ItemBank } from "./items";
import { UUID_RE } from "./ids";
import { SupabaseItemBank } from "./items-supabase";
import type { LoopDeps } from "./loop";
import { ProductKits } from "./product-kits";
import { retrievalMode, selectRetrievalProvider, type RetrievalDb, type RetrievalProvider } from "./retrieval";
import { PollySpeechProvider } from "./speech/polly";
import type { SpeechProvider } from "./speech/provider";
import { InMemorySessionStore, type SessionStore } from "./store";
import { SupabaseSessionStore, skDbFrom } from "./store-supabase";
import type { TeachingGraph } from "./types";

export type SkDeps = {
  store: SessionStore;
  items: ItemBank;
  /** B8: the student's licence / plan / grant rows. Undefined = the dev-flag (in-memory wiring only). */
  entitlements?: EntitlementSource;
  /** B8: FEATURE_SK_ALLOWANCE — refuse live turns past a grant's allowance. */
  allowanceEnforced?: boolean;
  graphs: TeachingGraph[];
  routerProvider?: LLMProvider;
  teacherProvider?: LLMProvider;
  retrieval?: RetrievalProvider;
  loadSegment: LoopDeps["loadSegment"];
  loadHitmapElementIds: LoopDeps["loadHitmapElementIds"];
};

/** With no graph source, nothing asks for a segment or a hit map; if a caller
 * ever does, it is told plainly rather than handed a file. */
const NO_GRAPH_SOURCE = (uri: string): Promise<never> => Promise.reject(new Error(`[sk] no graph content source (packager clip path retired in S3): ${uri}`));

/** The router (Haiku) and teacher (Sonnet) providers, lazily; {} when Claude is not configured. */
export function providers(): Pick<SkDeps, "routerProvider" | "teacherProvider"> {
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
export function persistence(): Pick<SkDeps, "store" | "items" | "entitlements"> {
  if (process.env.SK_STORE === "supabase") {
    const db = skDbFrom(createAdminClient());
    // The stand-in chapter's string ids fall through to the static items (live fix 2026-10-27).
    // B8: the same admin client reads entitlements, profiles.school_id and book_access_grants, and writes sk_usage.
    return { store: new SupabaseSessionStore(db), items: new CompositeItemBank(new SupabaseItemBank(db), new StaticItemBank(), (id) => UUID_RE.test(id)), entitlements: new SupabaseEntitlements(db) };
  }
  // No database: no entitlement source — the loop's dev-flag (everything granted, usage counted in memory only).
  return { store: new InMemorySessionStore(), items: new StaticItemBank() };
}

/** S3: the product → kit map (0170, service-role only) with the production
 * entitlement source. Callers run gate() first; canOpenKit() then decides the kit. */
export function productKits(): ProductKits {
  const db = skDbFrom(createAdminClient());
  return new ProductKits(db, new SupabaseEntitlements(db));
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
      const base: SkDeps = {
        ...persistence(),
        allowanceEnforced: skAllowanceEnforced(),
        graphs: [],
        loadSegment: NO_GRAPH_SOURCE,
        loadHitmapElementIds: NO_GRAPH_SOURCE,
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
  return { store: d.store, items: d.items, graph, routerProvider: d.routerProvider, teacherProvider: d.teacherProvider, retrieval: d.retrieval, loadSegment: d.loadSegment, loadHitmapElementIds: d.loadHitmapElementIds, entitlements: d.entitlements, allowanceEnforced: d.allowanceEnforced };
}

// ── Gate + auth, shared by every route ──────────────────────────────────────
/** SK B9: which server-side voice speaks SK's own lines. Unset (the default)
 * = none: POST /api/sk/speak answers 404 and the client stays on the browser
 * voice, so merging the adapter switches nothing chargeable on. */
export function skTtsMode(): "polly" | "off" {
  return process.env.SK_TTS === "polly" ? "polly" : "off";
}

let speechOverride: SpeechProvider | null | undefined;
let speechSingleton: PollySpeechProvider | null = null;

/** The provider behind /api/sk/speak, or null when SK_TTS is unset. One
 * Polly client per process (its credential exchange is the shared cache). */
export function skSpeech(): SpeechProvider | null {
  if (speechOverride !== undefined) return speechOverride;
  if (skTtsMode() !== "polly") return null;
  if (!speechSingleton) speechSingleton = new PollySpeechProvider();
  return speechSingleton;
}

export function __setSkSpeechForTests(p: SpeechProvider | null | undefined): void {
  speechOverride = p;
}

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
