/**
 * POST /api/sk/activate — a KDP copy's edition code + Amazon order number.
 * Gated exactly like /api/sk/redeem (FEATURE_SK 404 before auth, 503 without
 * BOOK_CODE_SECRET, the SK_ALLOWED_EMAILS 404, 401 signed out); the database
 * sees HMACs only (never the code or the order number); every outcome of
 * redeem_edition_code() maps to a status + friendly message; a repeated
 * eventId replays the stored result without a second database call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), rpc: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));

import { POST } from "@/app/api/sk/activate/route";
import { formatCode, generateCode, generateEditionCode, hmacCode, hmacOrderNumber } from "@/sk/access";

const SECRET = "test-secret-of-adequate-length";
const USER = { id: "22222222-2222-4222-8222-222222222222", email: "muqtadar1984@gmail.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
const fixedRandom = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));
const EDITION = generateEditionCode(fixedRandom);
const ORDER = "123-1234567-1234567";
const signedIn = (user: typeof USER | null) => mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user } }) } });
const req = (body: unknown) => new Request("http://x/api/sk/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let n = 0;
const eid = () => `evt-${++n}`;
const GRANT = { id: "g1", product_id: "p1", activated_at: "2026-11-01T00:00:00Z", expires_at: null, tutor_expires_at: "2026-12-01T00:00:00Z" };

beforeEach(() => {
  process.env.FEATURE_SK = "true";
  process.env.BOOK_CODE_SECRET = SECRET;
  delete process.env.SK_ALLOWED_EMAILS;
  signedIn(USER);
  mocks.rpc.mockResolvedValue({ data: { outcome: "redeemed", grant: GRANT }, error: null });
});
afterEach(() => {
  delete process.env.FEATURE_SK;
  delete process.env.BOOK_CODE_SECRET;
  delete process.env.SK_ALLOWED_EMAILS;
  vi.clearAllMocks();
});

describe("gate", () => {
  it("404 when FEATURE_SK is off — before auth is consulted", async () => {
    delete process.env.FEATURE_SK;
    expect((await POST(req({ eventId: eid(), code: EDITION, orderNumber: ORDER }))).status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("503 without a usable BOOK_CODE_SECRET", async () => {
    process.env.BOOK_CODE_SECRET = "short";
    expect((await POST(req({ eventId: eid(), code: EDITION, orderNumber: ORDER }))).status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("404 for a user off the SK_ALLOWED_EMAILS list, 401 signed out", async () => {
    process.env.SK_ALLOWED_EMAILS = "someone-else@example.com";
    expect((await POST(req({ eventId: eid(), code: EDITION, orderNumber: ORDER }))).status).toBe(404);
    delete process.env.SK_ALLOWED_EMAILS;
    signedIn(null);
    expect((await POST(req({ eventId: eid(), code: EDITION, orderNumber: ORDER }))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("400 without an eventId or on bad JSON", async () => {
    expect((await POST(req({ code: EDITION, orderNumber: ORDER }))).status).toBe(400);
    expect((await POST(new Request("http://x", { method: "POST", body: "{" }))).status).toBe(400);
  });
});

describe("validation before the database", () => {
  it("refuses a code card (SKB) on this route and a malformed order number, without calling the database", async () => {
    const card = generateCode("SKB2", fixedRandom);
    const a = await POST(req({ eventId: eid(), code: card, orderNumber: ORDER }));
    expect(a.status).toBe(400);
    const b = await POST(req({ eventId: eid(), code: EDITION, orderNumber: "123-123" }));
    expect(b.status).toBe(400);
    expect(((await b.json()) as { error: string }).error).toMatch(/order number/i);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("activation", () => {
  it("hands the database HMACs only — never the plain code or order number — and returns the tutor window", async () => {
    const res = await POST(req({ eventId: eid(), code: formatCode(EDITION).toLowerCase(), orderNumber: " 12312345671234567 " }));
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("redeem_edition_code");
    expect(args.p_code_hmac).toBe(hmacCode(EDITION, SECRET));
    expect(args.p_order_hmac).toBe(hmacOrderNumber(ORDER, SECRET));
    expect(args.p_user).toBe(USER.id);
    expect(args.p_for_child).toBeNull();
    expect(args.p_days).toBe(30);
    expect(args.p_channel).toBe("kdp");
    expect(JSON.stringify(args)).not.toContain(EDITION);
    expect(JSON.stringify(args)).not.toContain("1234567");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ grantId: "g1", productId: "p1", activatedAt: GRANT.activated_at, tutorExpiresAt: GRANT.tutor_expires_at, bookAccess: "permanent" });
  });
  it("passes forChildId through for a parent activating for a child", async () => {
    await POST(req({ eventId: eid(), code: EDITION, orderNumber: ORDER, forChildId: "33333333-3333-4333-8333-333333333333" }));
    expect((mocks.rpc.mock.calls[0] as [string, Record<string, unknown>])[1].p_for_child).toBe("33333333-3333-4333-8333-333333333333");
  });
  it("maps every refusal to a status and a friendly message", async () => {
    const cases: Array<[string, number]> = [
      ["invalid", 400],
      ["order_used", 400],
      ["daily_cap", 400],
      ["not_your_child", 403],
      ["rate_limited", 429],
    ];
    for (const [outcome, status] of cases) {
      mocks.rpc.mockResolvedValueOnce({ data: { outcome }, error: null });
      const res = await POST(req({ eventId: eid(), code: EDITION, orderNumber: ORDER }));
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toContain(outcome); // never the raw outcome
      expect(body.error.length).toBeGreaterThan(10);
    }
  });
  it("500 with a generic message when the database call fails", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const res = await POST(req({ eventId: eid(), code: EDITION, orderNumber: ORDER }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).not.toContain("boom");
  });
  it("replays a repeated eventId from the cache without a second database call", async () => {
    const e = eid();
    const a = await POST(req({ eventId: e, code: EDITION, orderNumber: ORDER }));
    const b = await POST(req({ eventId: e, code: EDITION, orderNumber: ORDER }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
