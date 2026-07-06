/**
 * Lemon Squeezy billing tests — the invariants a reviewer must see hold:
 *   * webhook signature rejects tampered/unsigned payloads (HMAC-SHA256)
 *   * a subscription event flips the RIGHT user's entitlement, keyed per plan
 *   * identity is cross-checked: a later event can't switch a customer's owner
 *   * status → access mapping (grace for cancelled until ends_at; revoke on
 *     paused/unpaid/expired)
 *   * personal LS plans carry school_id = null (never leak to a school)
 *   * no card data is persisted
 * Run: npx vitest run
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLsSignature, lsEventKey } from "../webhook";
import { handleLsEvent, type LsEvent } from "../handlers";

// ── stub DB ───────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
class FakeDb {
  tables: Record<string, Row | null>;
  writes: Array<{ table: string; op: "insert" | "upsert"; row: Row }> = [];
  constructor(tables: Record<string, Row | null> = {}) {
    this.tables = tables;
  }
  from(table: string) {
    const read = async () => ({ data: this.tables[table] ?? null });
    const record = (op: "insert" | "upsert") => async (row: Row) => {
      this.writes.push({ table, op, row });
      return { error: null };
    };
    return {
      select: () => ({ eq: () => ({ maybeSingle: read }) }),
      upsert: record("upsert"),
      insert: record("insert"),
    };
  }
}

const subEvent = (over: {
  event?: string;
  status?: string;
  custom?: { user_id?: string; plan_key?: string } | null;
  customerId?: number;
  subId?: string;
  ends_at?: string | null;
  renews_at?: string | null;
  updated_at?: string;
}): LsEvent => ({
  meta: { event_name: over.event ?? "subscription_created", custom_data: over.custom === null ? null : over.custom ?? { user_id: "user-A", plan_key: "parent_monthly" } },
  data: {
    type: "subscriptions",
    id: over.subId ?? "sub_1",
    attributes: {
      status: over.status ?? "active",
      customer_id: over.customerId ?? 555,
      renews_at: over.renews_at ?? "2999-01-01T00:00:00.000000Z",
      ends_at: over.ends_at ?? null,
      updated_at: over.updated_at ?? "2026-07-06T12:00:00Z",
      urls: { customer_portal: "https://x.lemonsqueezy.com/portal/abc" },
    },
  },
});

// ── signature ────────────────────────────────────────────────────────────────
describe("LS webhook signature", () => {
  const secret = "whsec_ls_test";
  const body = JSON.stringify({ meta: { event_name: "subscription_created" } });
  const good = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

  it("accepts a correctly-signed body", () => {
    expect(verifyLsSignature(body, good, secret)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyLsSignature(body + " ", good, secret)).toBe(false);
  });
  it("rejects a missing / malformed signature", () => {
    expect(verifyLsSignature(body, null, secret)).toBe(false);
    expect(verifyLsSignature(body, "not-hex-zz", secret)).toBe(false);
    expect(verifyLsSignature(body, "deadbeef", secret)).toBe(false);
  });
  it("rejects when the secret is wrong", () => {
    expect(verifyLsSignature(body, good, "whsec_other")).toBe(false);
  });
  it("builds a stable idempotency key", () => {
    expect(lsEventKey("subscription_updated", 42, "2026-07-06T00:00:00Z")).toBe("ls_subscription_updated_42_2026-07-06T00:00:00Z");
  });
});

// ── handlers ─────────────────────────────────────────────────────────────────
describe("LS subscription → entitlement", () => {
  it("first event stores the customer mapping and grants the right user/plan", async () => {
    const db = new FakeDb({ billing_customers: null }); // no mapping yet
    await handleLsEvent(db, subEvent({ status: "active" }));
    const cust = db.writes.find((w) => w.table === "billing_customers");
    expect(cust!.row.ls_customer_id).toBe("555");
    expect(cust!.row.provider).toBe("lemonsqueezy");
    const ent = db.writes.find((w) => w.table === "entitlements");
    expect(ent!.row.user_id).toBe("user-A");
    expect(ent!.row.plan_key).toBe("parent_monthly");
    expect(ent!.row.active).toBe(true);
    expect(ent!.row.school_id).toBeNull(); // personal — never school-scoped
  });

  it("cross-checks identity: a later event whose custom_data claims a DIFFERENT user is refused", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } }); // mapping says A
    await handleLsEvent(db, subEvent({ custom: { user_id: "user-B", plan_key: "parent_monthly" } }));
    // resolved to stored user-A? No — claim (B) mismatches stored (A) → refused.
    expect(db.writes.find((w) => w.table === "entitlements")).toBeUndefined();
  });

  it("resolves user from the stored mapping when a renewal omits custom_data", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: { plan_key: "teacher_monthly" } });
    await handleLsEvent(db, subEvent({ event: "subscription_updated", custom: null, status: "active" }));
    const ent = db.writes.find((w) => w.table === "entitlements");
    expect(ent!.row.user_id).toBe("user-A");
    expect(ent!.row.plan_key).toBe("teacher_monthly"); // from stored subscription
    expect(ent!.row.active).toBe(true);
  });

  it("cancelled keeps access until ends_at (grace); paused/expired revoke", async () => {
    const db1 = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await handleLsEvent(db1, subEvent({ event: "subscription_cancelled", status: "cancelled", ends_at: "2999-01-01T00:00:00Z" }));
    const c = db1.writes.find((w) => w.table === "entitlements");
    expect(c!.row.active).toBe(true);
    expect(c!.row.current_period_end).toBe("2999-01-01T00:00:00Z"); // grace end

    for (const s of ["paused", "unpaid", "expired"]) {
      const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
      await handleLsEvent(db, subEvent({ event: "subscription_updated", status: s }));
      const e = db.writes.find((w) => w.table === "entitlements");
      expect(e!.row.active).toBe(false);
    }
  });

  it("cancelled with NO ends_at reads inactive (no unbounded grant)", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await handleLsEvent(db, subEvent({ event: "subscription_cancelled", status: "cancelled", ends_at: null }));
    const e = db.writes.find((w) => w.table === "entitlements");
    expect(e!.row.active).toBe(false); // no grace window → not active forever
    expect(e!.row.current_period_end).toBeNull();
  });

  it("skips a STALE out-of-order event (monotonicity gate)", async () => {
    // stored state is newer (T2); a stale 'active' at T1 < T2 must not re-grant.
    const db = new FakeDb({
      billing_customers: { user_id: "user-A" },
      subscriptions: { plan_key: "parent_monthly", provider_updated_at: "2026-07-06T13:00:00Z" },
    });
    await handleLsEvent(db, subEvent({ event: "subscription_updated", status: "active", updated_at: "2026-07-06T12:00:00Z" }));
    expect(db.writes.find((w) => w.table === "entitlements")).toBeUndefined();
    expect(db.writes.find((w) => w.table === "subscriptions")).toBeUndefined();
  });

  it("applies a NEWER event over stored state", async () => {
    const db = new FakeDb({
      billing_customers: { user_id: "user-A" },
      subscriptions: { plan_key: "parent_monthly", provider_updated_at: "2026-07-06T12:00:00Z" },
    });
    await handleLsEvent(db, subEvent({ event: "subscription_expired", status: "expired", updated_at: "2026-07-06T13:00:00Z" }));
    const e = db.writes.find((w) => w.table === "entitlements");
    expect(e!.row.active).toBe(false);
  });

  it("ignores non-subscription events", async () => {
    const db = new FakeDb({});
    await handleLsEvent(db, { meta: { event_name: "order_created" }, data: { id: "1", attributes: { status: "paid", customer_id: 1, renews_at: null, ends_at: null } } } as LsEvent);
    expect(db.writes.length).toBe(0);
  });

  it("persists no card data", async () => {
    const db = new FakeDb({ billing_customers: null });
    await handleLsEvent(db, subEvent({}));
    const keys = db.writes.flatMap((w) => Object.keys(w.row));
    for (const k of keys) expect(k).not.toMatch(/card|pan|cvv|cvc|number/i);
    expect(JSON.stringify(db.writes)).not.toMatch(/\b\d{13,19}\b/);
  });
});
