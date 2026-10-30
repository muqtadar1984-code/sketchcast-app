/**
 * MODEL-FIRST routing and SK's knowledge (RAG), through POST /api/sk/shell/turn:
 *   - a teacher's teaching question goes to Sonnet 5.5 (never Haiku), which
 *     calls knowledge.search; the answer rests on the passages, with citations;
 *   - a short message Haiku takes, whose first round wants knowledge.search,
 *     ESCALATES: the round is re-run on Sonnet before any tool runs;
 *   - a student's knowledge question is handed to her own metered kit turn
 *     (one live turn), exactly as the rules path does — never the Shell model
 *     narrating passages.
 * Stub providers only — no paid model call.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-model-first-knowledge.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  script: [] as unknown[],
  constructed: [] as string[],
  systems: [] as string[],
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
        super(mocks.script as StubTurn[]);
        mocks.constructed.push(model);
      }
      async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
        mocks.systems.push(opts.system);
        yield* super.stream(opts);
      }
    },
  };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { SupabaseEntitlements } from "@/sk/entitlement";
import { SupabaseItemBank } from "@/sk/items-supabase";
import { __setKitDepsForTests, type KitAdmin, type KitDeps } from "@/sk/kit-server";
import { ProductKits } from "@/sk/product-kits";
import { SupabaseSessionStore } from "@/sk/store-supabase";
import type { FakeDb } from "@/sk/__tests__/fake-supabase";
import { kitManifest, kitWorld, PRODUCT, SLUG, STUDENT, T0 } from "@/sk/__tests__/kit-fixtures";
import { __setKnowledgeAdminForTests } from "@/sk/capabilities/knowledge";
import { fakeKnowledge, type FakeBlock, type FakeKnowledge } from "@/sk/knowledge/__tests__/fake-knowledge";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_SK", "NEXT_PUBLIC_FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "SK_AUDIT", "FEATURE_ROLE_HATS", "SK_SHELL_MODEL", "SK_ROUTING", "SK_FAST_MODEL"];
const saved: Record<string, string | undefined> = {};
const EMAIL = "aisha@student.example";
const STUDENT_USER = { id: STUDENT, email: EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z" };
const TEACHER_USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };

const BLOCKS: FakeBlock[] = [
  { source_kind: "sketchcast_book", source_id: "cells-structure", version: "12", chapter: 5, anchor: "s3", title: "Specialised cells", text: "Specialised cells such as red blood cells carry oxygen. Nerve cells carry signals." },
  { source_kind: "sketchcast_book", source_id: "cells-structure", version: "12", chapter: 5, anchor: "x1", title: "Specialised cells", text: "Name two specialised cells.", answer: "SECRET-ANSWER-42" },
  { source_kind: "article", source_id: "art-photo-en", version: "3", chapter: null, anchor: "s1", title: "How plants make food", text: "Photosynthesis uses light to make glucose in the leaf." },
  { source_kind: "user_book", source_id: "book-own-ar", version: "h1", chapter: 2, anchor: "p4", title: "التنفس", text: "التنفس الخلوي يطلق الطاقة من الغلوكوز داخل الخلايا." },
];

let db: FakeDb;
let teacher: StubProvider;
let knowledge: FakeKnowledge;

function install(teacherScript: StubTurn[]) {
  db = kitWorld();
  teacher = new StubProvider(teacherScript);
  const admin: KitAdmin = { from: (t: string) => db.from(t), storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x" }, error: null }) }) } };
  const read = vi.fn(async () => ({ status: "ready" as const, manifest: kitManifest(), builtAt: new Date(T0).toISOString() }));
  const entitlements = new SupabaseEntitlements(db);
  const deps: Partial<KitDeps> = {
    kits: new ProductKits(db, entitlements, () => new Date(T0)),
    admin: () => admin,
    read,
    derive: read,
    items: () => new SupabaseItemBank(db),
    store: new SupabaseSessionStore(db, { now: () => T0, pollMs: 1, inflightTimeoutMs: 500 }),
    entitlements,
    teacherProvider: teacher,
    now: () => T0,
  };
  __setKitDepsForTests(deps);
  // The service-role view the knowledge layer reads: Cells as a live FINAL
  // (her staff grant opens it), the article, and the sk_search_knowledge RPC.
  knowledge = fakeKnowledge(
    {
      sk_book_products: [{ id: PRODUCT, slug: SLUG, title: "Biology", status: "approved", work_uid: "cells-structure", language: "en", release_id: 12, release_kind: "final" }],
      book_access_grants: [{ user_id: STUDENT, product_id: PRODUCT, source: "staff", activated_at: new Date(T0 - 86_400_000).toISOString(), expires_at: null, tutor_expires_at: new Date(T0 + 365 * 86_400_000).toISOString(), revoked_at: null, usage_allowance: null }],
      entitlements: [],
      topic_articles: [{ id: "art-photo-en", title: "Photosynthesis", language: "en", status: "approved", version: 3, topic_id: "t1" }],
    },
    BLOCKS,
  );
  __setKnowledgeAdminForTests(() => knowledge);
}

function signInStudent(books: Record<string, unknown>[] = []) {
  mocks.createClient.mockResolvedValue(fakeSession({ profiles: [{ role: "student", school_id: null, full_name: "Aisha Rahman" }], sk_book_products: [{ slug: SLUG }], books }, { user: STUDENT_USER }));
}
function signInTeacher() {
  mocks.createClient.mockResolvedValue(
    fakeSession({ profiles: [{ role: "teacher", school_id: SCHOOL_ID }], schools: [{ config: {} }], coordinator_scope: [], parent_links: [], classes: [], enrollments: [], books: [], generations: [] }, { user: TEACHER_USER }),
  );
}

let n = 0;
const tid = () => `7a1c2d3e-4b5a-4c7d-8e9f-${String(++n).padStart(12, "0")}`;
const req = (text: string, path = "/sk", id = tid()) =>
  new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnId: id, text, modality: "text", collector: { path, locale: "en" } }) });

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.NEXT_PUBLIC_FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher,student";
  process.env.SK_ALLOWED_EMAILS = `founder@sketchcast.app, ${EMAIL}, ${TEACHER_USER.email}`;
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.FEATURE_ROLE_HATS = "true";
  process.env.SK_SHELL_SECRET = "knowledge-test-secret-of-adequate-length";
  process.env.SK_ROUTING = "model";
  mocks.cookies = {};
  mocks.script = [];
  mocks.constructed = [];
  mocks.systems = [];
  mocks.createAdminClient.mockImplementation(() => {
    throw new Error("no service key in tests");
  });
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setKitDepsForTests(null);
  __setKnowledgeAdminForTests(null);
  vi.clearAllMocks();
});

const text = (evs: Array<Record<string, unknown>>) => evs.filter((e) => e.type === "text").map((e) => String(e.text)).join("");
const doneOf = (evs: Array<Record<string, unknown>>) => evs.find((e) => e.type === "done") as Record<string, unknown>;

describe("model routing: teaching from the books", () => {
  const teacherTurn = () => {
    install([]);
    signInTeacher();
    mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
    mocks.cookies = { sc_hat: "teacher" };
  };

  it("a teaching question → Sonnet calls knowledge.search → grounded on the passages, with citations", async () => {
    teacherTurn();
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "knowledge__search", args: { query: "photosynthesis" } }] },
      { text: ["Photosynthesis uses light to make glucose in the leaf.\nFrom: Photosynthesis · How plants make food"] },
    ];
    const evs = await readEvents(await POST(req("explain photosynthesis to me", "/dashboard")));
    expect(mocks.constructed).toEqual(["claude-sonnet-5-5"]);
    expect(evs.find((e) => e.type === "tool")).toMatchObject({ name: "knowledge.search", ok: true });
    expect(text(evs)).toBe("Photosynthesis uses light to make glucose in the leaf. From: Photosynthesis · How plants make food");
    expect(doneOf(evs)).toMatchObject({ label: "grounded", sources: ["knowledge.search"], citations: [{ title: "Photosynthesis", kind: "article" }] });
    expect(mocks.systems[0]).toContain("MODEL-FIRST");
  });

  it("Haiku's first round wants knowledge.search → re-run on Sonnet before any tool runs", async () => {
    teacherTurn();
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "knowledge__search", args: { query: "photosynthesis" } }] },
      { text: ["Photosynthesis uses light to make glucose in the leaf."] },
    ];
    const evs = await readEvents(await POST(req("photosynthesis notes please", "/dashboard")));
    expect(mocks.constructed).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    // One search (Sonnet's), not two: the escalated Haiku round never ran its tool.
    expect(evs.filter((e) => e.type === "tool").map((e) => e.name)).toEqual(["knowledge.search"]);
    expect(text(evs)).toBe("Photosynthesis uses light to make glucose in the leaf.");
    // The Haiku round's tokens are counted: 3 stub calls × (100 in, 50 out).
    expect(doneOf(evs)).toMatchObject({ label: "grounded", usage: { inputTokens: 300, outputTokens: 150 } });
  });
});

describe("model routing: a student's knowledge question is her own metered kit turn", () => {
  it("the model's knowledge.search is handed off: ONE kit-turn call, ONE live turn, the citation line", async () => {
    install([{ text: ["Specialised cells such as red blood cells carry oxygen."] }]);
    signInStudent();
    mocks.script = [{ toolCalls: [{ id: "c1", name: "knowledge__search", args: { query: "specialised cells" } }] }];
    const evs = await readEvents(await POST(req("what are specialised cells?", "/sk")));
    // The Shell model ran ONE round (it chose the tool); the answer is the kit turn's.
    expect(mocks.constructed).toEqual(["claude-sonnet-5-5"]);
    expect(text(evs)).toBe("Specialised cells such as red blood cells carry oxygen.\nFrom: Biology · ch 5 · Specialised cells");
    expect(doneOf(evs)).toMatchObject({ label: "grounded", sources: ["knowledge.search", "knowledge"] });
    expect(teacher.calls).toHaveLength(1);
    expect(db.rows("sk_usage")).toEqual([expect.objectContaining({ user_id: STUDENT, product_id: PRODUCT, live_turns: 1 })]);
    // Her prompt had the student rules and her tools only — no teacher action.
    const tools = mocks.systems[0] ?? "";
    expect(tools).toContain("STUDENT RULES");
    expect(tools).not.toContain("- diary.note (");
    expect(tools).not.toContain("- notice.school (");
  });
});
