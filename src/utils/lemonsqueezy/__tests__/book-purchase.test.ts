/**
 * Lemon Squeezy order → BOOK purchase (0159). The invariants:
 *   * a book is recognised by the TRUSTED product id (sk_book_products.
 *     ls_product_id), never by name; a pack order still takes the pack path;
 *     anything else is still ignored
 *   * a known buyer (custom_data.user_id) is granted at once through
 *     record_book_purchase(), with the payment recorded
 *   * a public-link purchase is PARKED by the lower-cased email (p_user NULL)
 *     with no payment row — claim.ts grants it on sign-in via
 *     claim_book_purchases()
 *   * a $0 order and an unattributable order write nothing
 *   * a refund goes through refund_book_purchase() (which revokes the grant)
 *     and flips the payment record
 *   * a database error throws so LS retries (the functions are idempotent)
 *   * the claim path is total: an rpc failure reads as 0, never throws
 * Run: npx vitest run
 */
import { describe, expect, it } from "vitest";
import { handleLsEvent, type Db, type LsEvent } from "../handlers";
import { claimLsPurchasesWith, type ClaimDb } from "../claim";

type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row | null>;
  writes: Array<{ table: string; op: "insert" | "upsert" | "update"; row: Row; filter?: [string, unknown] }> = [];
  rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  rpcResults: Record<string, unknown> = {};
  rpcErrors: Record<string, { message: string }> = {};
  constructor(tables: Record<string, Row | null> = {}) {
    this.tables = tables;
  }
  from(table: string) {
    const read = async () => ({ data: this.tables[table] ?? null });
    return {
      select: () => ({ eq: () => ({ maybeSingle: read }) }),
      upsert: async (row: Row) => {
        this.writes.push({ table, op: "upsert" as const, row });
        return { error: null };
      },
      insert: async (row: Row) => {
        this.writes.push({ table, op: "insert" as const, row });
        return { error: null };
      },
      update: (row: Row) => ({
        eq: async (col: string, v: unknown) => {
          this.writes.push({ table, op: "update" as const, row, filter: [col, v] });
          return { error: null };
        },
      }),
    };
  }
  async rpc(fn: string, args: Record<string, unknown>) {
    this.rpcs.push({ fn, args });
    const error = this.rpcErrors[fn] ?? null;
    return { data: error ? null : (this.rpcResults[fn] ?? null), error };
  }
  pay() {
    return this.writes.find((w) => w.table === "payments");
  }
}

const BOOK = { id: "prod-1", slug: "biology-7-study-guide" };

const bookOrder = (over: { event?: string; custom?: { user_id?: string } | null; email?: string | null; total?: number; tax?: number; status?: string; refunded?: boolean; productId?: number | string | null; productName?: string } = {}): LsEvent => {
  const total = over.total ?? 1900;
  const tax = over.tax ?? 0;
  return {
    meta: { event_name: over.event ?? "order_created", custom_data: over.custom === undefined ? undefined : over.custom },
    data: {
      type: "orders",
      id: "ord_book_1",
      attributes: {
        customer_id: 777,
        user_email: over.email === undefined ? null : over.email,
        status: over.status ?? "paid",
        refunded: over.refunded ?? false,
        subtotal: total - tax,
        discount_total: 0,
        tax,
        total,
        subtotal_usd: total - tax,
        discount_total_usd: 0,
        tax_usd: tax,
        total_usd: total,
        currency: "USD",
        updated_at: "2026-10-27T12:00:00Z",
        first_order_item: { product_id: over.productId === undefined ? 9001 : over.productId, variant_id: 90011, product_name: over.productName ?? "Biology Stage 7 Study Guide", variant_name: "Digital" },
      },
    },
  };
};
const run = (db: FakeDb, event: LsEvent) => handleLsEvent(db as unknown as Db, event, { planKeyForVariant: () => null });
const rpc = (db: FakeDb, fn: string) => db.rpcs.find((r) => r.fn === fn);

