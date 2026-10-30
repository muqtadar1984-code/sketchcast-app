// SK S3 slice B — server wiring for the student kit routes (/api/sk/kit*).
// Never imported by client code.
//
// THE ORDER EVERY KIT ROUTE RUNS (design slice B; Final Plan §8.1):
//   1. gate()                     FEATURE_SK, skAccessAllowed, signed in (server.ts)
//   2. kits.entitled()            book access to the product — before the map
//                                 is read, so an unentitled user learns nothing
//   3. kits.kitForChapter()       the chapter's mapped kits (chapter 8 has three)
//   4. kits.canOpenKit()          entitlement AND mapping for the chosen kit
//   5. admin()                    ONLY NOW the service-role client is made, for
//                                 the kit map (sk_manifests), the artifacts rows
//                                 and the signed video URL.
// The video is signed through this rule, never through presentAccess (which
// refuses students and stays as it is).
//
// Everything a test replaces goes through __setKitDepsForTests.

import { createAdminClient } from "@/utils/supabase/admin";
import { skAllowanceEnforced } from "@/utils/flags";
import { signKitVideos, type SignAdmin } from "@/utils/present/sign";
import type { LLMProvider } from "@/utils/assistant/provider";
import type { EntitlementSource } from "./entitlement";
import { SupabaseEntitlements } from "./entitlement";
import { noteLearning, type FactsDb, type LearningNote } from "./facts";
import type { ItemBank } from "./items";
import { SupabaseItemBank } from "./items-supabase";
import type { KitRefusal, KitReply } from "./kit-player";
import { kitList, kitView, mergeChapters, type ChapterEntry } from "./kit-view";
import type { KitManifest } from "./manifest/derive";
import { deriveAndStore } from "./manifest/service";
import { readManifest, type ReadResult, type StoreAdmin } from "./manifest/store";
import { ProductKits, type ProductKit, type ProductRef } from "./product-kits";
import { SupabaseRemediationBank, type RemediationBank } from "./remediation-bank";
import { persistence, providers, translateProvider } from "./server";
import type { SessionStore } from "./store";
import { skDbFrom } from "./store-supabase";

/** Short-lived on purpose: a student's tab, not a classroom panel (the Present
 *  route's 8 h is for a Board woken at 07:00). The player asks again on error. */
export const KIT_VIDEO_TTL_S = 60 * 60;

export type KitAdmin = StoreAdmin & SignAdmin;

export type KitDeps = {
  kits: Pick<ProductKits, "entitled" | "kitsForProduct" | "kitForChapter" | "canOpenKit">;
  /** The service-role client for sk_manifests, artifacts and storage. Called
   *  only after canOpenKit said yes. */
  admin: () => KitAdmin;
  read: (admin: KitAdmin, generationId: string) => Promise<ReadResult>;
  derive: (admin: KitAdmin, generationId: string) => Promise<ReadResult>;
  /** The kit's bank items (topic_questions), for practise and marking. */
  items: (admin: KitAdmin) => ItemBank;
  /** The remediation ladder's bank facts (rationale, misconceptions, explanation). */
  bank: (admin: KitAdmin) => RemediationBank;
  /** sk_usage (metering), the turn's replay guard, and (slice C) the kit
   *  sessions, attempts and objective mastery. */
  store: SessionStore;
  entitlements?: EntitlementSource;
  allowanceEnforced?: boolean;
  teacherProvider?: LLMProvider;
  /** 2026-10-30: "repeat that in X" — the re-expression model (Haiku 5.5). */
  translateProvider?: LLMProvider;
  now?: () => number;
  /** S6: remember a learning fact about the student (facts.ts noteLearning:
   *  `transcripts` consent first, a no-op without it). Absent → nothing kept. */
  noteLearning?: (admin: KitAdmin, studentId: string, note: LearningNote) => Promise<unknown>;
};

let real: KitDeps | null = null;
let override: Partial<KitDeps> | null = null;

function realDeps(): KitDeps {
  if (!real) {
    // The store and entitlements are the loop's own (SK_STORE=supabase → the
    // 0157 tables and sk_usage; unset → in-memory, the dev-flag, nothing metered).
    const p = persistence();
    let adminClient: KitAdmin | null = null;
    real = {
      kits: {
        // Built per call: the map is service-role only (0170) and the client is cheap.
        entitled: (u, pr) => kitsReader().entitled(u, pr),
        kitsForProduct: (pr) => kitsReader().kitsForProduct(pr),
        kitForChapter: (pr, ch) => kitsReader().kitForChapter(pr, ch),
        canOpenKit: (u, pr, g) => kitsReader().canOpenKit(u, pr, g),
      },
      admin: () => (adminClient ??= createAdminClient() as unknown as KitAdmin),
      read: (a, g) => readManifest(a, g),
      derive: (a, g) => deriveAndStore(a as unknown as Parameters<typeof deriveAndStore>[0], g),
      items: (a) => new SupabaseItemBank(skDbFrom(a as unknown as Parameters<typeof skDbFrom>[0])),
      bank: (a) => new SupabaseRemediationBank(skDbFrom(a as unknown as Parameters<typeof skDbFrom>[0])),
      store: p.store,
      entitlements: p.entitlements,
      allowanceEnforced: skAllowanceEnforced(),
      noteLearning: (a, studentId, note) => noteLearning(a as unknown as FactsDb, studentId, note),
      ...providers(),
      translateProvider: translateProvider(),
    };
  }
  return real;
}

function kitsReader(): ProductKits {
  const db = skDbFrom(createAdminClient());
  return new ProductKits(db, new SupabaseEntitlements(db));
}

