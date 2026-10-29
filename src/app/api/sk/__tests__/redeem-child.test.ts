/**
 * S4 slice D — the activation routes for a CHOSEN CHILD: both routes pass
 * forChildId through to the RPC as p_for_child; the RPC's refusal of an
 * unlinked child is a 403 with `reason: "not_your_child"` (the /activate form
 * says it in the reader's language); a malformed child id never reaches the
 * database. Also: /api/sk/redeem now accepts batch-prefixed code cards
 * (SKB2-…), which the old no-prefix format check refused; and a success names
 * the book from sk_book_products (read with the session client).
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/__tests__/redeem-child.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), rpc: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));

import { POST as REDEEM } from "@/app/api/sk/redeem/route";
import { POST as ACTIVATE } from "@/app/api/sk/activate/route";
import { formatCode, generateCode, generateEditionCode, hmacCode } from "@/sk/access";

const SECRET = "test-secret-of-adequate-length";
const USER = { id: "22222222-2222-4222-8222-222222222222", email: "muqtadar1984@gmail.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
const CHILD = "33333333-3333-4333-8333-333333333333";
const PRODUCT = "44444444-4444-4444-8444-444444444444";
const rnd = (seed: number) => (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * seed + 3) & 0xff));
const CARD = generateCode("SKB2", rnd(29));
const EDITION = generateEditionCode(rnd(31));
const ORDER = "123-1234567-1234567";
const GRANT = { id: "g1", product_id: PRODUCT, activated_at: "2026-11-01T00:00:00Z", expires_at: null, tutor_expires_at: "2026-12-01T00:00:00Z" };
const req = (body: unknown) => new Request("http://x/api/sk/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let n = 0;
const eid = () => `child-evt-${++n}`;

function signedIn() {
  // The session client: auth + the one read the routes make (the book's title).
  const from = (table: string) => {
    const b = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: table === "sk_book_products" ? { id: PRODUCT, title: "Biology" } : null, error: null }),
    };
    return b;
  };
  mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: USER } }) }, from });
}

beforeEach(() => {
  process.env.FEATURE_SK = "true";
  process.env.BOOK_CODE_SECRET = SECRET;
  delete process.env.SK_ALLOWED_EMAILS;
  signedIn();
  mocks.rpc.mockResolvedValue({ data: { outcome: "redeemed", grant: GRANT }, error: null });
});
afterEach(() => {
  delete process.env.FEATURE_SK;
  delete process.env.BOOK_CODE_SECRET;
  vi.clearAllMocks();
});

describe("/api/sk/redeem (code card) for a child", () => {
  it("accepts a batch-prefixed card, passes forChildId through, and names the book", async () => {
    const res = await REDEEM(req({ eventId: eid(), code: formatCode(CARD).toLowerCase(), forChildId: CHILD }));
    expect(res.status).toBe(200);
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("redeem_book_code");
    expect(args).toEqual({ p_code_hmac: hmacCode(CARD, SECRET), p_user: USER.id, p_for_child: CHILD, p_days: 30 });
    expect(JSON.stringify(args)).not.toContain(CARD);
    expect(await res.json()).toMatchObject({ grantId: "g1", productId: PRODUCT, bookTitle: "Biology", forChildId: CHILD });
  });
  it("for me: p_for_child is null", async () => {
    await REDEEM(req({ eventId: eid(), code: CARD }));
    expect((mocks.rpc.mock.calls[0] as [string, Record<string, unknown>])[1].p_for_child).toBeNull();
  });
  it("an unlinked child is refused by the RPC → 403 with the reason and a plain line", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { outcome: "not_your_child" }, error: null });
    const res = await REDEEM(req({ eventId: eid(), code: CARD, forChildId: CHILD }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toBe("not_your_child");
    expect(body.error).toMatch(/child linked to your account/);
  });
  it("a malformed child id never reaches the database", async () => {
    const res = await REDEEM(req({ eventId: eid(), code: CARD, forChildId: "'; drop table x; --" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe("not_your_child");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("a malformed code is `invalid` without a database call; no secret is `not_configured`", async () => {
    const a = await REDEEM(req({ eventId: eid(), code: "SKB2-NOPE" }));
    expect(a.status).toBe(400);
    expect(((await a.json()) as { reason: string }).reason).toBe("invalid");
    process.env.BOOK_CODE_SECRET = "short";
    const b = await REDEEM(req({ eventId: eid(), code: CARD }));
    expect(b.status).toBe(503);
    expect(((await b.json()) as { reason: string }).reason).toBe("not_configured");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("every RPC refusal carries its reason (used, revoked, rate_limited)", async () => {
    for (const [outcome, status] of [
      ["used", 400],
      ["revoked", 400],
      ["rate_limited", 429],
    ] as const) {
      mocks.rpc.mockResolvedValueOnce({ data: { outcome }, error: null });
      const res = await REDEEM(req({ eventId: eid(), code: CARD }));
      expect(res.status).toBe(status);
      expect(((await res.json()) as { reason: string }).reason).toBe(outcome);
    }
  });
});

describe("/api/sk/activate (edition code) for a child", () => {
  it("passes forChildId through; an unlinked child → 403 not_your_child", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { outcome: "not_your_child" }, error: null });
    const res = await ACTIVATE(req({ eventId: eid(), code: EDITION, orderNumber: ORDER, forChildId: CHILD }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe("not_your_child");
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("redeem_edition_code");
    expect(args.p_for_child).toBe(CHILD);
    expect(args.p_user).toBe(USER.id);
  });
  it("a linked child: 200 with the book's title and who it was for", async () => {
    const res = await ACTIVATE(req({ eventId: eid(), code: EDITION, orderNumber: ORDER, forChildId: CHILD }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bookTitle: "Biology", forChildId: CHILD, bookAccess: "permanent" });
  });
});