describe("LS order → book purchase", () => {
  it("grants a KNOWN buyer at once through record_book_purchase and records the payment", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, sk_book_products: BOOK });
    db.rpcResults.record_book_purchase = { outcome: "granted", grant: { id: "g1" } };
    await run(db, bookOrder({ custom: { user_id: "user-A" }, email: "a@x.com", total: 2044, tax: 144 }));
    const call = rpc(db, "record_book_purchase")!;
    expect(call.args).toMatchObject({ p_order_id: "ord_book_1", p_product: "prod-1", p_user: "user-A", p_email: "a@x.com", p_total_minor: 1900, p_currency: "usd", p_status: "paid", p_refunded: false, p_tutor_days: 30 });
    expect(db.writes.find((w) => w.table === "billing_customers")).toBeDefined();
    expect(db.pay()!.row).toMatchObject({ user_id: "user-A", ls_order_id: "ord_book_1", amount: 1900, currency: "usd", plan_key: "book:biology-7-study-guide", status: "paid" });
    expect(db.rpcs).toHaveLength(1);
  });
  it("PARKS a public-link purchase by the lower-cased email: p_user NULL, no payment row", async () => {
    const db = new FakeDb({ billing_customers: null, sk_book_products: BOOK });
    db.rpcResults.record_book_purchase = { outcome: "parked" };
    await run(db, bookOrder({ custom: undefined, email: "Buyer@X.com" }));
    expect(rpc(db, "record_book_purchase")!.args).toMatchObject({ p_user: null, p_email: "buyer@x.com", p_product: "prod-1" });
    expect(db.pay()).toBeUndefined();
    expect(db.writes.find((w) => w.table === "billing_customers")!.row.user_id).toBeNull();
  });
  it("a re-delivered order is reported duplicate by the function and records nothing more", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, sk_book_products: BOOK });
    db.rpcResults.record_book_purchase = { outcome: "duplicate" };
    await run(db, bookOrder({ custom: { user_id: "user-A" }, email: "a@x.com" }));
    expect(db.pay()).toBeUndefined();
  });
  it("a $0 order grants nothing and touches no table", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, sk_book_products: BOOK });
    await run(db, bookOrder({ custom: { user_id: "user-A" }, email: "a@x.com", total: 0 }));
    expect(db.rpcs).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });
  it("no identity signal at all → nothing written", async () => {
    const db = new FakeDb({ billing_customers: null, sk_book_products: BOOK });
    await run(db, bookOrder({ custom: undefined, email: null }));
    expect(db.rpcs).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });
  it("is recognised by the product id only: an order whose id maps to no book is still ignored, a pack still credits as a pack", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, sk_book_products: null });
    await run(db, bookOrder({ custom: { user_id: "user-A" }, email: "a@x.com", productName: "Biology Stage 7 Study Guide" }));
    expect(db.rpcs).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
    const noItem = new FakeDb({ billing_customers: { user_id: "user-A" }, sk_book_products: BOOK });
    await run(noItem, bookOrder({ custom: { user_id: "user-A" }, email: "a@x.com", productId: null }));
    expect(noItem.rpcs).toHaveLength(0);
    const pack = new FakeDb({ billing_customers: { user_id: "user-A" }, sk_book_products: BOOK });
    await run(pack, bookOrder({ custom: { user_id: "user-A" }, email: "a@x.com", productName: "SketchCast Credits — 1 kit (6)", total: 800 }));
    expect(pack.rpcs).toHaveLength(0);
    expect(pack.writes.find((w) => w.table === "credit_purchases")).toBeDefined();
  });
  it("order_refunded goes through refund_book_purchase (grant revoked there) and flips the payment record", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, sk_book_products: BOOK });
    db.rpcResults.refund_book_purchase = { outcome: "refunded", grant_revoked: true };
    await run(db, bookOrder({ event: "order_refunded", custom: { user_id: "user-A" }, email: "a@x.com", status: "refunded", refunded: true }));
    expect(rpc(db, "refund_book_purchase")!.args).toEqual({ p_order_id: "ord_book_1", p_product: "prod-1", p_email: "a@x.com" });
    expect(rpc(db, "record_book_purchase")).toBeUndefined();
    const pay = db.writes.find((w) => w.table === "payments" && w.op === "update")!;
    expect(pay.row.status).toBe("refunded");
    expect(pay.filter).toEqual(["ls_order_id", "ord_book_1"]);
  });
  it("an order_created already flagged refunded is recorded as refunded (the function grants nothing)", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, sk_book_products: BOOK });
    db.rpcResults.record_book_purchase = { outcome: "refunded" };
    await run(db, bookOrder({ custom: { user_id: "user-A" }, email: "a@x.com", refunded: true }));
    expect(rpc(db, "record_book_purchase")!.args.p_refunded).toBe(true);
    expect(db.pay()).toBeUndefined();
  });
  it("a database error throws so Lemon Squeezy retries", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, sk_book_products: BOOK });
    db.rpcErrors.record_book_purchase = { message: "connection reset" };
    await expect(run(db, bookOrder({ custom: { user_id: "user-A" }, email: "a@x.com" }))).rejects.toThrow(/book purchase/);
  });
});

