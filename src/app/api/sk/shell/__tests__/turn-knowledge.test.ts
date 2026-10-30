/**
 * SK S7 K2 — SK answers from its knowledge, end to end through the turn route:
 *   - a STUDENT's content question with no lesson open → her knowledge
 *     passages, ONE grounded kit-turn model call, ONE sk_usage live_turns
 *     (never the Shell's own model), a resend replays without a second call
 *     or meter, the citation line under the answer and `citations` on `done`;
 *   - an Arabic upload answers in Arabic (the `lang` event, rtl);
 *   - nothing in her sources → her chapters (tutor.where), no model, as before;
 *   - a TEACHER's content question → the model calls knowledge.search, the
 *     answer is grounded on its passages and `done` carries the citations;
 *     the prompt carries rule 11.
 * Examples used in the PR body: an English article, an Arabic upload, a
 * bought book.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-knowledge.test.ts
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
import { fakeKnowledge, lastSources, type FakeBlock, type FakeKnowledge } from "@/sk/knowledge/__tests__/fake-knowledge";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_SK", "NEXT_PUBLIC_FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "SK_AUDIT", "FEATURE_ROLE_HATS", "SK_SHELL_MODEL"];
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

describe("a student's content question, no lesson open", () => {
  it("a bought book: her passages, ONE kit-turn call, ONE live turn, the citation line and chips", async () => {
    install([{ text: ["Specialised cells such as red blood cells carry oxygen."] }]);
    signInStudent();
    const id = tid();
    const evs = await readEvents(await POST(req("what are specialised cells?", "/sk", id)));
    expect(evs.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(evs[1]).toMatchObject({ type: "tool", name: "knowledge.search", ok: true });
    expect(text(evs)).toBe("Specialised cells such as red blood cells carry oxygen.\nFrom: Biology · ch 5 · Specialised cells");
    expect(doneOf(evs)).toMatchObject({
      label: "grounded",
      sources: ["knowledge.search", "knowledge"],
      citations: [{ title: "Biology", chapter: 5, anchor: "s3", section: "Specialised cells", kind: "sketchcast_book" }],
    });
    expect(lastSources(knowledge)).toEqual(["article:*", "sketchcast_book:cells-structure@12"]);
    expect(teacher.calls).toHaveLength(1);
    expect(teacher.calls[0]!.system).not.toContain("SECRET-ANSWER-42");
    expect(mocks.constructed).toEqual([]); // never the Shell's own model
    expect(db.rows("sk_usage")).toEqual([expect.objectContaining({ user_id: STUDENT, product_id: PRODUCT, live_turns: 1, generated_segments: 0 })]);

    // A resend of the same turn replays: no second call, no second meter.
    const again = await readEvents(await POST(req("what are specialised cells?", "/sk", id)));
    expect(text(again)).toBe(text(evs));
    expect(teacher.calls).toHaveLength(1);
    expect(db.rows("sk_usage")[0]).toMatchObject({ live_turns: 1 });
  });

  it("an English article: cited by the article's title", async () => {
    install([{ text: ["Photosynthesis uses light to make glucose."] }]);
    signInStudent();
    const evs = await readEvents(await POST(req("explain photosynthesis")));
    expect(text(evs)).toBe("Photosynthesis uses light to make glucose.\nFrom: Photosynthesis · How plants make food");
    expect(doneOf(evs)).toMatchObject({ label: "grounded", citations: [{ title: "Photosynthesis", chapter: null, anchor: "s1", section: "How plants make food", kind: "article" }] });
    expect(db.rows("sk_usage")[0]).toMatchObject({ live_turns: 1 });
  });

  it("an Arabic upload: the answer goes out in Arabic (lang event, rtl), cited in Arabic", async () => {
    install([{ text: ["التنفس الخلوي يطلق الطاقة من الغلوكوز."] }]);
    signInStudent([{ id: "book-own-ar", title: "كتابي", language: "ar", removed_at: null, health: null }]);
    const evs = await readEvents(await POST(req("ما هو التنفس الخلوي؟")));
    expect(evs.find((e) => e.type === "lang")).toMatchObject({ lang: "ar", dir: "rtl" });
    expect(text(evs)).toBe("التنفس الخلوي يطلق الطاقة من الغلوكوز.\nالمصدر: كتابي · الفصل 2 · التنفس");
    expect(doneOf(evs)).toMatchObject({ citations: [{ title: "كتابي", chapter: 2, anchor: "p4", section: "التنفس", kind: "user_book" }] });
    expect(teacher.calls[0]!.messages[0]!.text).toContain("Answer in Arabic");
    expect(db.rows("sk_usage")).toHaveLength(1);
  });

  it("nothing in her sources answers it → her chapters, no model, nothing metered", async () => {
    install([{ text: ["never"] }]);
    signInStudent();
    const evs = await readEvents(await POST(req("what is a volcano?")));
    expect(evs[1]).toMatchObject({ type: "tool", name: "tutor.where" });
    expect(teacher.calls).toHaveLength(0);
    expect(db.rows("sk_usage")).toEqual([]);
  });

  it("not a content question ('hello there') → her chapters as before, no search", async () => {
    install([{ text: ["never"] }]);
    signInStudent();
    await readEvents(await POST(req("show me my books please")));
    expect(knowledge.searches).toHaveLength(0);
  });
});

describe("a teacher's content question goes through knowledge.search", () => {
  it("the model calls it; the answer rests on the passages; done carries the citations; the prompt has rule 11", async () => {
    install([]);
    signInTeacher();
    mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
    mocks.cookies = { sc_hat: "teacher" };
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "knowledge__search", args: { query: "photosynthesis" } }] },
      { text: ["Photosynthesis uses light to make glucose in the leaf.\nFrom: Photosynthesis · How plants make food"] },
    ];
    const evs = await readEvents(await POST(req("what is photosynthesis?", "/dashboard")));
    expect(evs.find((e) => e.type === "tool")).toMatchObject({ name: "knowledge.search", ok: true });
    expect(text(evs)).toBe("Photosynthesis uses light to make glucose in the leaf. From: Photosynthesis · How plants make food");
    expect(doneOf(evs)).toMatchObject({ label: "grounded", sources: ["knowledge.search"], citations: [{ title: "Photosynthesis", chapter: null, anchor: "s1", section: "How plants make food", kind: "article" }] });
    expect(mocks.systems[0]).toContain("11. For a content question");
    expect(lastSources(knowledge)).toEqual(["article:*"]);
  });

  it("an invented name next to the passages is dropped by the grounding check", async () => {
    install([]);
    signInTeacher();
    mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
    mocks.cookies = { sc_hat: "teacher" };
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "knowledge__search", args: { query: "photosynthesis" } }] },
      { text: ["Photosynthesis uses light to make glucose. Jan Ingenhousz found it in 1779."] },
    ];
    const evs = await readEvents(await POST(req("what is photosynthesis?", "/dashboard")));
    expect(text(evs)).toBe("Photosynthesis uses light to make glucose.");
    expect(doneOf(evs)).toMatchObject({ label: "grounded", trimmed: true });
  });
});
