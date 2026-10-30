// SK S7 K2 — sourcesFor: the knowledge sources ONE user may use, decided in
// the app (sk_search_knowledge never decides access; it searches exactly the
// list it is handed). Server-only by use: it takes the service-role client and
// is reached only from SK capabilities behind the route's gate.
//
//   sketchcast_book  products whose LIVE release is a FINAL (release_kind
//                    'final', a release_id, approved, linked to a work) and
//                    where skAccess(user, product).book_access is true: a
//                    purchase, code, edition-code or staff grant, a school
//                    licence, or a subscription. NEVER a draft (founder
//                    2026-10-30: "completed books only, no drafts"). A
//                    parent acting for ONE verified child (S4's verified-link
//                    rule, child-scope.ts) also gets that child's books.
//   article          every approved current article ("free ready-made") for
//                    any signed-in user — ONE wildcard entry (id "*"); the
//                    caller passes the RPC's `{kind: 'article'}` with no id.
//   user_book        the books RLS lets this user read (books_read: her own
//                    and the school shelf), read through the SESSION client so
//                    RLS decides, minus removed books and junk-gated books
//                    nobody confirmed (user-books.ts bookExcluded).
//
// Cached per turn (SkCapabilityDeps.cache, keys carry the user and child id).
// A failed read of one kind leaves that kind out (fail closed) and is logged.

import { isGated, type GateHealth } from "@/utils/junk-gate";
import { skAccess, type Grant, type Subscription } from "@/sk/access";
import { SCHOOL_PLAN_KEYS, rowActive } from "@/sk/entitlement";
import { memo } from "@/sk/capabilities/shared";
import { isVerifiedChild } from "@/sk/capabilities/child-scope";
import type { SkCapabilityDeps, SkContext } from "@/sk/shell/types";
import type { KnowledgeDb, SourceKind } from "./store";
import { normLanguage } from "./text";

export const ARTICLE_WILDCARD = "*";

export type KnowledgeSourceRef = {
  kind: SourceKind;
  /** work_uid / books.id; "*" for every article. */
  id: string;
  /** sketchcast_book: the live final's release id (blocks are versioned by it). */
  version?: string;
  /** The source's language when known (null: an upload with no language set). */
  language: string | null;
  title: string;
  /** sketchcast_book only: the product it belongs to (metering, the kit's own book). */
  product?: { id: string; slug: string };
  /** sketchcast_book only: whose access opened it. */
  via?: "self" | "child";
};

export type SourcesDeps = Pick<SkCapabilityDeps, "session" | "now" | "cache">;
export type SourcesOptions = {
  /** A parent acting for this child: honoured only for one of her VERIFIED children. */
  forChildId?: string | null;
};

type ProductRow = { id: string; slug: string; title: string | null; status: string | null; work_uid: string | null; language: string | null; release_id: number | string | null; release_kind: string | null };
type EntRow = { plan_key: string | null; active: boolean | null; current_period_end: string | null };
type GrantRow = { product_id: string; source?: string | null; activated_at: string | null; expires_at: string | null; tutor_expires_at: string | null; revoked_at: string | null; usage_allowance: Grant["usage_allowance"] };
type BookRow = { id: string; title: string | null; language: string | null; removed_at: string | null; health: GateHealth };

const warn = (what: string, e: unknown) => console.error(`[sk knowledge] sources: ${what}:`, e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));

/** A product that may be a knowledge source at all: a live FINAL, never a draft. */
export function finalProduct(p: ProductRow): boolean {
  return p.status === "approved" && p.release_kind === "final" && p.release_id != null && !!p.work_uid;
}

/** The FINAL products as the service role reads them (0174's columns). */
async function finalProducts(admin: KnowledgeDb): Promise<ProductRow[]> {
  const { data, error } = await admin
    .from("sk_book_products")
    .select("id, slug, title, status, work_uid, language, release_id, release_kind")
    .eq("status", "approved")
    .eq("release_kind", "final")
    .not("release_id", "is", null)
    .not("work_uid", "is", null);
  if (error) {
    // 0174 not applied (42703 / schema cache): there are no finals to offer yet
    warn("sk_book_products", error);
    return [];
  }
  return ((data ?? []) as ProductRow[]).filter(finalProduct);
}

/** One person's access rows (skAccess's inputs), read with the service role
 *  exactly as entitlement.ts SupabaseEntitlements reads them, for ALL products. */