export function kitDeps(): KitDeps {
  return { ...realDeps(), ...(override ?? {}) } as KitDeps;
}

/** Tests: replace any part of the wiring; `null` resets to the real thing. */
export function __setKitDepsForTests(d: Partial<KitDeps> | null): void {
  override = d;
  if (d === null) real = null;
}

// ── the request ─────────────────────────────────────────────────────────────

const PRODUCT_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
const CHAPTER_RE = /^[A-Za-z0-9._-]{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KitQuery = { product: string; chapter: string; kit: string | null };

/** product + chapter (+ kit) from a URL or a JSON body; null when malformed. */
export function parseKitQuery(src: { product?: unknown; chapter?: unknown; kit?: unknown }): KitQuery | null {
  const product = typeof src.product === "string" ? src.product.trim() : "";
  const chapter = typeof src.chapter === "string" || typeof src.chapter === "number" ? String(src.chapter).trim() : "";
  const kit = typeof src.kit === "string" && src.kit.trim() ? src.kit.trim() : null;
  if (!PRODUCT_RE.test(product) || !CHAPTER_RE.test(chapter)) return null;
  if (kit !== null && !UUID.test(kit)) return null;
  return { product, chapter, kit };
}

export const REFUSAL_TEXT: Record<KitRefusal, string> = {
  unknown_product: "There is no such book.",
  not_entitled: "You don't have access to this book.",
  not_mapped: "That lesson is not part of this chapter of the book.",
  no_kit: "This chapter has no lesson yet.",
};

export type Resolved =
  | { ok: true; product: ProductRef; kits: ProductKit[]; kit: ProductKit }
  | { ok: false; status: number; reason: KitRefusal; error: string };

const refuse = (reason: KitRefusal): Resolved => ({ ok: false, status: reason === "not_entitled" ? 403 : 404, reason, error: REFUSAL_TEXT[reason] });

/** Steps 2–4 above. */
export async function resolveKit(deps: KitDeps, userId: string, q: KitQuery): Promise<Resolved> {
  const e = await deps.kits.entitled(userId, q.product);
  if (!e.ok) return refuse(e.reason);
  const kits = await deps.kits.kitForChapter(e.product.id, q.chapter);
  if (!kits.length) return refuse("no_kit");
  const chosen = q.kit ? kits.find((k) => k.generationId === q.kit) : kits[0];
  if (!chosen) return refuse("not_mapped");
  const d = await deps.kits.canOpenKit(userId, e.product.id, chosen.generationId);
  if (!d.ok) return refuse(d.reason);
  return { ok: true, product: d.product, kits, kit: d.kit };
}

/** Step 5: the kit map, read (GET) or built on first open (POST, as the Board
 *  does), and the reply. A first build answers `preparing`; the player polls. */
export async function kitReply(deps: KitDeps, r: Extract<Resolved, { ok: true }>, mode: "read" | "build"): Promise<KitReply> {
  const admin = deps.admin();
  const head = { kits: kitList(r.kits), kit: { generationId: r.kit.generationId, title: r.kit.title } };
  const m = mode === "build" ? await deps.derive(admin, r.kit.generationId) : await deps.read(admin, r.kit.generationId);
  if (m.status === "failed") return { status: "unavailable", ...head, reason: "map_failed" };
  if (m.status !== "ready") return { status: "preparing", ...head };
  const { data, error } = await admin.from("artifacts").select("kind, storage_path").eq("generation_id", r.kit.generationId);
  if (error) throw new Error(`[sk kit] artifacts: ${(error as { message?: string }).message ?? "unknown"}`);
  const videos = await signKitVideos(admin, (data ?? []) as { kind: string; storage_path: string }[], KIT_VIDEO_TTL_S);
  return { status: "ready", kits: head.kits, kit: kitView(m.manifest, r.kit, videos) };
}

/** For the moves (items, answer, explain): the READY map, or null (the player
 *  shows "preparing" and nothing is taught from a map that is not ready). */
export async function readyManifest(deps: KitDeps, r: Extract<Resolved, { ok: true }>): Promise<{ admin: KitAdmin; manifest: KitManifest } | null> {
  const admin = deps.admin();
  const m = await deps.read(admin, r.kit.generationId);
  return m.status === "ready" ? { admin, manifest: m.manifest } : null;
}

// ── the chapter lists (/sk, /sk/[product]) and the chapter page ─────────────

/** The product's chapters for this user: its mapped kits when the user is
 *  entitled (an unentitled user sees none of the map). A map that cannot be
 *  read (0170 not applied yet) lists nothing, logged. */
export async function chaptersFor(userId: string, productSlug: string): Promise<ChapterEntry[]> {
  const deps = kitDeps();
  let kits: ProductKit[] = [];
  try {
    const e = await deps.kits.entitled(userId, productSlug);
    if (e.ok) kits = await deps.kits.kitsForProduct(e.product.id);
  } catch (err) {
    console.error("[sk] kit map unavailable:", (err as Error).message);
  }
  return mergeChapters(kits);
}

/** Does this chapter have a mapped kit? Decides, on the server, whether the
 *  chapter page mounts the kit player (which then asks the API, where every
 *  refusal is made) or "no lesson yet". False when the map cannot be read. */
export async function chapterHasKit(productSlug: string, chapterRef: string): Promise<boolean> {
  try {
    return (await kitDeps().kits.kitForChapter(productSlug, chapterRef)).length > 0;
  } catch (err) {
    console.error("[sk] kit map unavailable:", (err as Error).message);
    return false;
  }
}
