// SK B8 — where the rows skAccess() decides over come from, and the one
// decision the loop makes from them. access.ts is pure (rows in, decision
// out); this module is the seam that LOADS the rows for a student and a
// product, with two implementations:
//
//   SupabaseEntitlements  the production source (SK_STORE=supabase):
//                         `entitlements` (the user's own plan rows — the same
//                         table utils/stripe/entitlements.ts reads), the
//                         student's school through `profiles.school_id` and
//                         the school's school_* entitlement rows, and the
//                         student's `book_access_grants` for the product.
//                         Grants are keyed on `sk_book_products.id` (a uuid)
//                         while the loop knows the product by its SLUG, so
//                         the product row is read first and the uuid is what
//                         the grants are filtered — and usage is keyed — by.
//   StaticEntitlements    fixed rows (tests; the in-memory dev wiring when it
//                         wants to act out a licence state).
//
// No entitlement source at all (LoopDeps.entitlements undefined) is the
// B4 dev-flag: everything is granted, nothing is metered — the behaviour the
// in-memory wiring has always had. server.ts wires the Supabase source
// whenever the Supabase store is on, so production never runs on the flag.

import { allowanceWarning, skAccess, type AccessDecision, type AccessInput, type Grant, type Subscription, type Usage } from "./access";
import type { SkDb } from "./store-supabase";
import type { UsageRow } from "./store";

/** What skAccess needs, loaded for one student × one product. */
export type AccessRows = {
  /** The id grants carry and usage is keyed on — the product's uuid on
   * Supabase, the slug on the static source; null when the product is unknown
   * to the source (no grant can exist, nothing can be metered). */
  productId: string | null;
  schoolLicence: boolean;
  subscriptions: Subscription[];
  grants: Grant[];
};

export interface EntitlementSource {
  load(studentId: string, productSlug: string, now: Date): Promise<AccessRows>;
}

/** 'YYYY-MM' in UTC — the sk_usage period (0158). */
export function periodOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** The subscription-row liveness rule utils/stripe/entitlements.ts applies
 * (deriveActive): the webhook's `active`, re-checked against the period end. */
export function rowActive(row: { active: boolean; current_period_end: string | null }, now: Date): boolean {
  if (!row.active) return false;
  if (row.current_period_end && new Date(row.current_period_end).getTime() < now.getTime()) return false;
  return true;
}

export const SCHOOL_PLAN_KEYS = ["school_annual", "school_onetime"] as const;

// ── The decision the loop carries ───────────────────────────────────────────
export type SessionAccess = {
  decision: AccessDecision;
  warning: ReturnType<typeof allowanceWarning>;
  /** True on the dev-flag (no entitlement source): granted, unmetered. */
  devFlag: boolean;
  /** FEATURE_SK_ALLOWANCE as the decision saw it. */
  enforced: boolean;
  period: string;
  /** Where a live turn is counted: (studentId, usageKey, period). Null = nowhere (unknown product, or the dev-flag). */
  usageKey: string | null;
  input: AccessInput | null;
};

const GRANT_ALL: AccessDecision = { book_access: true, tutor_access: true, source: null, grant_source: null, tutor_expires_at: null, allowance_remaining: null, live_exhausted: false, live_used_fraction: null };

export function devFlagAccess(now: Date): SessionAccess {
  return { decision: GRANT_ALL, warning: "none", devFlag: true, enforced: false, period: periodOf(now), usageKey: null, input: null };
}

export function decideAccess(rows: AccessRows, usage: UsageRow | null, opts: { now: Date; allowanceEnforced: boolean }): SessionAccess {
  const input: AccessInput = {
    productId: rows.productId ?? "",
    now: opts.now,
    schoolLicence: rows.schoolLicence,
    subscriptions: rows.subscriptions,
    grants: rows.grants,
    usage: usage ? { live_turns: usage.live_turns, generated_segments: usage.generated_segments } : undefined,
    allowanceEnforced: opts.allowanceEnforced,
  };
  const decision = skAccess(input);
  return { decision, warning: allowanceWarning(decision.live_used_fraction), devFlag: false, enforced: opts.allowanceEnforced, period: periodOf(opts.now), usageKey: rows.productId, input };
}