async function accessRows(admin: KnowledgeDb, userId: string, schoolId: string | null, now: Date): Promise<{ schoolLicence: boolean; subscriptions: Subscription[]; grants: Grant[] }> {
  const [own, school, grants] = await Promise.all([
    admin.from("entitlements").select("plan_key, active, current_period_end").eq("user_id", userId),
    schoolId ? admin.from("entitlements").select("plan_key, active, current_period_end").eq("school_id", schoolId).in("plan_key", SCHOOL_PLAN_KEYS) : Promise.resolve({ data: [], error: null }),
    admin.from("book_access_grants").select("product_id, source, activated_at, expires_at, tutor_expires_at, revoked_at, usage_allowance").eq("user_id", userId),
  ]);
  if (own.error) throw new Error(`entitlements: ${own.error.message}`);
  if (school.error) throw new Error(`school licence: ${school.error.message}`);
  if (grants.error) throw new Error(`book_access_grants: ${grants.error.message}`);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    subscriptions: ((own.data ?? []) as EntRow[]).map((r) => ({ plan_key: String(r.plan_key ?? ""), active: r.active === true, current_period_end: str(r.current_period_end) })),
    schoolLicence: ((school.data ?? []) as EntRow[]).some((r) => rowActive({ active: r.active === true, current_period_end: str(r.current_period_end) }, now)),
    grants: ((grants.data ?? []) as GrantRow[]).map((r) => ({
      product_id: String(r.product_id),
      source: str(r.source) ?? undefined,
      activated_at: String(r.activated_at ?? ""),
      expires_at: str(r.expires_at),
      tutor_expires_at: str(r.tutor_expires_at),
      revoked_at: str(r.revoked_at),
      usage_allowance: r.usage_allowance ?? null,
    })),
  };
}

/** The finals this person's access opens (book_access, as skAccess decides it). */
async function booksFor(admin: KnowledgeDb, products: ProductRow[], userId: string, schoolId: string | null, now: Date, via: "self" | "child"): Promise<KnowledgeSourceRef[]> {
  if (!products.length) return [];
  const rows = await accessRows(admin, userId, schoolId, now);
  return products
    .filter((p) => skAccess({ productId: p.id, now, schoolLicence: rows.schoolLicence, subscriptions: rows.subscriptions, grants: rows.grants }).book_access)
    .map((p) => ({
      kind: "sketchcast_book" as const,
      id: String(p.work_uid),
      version: String(p.release_id),
      language: normLanguage(p.language),
      title: p.title?.trim() || p.slug,
      product: { id: p.id, slug: p.slug },
      via,
    }));
}

/** The uploads RLS shows this user (own + school shelf), usable as knowledge. */
async function uploadsFor(session: SourcesDeps["session"], admin: KnowledgeDb | null): Promise<KnowledgeSourceRef[]> {
  const { data, error } = await session.from("books").select("id, title, language, removed_at, health").is("removed_at", null);
  if (error) throw new Error(`books: ${error.message}`);
  const books = ((data ?? []) as BookRow[]).filter((b) => !b.removed_at);
  // Junk-gated books count only once a teacher confirmed one (a generation
  // stamped params.junk_gate, utils/junk-gate.ts stampConfirmation). The
  // stamp may be on a shelf colleague's generation, which her session cannot
  // see, so the ids are checked with the service role — it only NARROWS.
  const gated = books.filter((b) => isGated(b.health)).map((b) => String(b.id));
  const confirmed = new Set<string>();
  if (gated.length) {
    const db = admin ?? session;
    const r = await db.from("generations").select("book_id").in("book_id", gated).not("params->junk_gate", "is", null);
    if (r?.error) warn("junk-gate confirmations", r.error);
    for (const g of (r?.data ?? []) as { book_id: string }[]) confirmed.add(String(g.book_id));
  }
  return books
    .filter((b) => !isGated(b.health) || confirmed.has(String(b.id)))
    .map((b) => ({ kind: "user_book" as const, id: String(b.id), language: normLanguage(b.language), title: b.title?.trim() || "Untitled book" }));
}

const ARTICLES: KnowledgeSourceRef = { kind: "article", id: ARTICLE_WILDCARD, language: null, title: "SketchCast articles" };

/**
 * The sources this user may search this turn. `admin` is the service-role
 * client (products, grants, licences); null → no SketchCast books (fail
 * closed). Uploads go through `deps.session` (RLS).
 */
export async function sourcesFor(ctx: SkContext, admin: KnowledgeDb | null, deps: SourcesDeps, opts: SourcesOptions = {}): Promise<KnowledgeSourceRef[]> {
  const me = ctx.user.id;
  if (!me) return [];
  const child = opts.forChildId && ctx.user.role === "parent" && isVerifiedChild(ctx, opts.forChildId) ? (ctx.children ?? []).find((c) => c.id === opts.forChildId) ?? null : null;
  return memo(deps, `knowledge:sources:${me}:${child?.id ?? "-"}`, async () => {
    const out: KnowledgeSourceRef[] = [];
    if (admin) {
      try {
        const products = await finalProducts(admin);
        const mine = await booksFor(admin, products, me, ctx.user.schoolId, deps.now, "self");
        out.push(...mine);
        if (child) {
          const theirs = await booksFor(admin, products, child.id, child.schoolId, deps.now, "child");
          for (const s of theirs) if (!out.some((o) => o.kind === s.kind && o.id === s.id)) out.push(s);
        }
      } catch (e) {
        warn("sketchcast books", e);
      }
    }
    out.push(ARTICLES);
    try {
      out.push(...(await uploadsFor(deps.session, admin)));
    } catch (e) {
      warn("uploads", e);
    }
    return out;
  });
}

/** The RPC's p_sources for a list (the article wildcard → no id). */
export function rpcSources(list: KnowledgeSourceRef[]): Array<{ kind: SourceKind; id?: string; version?: string }> {
  return list.map((s) => ({ kind: s.kind, ...(s.id && s.id !== ARTICLE_WILDCARD ? { id: s.id } : {}), ...(s.version ? { version: s.version } : {}) }));
}
