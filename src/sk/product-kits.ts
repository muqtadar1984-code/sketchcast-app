// SK S3 slice A — the book product → chapter → kit map (migration 0170
// `sk_product_kits`) and the one entitlement rule over it.
// SERVER ONLY: it reads through the service-role client (0170 grants nothing
// to anon/authenticated), so it must never be imported by client code.
//
// THE RULE (design decision 2): a user may open a kit in the student tutor
// when BOTH hold —
//   1. the existing product entitlement says book_access (entitlement.ts →
//      access.ts skAccess: a live book grant ONLY, staff grants included —
//      a school licence or SK subscription opens tutoring, never a book), and
//   2. the generation is mapped to THAT product in sk_product_kits, and is
//      still a done, non-withdrawn, non-removed presentation.
// A book grant therefore opens the mapped kits ONLY inside /sk. Nothing here
// touches the Library or catalogue unlocks (presentAccess, catalogue gates).
//
// The product may be named by its uuid (sk_product_kits.product_id,
// book_access_grants.product_id) or by its slug (the /sk/[product] route and
// the teaching graphs); productRow() resolves either.

import { UUID_RE } from "./ids";
import { decideAccess, type EntitlementSource } from "./entitlement";
import type { DbRow, SkDb } from "./store-supabase";

export type ProductRef = { id: string; slug: string };

export type ProductKit = {
  chapterRef: string;
  sort: number;
  generationId: string;
  /** The map's own short name (sk_product_kits.label); null when unset. */
  label: string | null;
  /** generations.title of the kit. */
  title: string;
};

export type EntitledDecision =
  | { ok: true; product: ProductRef; grantSource: string | null; source: string | null }
  | { ok: false; reason: "unknown_product" | "not_entitled" };

export type KitDecision =
  | { ok: true; product: ProductRef; kit: ProductKit; grantSource: string | null; source: string | null }
  | { ok: false; reason: "unknown_product" | "not_entitled" | "not_mapped" };

function fail(error: { message: string; code?: string } | null | undefined, what: string): void {
  if (error) throw new Error(`[sk product-kits] ${what}: ${error.message}${error.code ? ` (${error.code})` : ""}`);
}

/** Chapter refs compare as numbers when both are numeric ("2" before "10"), else as text. */
export function compareChapterRef(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortKits(kits: ProductKit[]): ProductKit[] {
  return kits.slice().sort((x, y) => compareChapterRef(x.chapterRef, y.chapterRef) || x.sort - y.sort || (x.generationId < y.generationId ? -1 : 1));
}

export class ProductKits {
  constructor(
    private readonly db: SkDb,
    private readonly entitlements: EntitlementSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The product row by uuid or slug; null when there is none. */
  async productRow(product: string): Promise<ProductRef | null> {
    const col = UUID_RE.test(product) ? "id" : "slug";
    const { data, error } = await this.db.from("sk_book_products").select("id, slug").eq(col, product).maybeSingle();
    fail(error, "product");
    return data ? { id: String(data.id), slug: String(data.slug) } : null;
  }

  /** Every kit mapped to the product, ordered by chapter then sort. Kits whose
   * generation is no longer a done, live presentation are left out. */
  async kitsForProduct(product: string): Promise<ProductKit[]> {
    const p = await this.productRow(product);
    return p ? this.kitsOf(p.id) : [];
  }

  /** The kits of one chapter, in sort order (a chapter may have several — the
   * Biology book's chapter 8 has three). Empty = the chapter has no kit. */
  async kitForChapter(product: string, chapterRef: string | number): Promise<ProductKit[]> {
    const ref = String(chapterRef);
    return (await this.kitsForProduct(product)).filter((k) => k.chapterRef === ref);
  }

  /** Half 1 of THE RULE alone: does this user have book access to the
   * product? Slice B asks this BEFORE listing a product's kits, so an
   * unentitled user learns nothing about the map (not even its chapters). */
  async entitled(userId: string, product: string): Promise<EntitledDecision> {
    const p = await this.productRow(product);
    if (!p) return { ok: false, reason: "unknown_product" };
    const rows = await this.entitlements.load(userId, p.slug, this.now());
    const access = decideAccess(rows, null, { now: this.now(), allowanceEnforced: false });
    if (!access.decision.book_access || rows.productId !== p.id) return { ok: false, reason: "not_entitled" };
    return { ok: true, product: p, grantSource: access.decision.grant_source, source: access.decision.source };
  }

  /** May this user open this kit in the student tutor? See THE RULE above. */
  async canOpenKit(userId: string, product: string, generationId: string): Promise<KitDecision> {
    // Entitlement first: an unentitled user learns nothing about the map.
    const e = await this.entitled(userId, product);
    if (!e.ok) return e;
    const p = e.product;
    if (!UUID_RE.test(generationId)) return { ok: false, reason: "not_mapped" };
    const kit = (await this.kitsOf(p.id, generationId))[0];
    if (!kit) return { ok: false, reason: "not_mapped" };
    return { ok: true, product: p, kit, grantSource: e.grantSource, source: e.source };
  }

  private async kitsOf(productId: string, onlyGeneration?: string): Promise<ProductKit[]> {
    let q = this.db.from("sk_product_kits").select("chapter_ref, sort, generation_id, label").eq("product_id", productId);
    if (onlyGeneration) q = q.eq("generation_id", onlyGeneration);
    const { data: map, error } = await q;
    fail(error, "sk_product_kits");
    const rows = (map ?? []) as DbRow[];
    if (!rows.length) return [];
    const ids = Array.from(new Set(rows.map((r) => String(r.generation_id))));
    const { data: gens, error: gErr } = await this.db.from("generations").select("id, title, kind, status, withdrawn_at, removed_at").in("id", ids);
    fail(gErr, "generations");
    const live = new Map(
      ((gens ?? []) as DbRow[])
        .filter((g) => g.kind === "presentation" && g.status === "done" && !g.withdrawn_at && !g.removed_at)
        .map((g) => [String(g.id), String(g.title ?? "")] as const),
    );
    return sortKits(
      rows
        .filter((r) => live.has(String(r.generation_id)))
        .map((r) => ({
          chapterRef: String(r.chapter_ref),
          sort: Number(r.sort ?? 0),
          generationId: String(r.generation_id),
          label: typeof r.label === "string" && r.label ? r.label : null,
          title: live.get(String(r.generation_id)) ?? "",
        })),
    );
  }
}