/** The same rows, decided again over the usage a bump just returned. */
export function redecide(a: SessionAccess, usage: Usage): SessionAccess {
  if (!a.input) return a;
  const decision = skAccess({ ...a.input, usage });
  return { ...a, decision, warning: allowanceWarning(decision.live_used_fraction) };
}

/** Live turns (free-text questions, asides) are allowed now. Prepared
 * teaching, checks and practice never depend on this. */
export function liveAllowed(a: SessionAccess): boolean {
  return a.decision.tutor_access && !a.decision.live_exhausted;
}

// ── Static source ───────────────────────────────────────────────────────────
export class StaticEntitlements implements EntitlementSource {
  constructor(private readonly rows: Partial<AccessRows> | ((studentId: string, productSlug: string) => Partial<AccessRows>)) {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the clock is the interface's; fixed rows do not read it
  async load(studentId: string, productSlug: string, _now?: Date): Promise<AccessRows> {
    const r = typeof this.rows === "function" ? this.rows(studentId, productSlug) : this.rows;
    return { productId: r.productId === undefined ? productSlug : r.productId, schoolLicence: !!r.schoolLicence, subscriptions: r.subscriptions ?? [], grants: r.grants ?? [] };
  }
}

// ── Supabase source ─────────────────────────────────────────────────────────
type ErrorLike = { message: string; code?: string } | null | undefined;
function fail(error: ErrorLike, what: string): void {
  if (error) throw new Error(`[sk access] ${what}: ${error.message}${error.code ? ` (${error.code})` : ""}`);
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export class SupabaseEntitlements implements EntitlementSource {
  constructor(private readonly db: SkDb) {}

  async load(studentId: string, productSlug: string, now: Date): Promise<AccessRows> {
    const [product, own, profile] = await Promise.all([
      this.db.from("sk_book_products").select("id").eq("slug", productSlug).maybeSingle(),
      this.db.from("entitlements").select("plan_key, active, current_period_end").eq("user_id", studentId),
      this.db.from("profiles").select("school_id").eq("id", studentId).maybeSingle(),
    ]);
    fail(product.error, "product");
    fail(own.error, "subscriptions");
    fail(profile.error, "profile");
    const productId = str(product.data?.id);
    const schoolId = str(profile.data?.school_id);

    const [grants, school] = await Promise.all([
      productId ? this.db.from("book_access_grants").select("product_id, source, activated_at, expires_at, tutor_expires_at, revoked_at, usage_allowance").eq("user_id", studentId).eq("product_id", productId) : Promise.resolve({ data: [], error: null }),
      schoolId ? this.db.from("entitlements").select("plan_key, active, current_period_end").eq("school_id", schoolId).in("plan_key", SCHOOL_PLAN_KEYS) : Promise.resolve({ data: [], error: null }),
    ]);
    fail(grants.error, "grants");
    fail(school.error, "school licence");

    const subscriptions: Subscription[] = (own.data ?? []).map((r) => ({ plan_key: String(r.plan_key ?? ""), active: r.active === true, current_period_end: str(r.current_period_end) }));
    const schoolLicence = (school.data ?? []).some((r) => rowActive({ active: r.active === true, current_period_end: str(r.current_period_end) }, now));
    return {
      productId,
      schoolLicence,
      subscriptions,
      grants: (grants.data ?? []).map((r) => ({
        product_id: String(r.product_id),
        source: str(r.source) ?? undefined,
        activated_at: String(r.activated_at ?? ""),
        expires_at: str(r.expires_at),
        tutor_expires_at: str(r.tutor_expires_at),
        revoked_at: str(r.revoked_at),
        usage_allowance: (r.usage_allowance ?? null) as Grant["usage_allowance"],
      })),
    };
  }
}
