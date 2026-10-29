/**
 * /api/sk/shell/turn, S4 slice D: book activation through the Shell.
 *   - a parent types a code → meta(act) → tool → text → confirm → done, with
 *     NO model call; the card's params are the masked code and the child —
 *     the sealed HMACs stay in the token row and never reach the browser;
 *   - the code is in no audit row, no event and not in the signed memory;
 *   - an edition code without the order number asks for it, and the bare
 *     order number on the next turn (memory `pending`) completes the card;
 *   - no BOOK_CODE_SECRET → "Book codes aren't switched on yet." and no card.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-book.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  constructed: [] as string[],
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor(model: string) {
        super([{ text: ["MODEL WAS CALLED"] }] as unknown as StubTurn[]);
        mocks.constructed.push(model);
      }
    },
  };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";
import { formatCode, generateEditionCode, hmacCode, hmacOrderNumber } from "@/sk/access";
import { maskCode } from "@/sk/book-activate";

const ENV = ["FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "BOOK_CODE_SECRET", "FEATURE_ROLE_HATS", "SK_AUDIT", "FEATURE_PARENT_PORTAL"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "p@home.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
const AISYAH = "a6000000-0000-4000-8000-000000000016";
const PRODUCT = "d0000000-0000-4000-8000-000000000041";
const BOOK_SECRET = "book-code-secret-of-adequate-length";
const EDITION = generateEditionCode((n) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 61 + 13) & 0xff)));
const ORDER = "123-1234567-1234567";

const tables = () => ({
  profiles: [{ role: "parent", school_id: null }],
  parent_links: [{ parent_id: TEACHER_ID, child_id: AISYAH, verified_at: "2026-10-01T00:00:00.000Z", source: "self", profiles: { full_name: "Aisyah binti Ali" } }],
  sk_book_products: [{ id: PRODUCT, title: "Biology" }],
});
let admin: ReturnType<typeof fakeAdmin>;

const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const turn = (text: string, memory?: string) => ({
  turnId: `t-${Math.random().toString(36).slice(2)}`,
  text,
  modality: "text",
  collector: { path: "/dashboard/children", locale: "en" },
  ...(memory ? { memory } : {}),
});

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher,parent";
  process.env.SK_SHELL_CONSUMER = "true";
  process.env.SK_SHELL_SECRET = "route-test-secret-of-adequate-length";
  process.env.BOOK_CODE_SECRET = BOOK_SECRET;
  process.env.FEATURE_PARENT_PORTAL = "true";
  process.env.SK_AUDIT = "db";
  mocks.cookies = {};
  mocks.constructed = [];
  admin = fakeAdmin(null);
  mocks.createAdminClient.mockReturnValue(admin);
  mocks.createClient.mockResolvedValue(fakeSession(tables(), { user: USER }));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

const tokenRows = () => admin.inserts.filter((i) => i.table === "sk_action_tokens").map((i) => i.row as Record<string, unknown>);
const auditRows = () => admin.inserts.filter((i) => i.table === "sk_actions").map((i) => i.row as Record<string, unknown>);

describe("book activation through the Shell", () => {
  it("a parent's code + order number → a masked card for her child, no model, nothing secret leaves the server", async () => {
    const ev = await readEvents(await POST(req(turn(`activate my book code ${formatCode(EDITION)} order ${ORDER} for Aisyah`))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "confirm", "done"]);
    expect(ev[0]).toMatchObject({ intent: "act" });
    expect(mocks.constructed).toEqual([]); // no model call
    const card = ev.find((e) => e.type === "confirm") as { title: string; params: Record<string, unknown>; action: string };
    expect(card.action).toBe("book.activate");
    expect(card.title).toBe("Activate a book code for Aisyah");
    expect(card.params).toMatchObject({ code: maskCode(EDITION), for_child_id: AISYAH, child_label: "Aisyah", click_only: true });
    expect(Object.keys(card.params).some((k) => k.startsWith("sealed_"))).toBe(false);
    // The token row holds the HMACs (the server needs them) — never the code.
    const [tok] = tokenRows();
    expect(tok.action).toBe("book.activate");
    expect(tok.params).toMatchObject({ sealed_code_hmac: hmacCode(EDITION, BOOK_SECRET), sealed_order_hmac: hmacOrderNumber(ORDER, BOOK_SECRET) });
    // The code and the order number are in no event (incl. the signed memory) and no audit row.
    const outbound = JSON.stringify(ev) + JSON.stringify(auditRows()) + JSON.stringify(tok);
    expect(outbound).not.toContain(EDITION);
    expect(outbound).not.toContain(formatCode(EDITION));
    expect(outbound).not.toContain("1234567-1234567");
    const memory = String((ev[ev.length - 1] as { memory: string }).memory);
    expect(Buffer.from(memory.split(".")[0]!, "base64url").toString("utf8")).not.toContain(EDITION.slice(3, 12));
  });
  it("an edition code alone → asks for the order number; the bare number next turn completes the card", async () => {
    const first = await readEvents(await POST(req(turn(formatCode(EDITION)))));
    expect(first.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect((first.find((e) => e.type === "text") as { text: string }).text).toMatch(/Amazon order number/);
    const memory = String((first[first.length - 1] as { memory: string }).memory);
    const second = await readEvents(await POST(req(turn(ORDER, memory))));
    expect(second.map((e) => e.type)).toEqual(["meta", "tool", "text", "confirm", "done"]);
    expect(mocks.constructed).toEqual([]);
    expect(tokenRows()[0]?.params).toMatchObject({ sealed_code_hmac: hmacCode(EDITION, BOOK_SECRET), for_child_id: AISYAH });
  });
  it("without BOOK_CODE_SECRET → the plain line and no card", async () => {
    delete process.env.BOOK_CODE_SECRET;
    const ev = await readEvents(await POST(req(turn(`${formatCode(EDITION)} ${ORDER}`))));
    expect(ev.find((e) => e.type === "confirm")).toBeUndefined();
    expect((ev.find((e) => e.type === "text") as { text: string }).text).toBe("Book codes aren't switched on yet.");
    expect(tokenRows()).toEqual([]);
  });
});
