// SK S7 K3 — loads the rows decideMyBooks() decides over, for one reader.
//
// Read with the SERVICE ROLE on purpose: sk_book_products' RLS shows approved
// rows only (a withdrawn book a reader still owns would vanish) and
// pub_releases grants no client a row (0172). So every read here is narrowed
// by hand to the reader: their own entitlements and school, their own grants
// and those of their VERIFIED children (parent_links.verified_at — the reach
// the book_access_grants RLS gives a parent). Nothing here signs a link; the
// callers sign only what the decision returned.
//
// Fails CLOSED to "no books": a missing migration (0172 / 0174 not applied),
// a read error, anything — the strip is hidden and the PDF route refuses.

import { decideMyBooks, type MyBook, type MyBookGrant, type MyBookProduct, type MyBookRelease } from "./decide";
import { rowActive, SCHOOL_PLAN_KEYS } from "@/sk/entitlement";
import type { Subscription } from "@/sk/access";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The slice of a Supabase client the loader uses (structural, for fakes). */
export type MyBooksDb = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

const PRODUCT_COLS = "id, slug, title, status, work_uid, language, release_id, release_kind, cover_key";
const RELEASE_COLS = "id, work_uid, language, release_kind, title, chapter_count, digital_pdf_key, cover_key, superseded_by, withdrawn_at";
const GRANT_COLS = "user_id, product_id, source, activated_at, expires_at, tutor_expires_at, revoked_at, usage_allowance";

type Res<T> = { data: T | null; error: { message?: string; code?: string } | null };

function rows<T>(r: Res<T[]>, what: string): T[] {
  if (r.error) throw new Error(`${what}: ${r.error.message ?? r.error.code ?? "error"}`);
  return r.data ?? [];
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The reader's books (own access first, then their children's). `productId` narrows to one product (the PDF route). */
export async function loadMyBooks(db: MyBooksDb, userId: string, now: Date, opts: { productId?: string } = {}): Promise<MyBook[]> {
  try {
    let pq = db.from("sk_book_products").select(PRODUCT_COLS).not("work_uid", "is", null);
    if (opts.productId) pq = pq.eq("id", opts.productId);
    const products = rows<MyBookProduct>(await pq, "sk_book_products");
    if (!products.length) return [];

    const workUids = [...new Set(products.map((p) => p.work_uid).filter((w): w is string => !!w))];
    const releases = rows<MyBookRelease>(await db.from("pub_releases").select(RELEASE_COLS).in("work_uid", workUids), "pub_releases");
    // a draft never reaches the decision at all
    const finals = releases.filter((r) => r.release_kind === "final");
    if (!finals.length) return [];

    const [profileRes, ownRes, linksRes] = await Promise.all([
      db.from("profiles").select("school_id").eq("id", userId).maybeSingle(),
      db.from("entitlements").select("plan_key, active, current_period_end").eq("user_id", userId),
      db.from("parent_links").select("child_id").eq("parent_id", userId).not("verified_at", "is", null),
    ]);
    if (profileRes.error) throw new Error(`profiles: ${profileRes.error.message}`);
    const schoolId = str((profileRes.data as { school_id?: unknown } | null)?.school_id);
    const subscriptions: Subscription[] = rows<{ plan_key: unknown; active: unknown; current_period_end: unknown }>(ownRes, "entitlements").map((r) => ({
      plan_key: String(r.plan_key ?? ""),
      active: r.active === true,
      current_period_end: str(r.current_period_end),
    }));
    // A failed child lookup costs the family labels, never the reader's own books.
    const childIds = linksRes.error ? [] : [...new Set(((linksRes.data ?? []) as { child_id: string }[]).map((l) => l.child_id).filter(Boolean))];

    const [schoolRes, grantsRes, namesRes] = await Promise.all([
      schoolId
        ? db.from("entitlements").select("plan_key, active, current_period_end").eq("school_id", schoolId).in("plan_key", [...SCHOOL_PLAN_KEYS])
        : Promise.resolve({ data: [], error: null }),
      db.from("book_access_grants").select(GRANT_COLS).in("user_id", [userId, ...childIds]).in("product_id", products.map((p) => p.id)),
      childIds.length ? db.from("profiles").select("id, full_name, username").in("id", childIds) : Promise.resolve({ data: [], error: null }),
    ]);
    const schoolLicence = rows<{ active: unknown; current_period_end: unknown }>(schoolRes, "school entitlements").some((r) =>
      rowActive({ active: r.active === true, current_period_end: str(r.current_period_end) }, now),
    );
    const grants: MyBookGrant[] = rows<Record<string, unknown>>(grantsRes, "book_access_grants").map((r) => ({
      user_id: String(r.user_id),
      product_id: String(r.product_id),
      source: str(r.source) ?? undefined,
      activated_at: String(r.activated_at ?? ""),
      expires_at: str(r.expires_at),
      tutor_expires_at: str(r.tutor_expires_at),
      revoked_at: str(r.revoked_at),
      usage_allowance: null,
    }));
    const names = new Map(
      ((namesRes.error ? [] : namesRes.data ?? []) as { id: string; full_name: string | null; username: string | null }[]).map((p) => [
        p.id,
        (p.full_name || p.username || "").trim(),
      ]),
    );
    // A nameless child still counts; the strip says "for your child" instead.
    const children = childIds.map((id) => ({ id, name: names.get(id) || "" }));

    return decideMyBooks({ now, userId, products, releases: finals, schoolLicence, subscriptions, grants, children });
  } catch (e) {
    console.error("[sk-library] my books read failed:", (e as Error).message);
    return [];
  }
}