// ── claim-on-sign-in ─────────────────────────────────────────────────────────
// A minimal ClaimDb: every table read is empty (no parked packs, invoices or
// subs), so the only thing that can bind is the book rpc.
class FakeClaimDb {
  rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  updates: Array<{ table: string; row: Row }> = [];
  rpcResult: unknown = { bound: 0 };
  rpcError: { message: string } | null = null;
  rpcThrows = false;
  from(table: string) {
    const updates = this.updates;
    const chain = (row?: Row) => {
      const t = {
        eq: () => t,
        is: () => t,
        select: () => t,
        then: (resolve: (v: unknown) => void) => {
          if (row) updates.push({ table, row });
          return resolve(row ? { data: [], error: null } : { data: [], error: null });
        },
      };
      return t;
    };
    return {
      select: () => chain(),
      update: (row: Row) => chain(row),
      upsert: async () => ({ error: null }),
      insert: async () => ({ error: null }),
    };
  }
  async rpc(fn: string, args: Record<string, unknown>) {
    if (this.rpcThrows) throw new Error("rpc exploded");
    this.rpcs.push({ fn, args });
    return { data: this.rpcError ? null : this.rpcResult, error: this.rpcError };
  }
}

describe("claim-on-sign-in → book purchases", () => {
  it("binds parked books by the VERIFIED, lower-cased email through claim_book_purchases and updates the customer mapping", async () => {
    const db = new FakeClaimDb();
    db.rpcResult = { bound: 2 };
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "Buyer@X.com");
    expect(db.rpcs).toEqual([{ fn: "claim_book_purchases", args: { p_user: "user-A", p_email: "buyer@x.com", p_tutor_days: 30, p_allowance: null } }]);
    expect(db.updates.find((u) => u.table === "billing_customers")).toBeDefined();
  });
  it("binds nothing when nothing is parked, and never throws on an rpc failure", async () => {
    const quiet = new FakeClaimDb();
    await claimLsPurchasesWith(quiet as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect(quiet.updates.find((u) => u.table === "billing_customers")).toBeUndefined();
    const failing = new FakeClaimDb();
    failing.rpcError = { message: "function missing" };
    await expect(claimLsPurchasesWith(failing as unknown as ClaimDb, "user-A", "buyer@x.com")).resolves.toBe(0);
    const throwing = new FakeClaimDb();
    throwing.rpcThrows = true;
    await expect(claimLsPurchasesWith(throwing as unknown as ClaimDb, "user-A", "buyer@x.com")).resolves.toBe(0);
  });
  it("no-ops without a user or a verified email", async () => {
    const db = new FakeClaimDb();
    expect(await claimLsPurchasesWith(db as unknown as ClaimDb, "", "buyer@x.com")).toBe(0);
    expect(await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", null)).toBe(0);
    expect(db.rpcs).toHaveLength(0);
  });
});
