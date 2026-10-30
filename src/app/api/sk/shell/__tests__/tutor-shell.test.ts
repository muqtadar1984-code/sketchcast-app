/**
 * SK S3 slice D — the SK Shell for students, end to end through the routes:
 *   - THE GATE: a student not on SK_ALLOWED_EMAILS gets no Shell (layout
 *     decision and both routes); SK_ROLES' default ("teacher") keeps students
 *     out; the Shell is never wider than the /sk pages' own gate;
 *   - a student turn never reaches the Shell's own model: a move is a `tutor`
 *     event with no model at all; a question is tutor.explain — ONE kit-turn
 *     model call and ONE sk_usage live_turns, like the player's explain button;
 *   - the greeting: "Hi <name> — you were on <section> of <kit>. Carry on?",
 *     and "yes" on the kit's page plays it;
 *   - the student rule block is in the prompt, and SK's student lines are the
 *     same text as the dictionaries' sk.shell.tutor.* in all ten locales.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  constructed: [] as string[],
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor(model: string) {
        super([{ text: ["The Shell's own model must never answer a student."] }] as StubTurn[]);
        mocks.constructed.push(model);
      }
    },
  };
});

import { POST as turnPOST } from "@/app/api/sk/shell/turn/route";
import { POST as contextPOST } from "@/app/api/sk/shell/context/route";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { skTutorShellDecision } from "@/utils/flags";
import { SupabaseEntitlements } from "@/sk/entitlement";
import { SupabaseItemBank } from "@/sk/items-supabase";
import { __setKitDepsForTests, type KitAdmin, type KitDeps } from "@/sk/kit-server";
import { kitSegments } from "@/sk/kit-view";
import { ProductKits } from "@/sk/product-kits";
import { SupabaseSessionStore } from "@/sk/store-supabase";
import type { FakeDb } from "@/sk/__tests__/fake-supabase";
import { kitManifest, kitWorld, SLUG, STUDENT, T0 } from "@/sk/__tests__/kit-fixtures";
import { CH5_KIT, ch5Manifest, seedCh5 } from "@/sk/__tests__/remediation-fixtures";
import { buildShellPrompt, SK_STUDENT_RULES } from "@/sk/shell/prompt";
import { TUTOR_LINE_KEYS } from "@/sk/shell/tutor-lines";
import { fakeSession, makeCtx, readEvents } from "@/sk/shell/__tests__/fixtures";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import msArab from "@/i18n/messages/ms-arab.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import te from "@/i18n/messages/te.json";
import mr from "@/i18n/messages/mr.json";
import hi from "@/i18n/messages/hi.json";

const ENV = ["FEATURE_SK", "NEXT_PUBLIC_FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "SK_AUDIT"];
const saved: Record<string, string | undefined> = {};
const EMAIL = "aisha@student.example";
const VERIFIED = { id: STUDENT, email: EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z" };

let teacher: StubProvider;
let db: FakeDb;

function install() {
  db = seedCh5(kitWorld());
  teacher = new StubProvider([{ text: ["Red blood cells carry oxygen around the body."] }, { text: ["Red blood cells have no nucleus."] }]);
  const admin: KitAdmin = { from: (t: string) => db.from(t), storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x" }, error: null }) }) } };
  const read = vi.fn(async (_a: KitAdmin, g: string) => ({ status: "ready" as const, manifest: g === CH5_KIT ? ch5Manifest() : kitManifest(), builtAt: new Date(T0).toISOString() }));
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
}

function signIn(user: typeof VERIFIED | null = VERIFIED, role = "student") {
  mocks.createClient.mockResolvedValue(fakeSession({ profiles: [{ role, school_id: null, full_name: "Aisha Rahman" }], sk_book_products: [{ slug: SLUG }] }, { user }));
}

const TUTOR = { product: SLUG, chapter: "5", kit: CH5_KIT, k: 1, key: "p1:s002", segments: kitSegments(ch5Manifest()).map((s, i) => ({ k: i, key: s.key, heading: s.heading })) };
let n = 0;
const tid = () => `6f1c2d3e-4b5a-4c7d-8e9f-${String(++n).padStart(12, "0")}`;
const turn = (text: string, extra: Record<string, unknown> = {}) =>
  new Request("http://x/api/sk/shell/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId: tid(), text, modality: "text", collector: { path: `/sk/${SLUG}/5`, locale: "en", tutor: TUTOR }, ...extra }),
  });
const context = (body: Record<string, unknown> = {}) => new Request("http://x/api/sk/shell/context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: `/sk/${SLUG}/5`, ...body }) });

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.NEXT_PUBLIC_FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher,student";
  process.env.SK_ALLOWED_EMAILS = `founder@sketchcast.app, ${EMAIL}`;
  process.env.SK_SHELL_SECRET = "tutor-shell-test-secret-of-adequate-length";
  mocks.constructed = [];
  mocks.createAdminClient.mockImplementation(() => {
    throw new Error("no service key in tests");
  });
  install();
  signIn();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setKitDepsForTests(null);
  vi.clearAllMocks();
});

describe("the gate: never wider than /sk", () => {
  const input = (over: Record<string, unknown> = {}) => ({ role: "student", user: VERIFIED, schoolId: null, schoolOptIn: null, signedIn: true, ...over });

  it("a student not on SK_ALLOWED_EMAILS gets no Shell — decision, context route and turn route", async () => {
    const other = { ...VERIFIED, email: "someone@student.example" };
    expect(skTutorShellDecision(input({ user: other }))).toEqual({ on: false, reason: "not_allowed" });
    signIn(other);
    expect((await contextPOST(context())).status).toBe(404);
    expect((await turnPOST(turn("next"))).status).toBe(404);
    expect(teacher.calls).toHaveLength(0);
  });
  it("on the list but unverified: no Shell", () => {
    expect(skTutorShellDecision(input({ user: { ...VERIFIED, email_confirmed_at: null } }))).toEqual({ on: false, reason: "not_allowed" });
  });
  it("SK_ROLES' default (teacher) keeps students out; the founder must add student", async () => {
    delete process.env.SK_ROLES;
    expect(skTutorShellDecision(input())).toEqual({ on: false, reason: "role_off" });
    expect((await contextPOST(context())).status).toBe(404);
  });
  it("the /sk gate's own conditions: the public flag, the server flag, signed in", () => {
    expect(skTutorShellDecision(input()).on).toBe(true);
    expect(skTutorShellDecision(input({ signedIn: false }))).toEqual({ on: false, reason: "not_allowed" });
    delete process.env.NEXT_PUBLIC_FEATURE_SK;
    expect(skTutorShellDecision(input())).toEqual({ on: false, reason: "flag_off" });
    process.env.NEXT_PUBLIC_FEATURE_SK = "true";
    delete process.env.FEATURE_SK;
    expect(skTutorShellDecision(input())).toEqual({ on: false, reason: "flag_off" });
  });
  it("with the allow-list removed, a student still needs her school's opt-in (or the consumer flag)", () => {
    delete process.env.SK_ALLOWED_EMAILS;
    expect(skTutorShellDecision(input({ schoolId: "s1", schoolOptIn: false }))).toEqual({ on: false, reason: "school_opt_out" });
    expect(skTutorShellDecision(input())).toEqual({ on: false, reason: "consumer_off" });
  });
});

describe("a student turn", () => {
  it("a pure move: a `tutor` event, audited, and no model of any kind", async () => {
    const evs = await readEvents(await turnPOST(turn("go to the next part")));
    expect(evs.map((e) => e.type)).toEqual(["meta", "tool", "tutor", "done"]);
    expect(evs[0]).toMatchObject({ intent: "tutor" });
    expect(evs[2]).toEqual({ type: "tutor", move: "section", args: { k: 2, key: "p1:s003" }, say: "Section 3: Tissues and organs." });
    expect(evs[3]).toMatchObject({ sources: ["tutor.section"], label: "grounded" });
    expect(mocks.constructed).toEqual([]);
    expect(teacher.calls).toHaveLength(0);
    expect(db.rows("sk_usage")).toEqual([]);
  });

  it("a question: tutor.explain — ONE kit-turn model call, ONE sk_usage live_turns, never the Shell's model", async () => {
    const evs = await readEvents(await turnPOST(turn("why are red blood cells red?")));
    expect(evs.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(evs[1]).toMatchObject({ name: "tutor.explain", ok: true });
    expect(evs[2]).toEqual({ type: "text", text: "Red blood cells carry oxygen around the body." });
    expect(evs[3]).toMatchObject({ sources: ["tutor.explain", "kit"], label: "grounded" });
    expect(mocks.constructed).toEqual([]);
    expect(teacher.calls).toHaveLength(1);
    expect(teacher.calls[0]!.system).toContain(SK_STUDENT_RULES);
    expect(db.rows("sk_usage")).toEqual([expect.objectContaining({ user_id: STUDENT, live_turns: 1, generated_segments: 0 })]);
  });

  it("the same turn resent (same turn id): replayed, still one call and one live turn", async () => {
    const id = tid();
    const body = (text: string) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnId: id, text, modality: "text", collector: { path: `/sk/${SLUG}/5`, locale: "en", tutor: TUTOR } }) });
    await readEvents(await turnPOST(body("explain this")));
    const again = await readEvents(await turnPOST(body("explain this")));
    expect(again.find((e) => e.type === "text")).toEqual({ type: "text", text: "Red blood cells carry oxygen around the body." });
    expect(teacher.calls).toHaveLength(1);
    expect(db.rows("sk_usage")[0]).toMatchObject({ live_turns: 1 });
  });

  it("no lesson open: her chapters, no model", async () => {
    const evs = await readEvents(await turnPOST(turn("what is a cell?", { collector: { path: "/sk", locale: "en" } })));
    expect(evs[1]).toMatchObject({ name: "tutor.where", ok: true });
    expect(String(evs.find((e) => e.type === "text")?.text)).toContain("Chapter 5: Specialised Cells and Tissues");
    expect(teacher.calls).toHaveLength(0);
    expect(mocks.constructed).toEqual([]);
  });

  it("a chapter is a navigate to her book's chapter page", async () => {
    const evs = await readEvents(await turnPOST(turn("open chapter 1")));
    expect(evs.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: `/sk/${SLUG}/1`, label: "SK Tutor" });
  });
});

describe("the greeting", () => {
  it("on a kit's page: \"Hi Aisha — you were on <section> of <kit>. Carry on?\" — and yes plays it", async () => {
    const res = await contextPOST(context({ tutor: TUTOR }));
    expect(res.status).toBe(200);
    const d = (await res.json()) as { greeting: string; memory: string; capabilities: string[] };
    expect(d.greeting).toBe("Hi Aisha — you were on Red blood cells of Specialised Cells and Tissues. Carry on?");
    expect(d.capabilities).toContain("tutor.explain");
    expect(d.capabilities).not.toContain("board.intro");
    const evs = await readEvents(await turnPOST(turn("yes", { memory: d.memory })));
    expect(evs.find((e) => e.type === "tutor")).toMatchObject({ move: "play" });
    expect(teacher.calls).toHaveLength(0);
  });
  it("elsewhere on /sk with no kit session: her chapters", async () => {
    const d = (await (await contextPOST(context({ path: "/sk" }))).json()) as { greeting: string };
    expect(d.greeting).toMatch(/^Hi Aisha — here are your chapters: Chapter 1: Cells; .*Chapter 5: Specialised Cells and Tissues.*\. Which one shall we open\?$/);
  });
});

describe("the student rule block and the student lines", () => {
  it("is in a student's Shell prompt and never in a teacher's", () => {
    const s = makeCtx({ role: "student", hat: null });
    expect(buildShellPrompt({ ctx: s, capabilities: [] })).toContain(SK_STUDENT_RULES);
    expect(SK_STUDENT_RULES).toMatch(/Never give the answer to a practice or quiz question/);
    expect(SK_STUDENT_RULES).toMatch(/another learner/);
    expect(buildShellPrompt({ ctx: makeCtx({ role: "teacher", hat: "teacher" }), capabilities: [] })).not.toContain("STUDENT RULES");
  });
  it("SK's student lines are the dictionaries' sk.shell.tutor.* in all ten locales", () => {
    const files: Record<string, { sk: { shell: { tutor: Record<string, string>; tutorNotOpen: string } } }> = { en, ms, "ms-arab": msArab, ar, fr, es, pt, te, mr, hi };
    for (const [locale, file] of Object.entries(files)) {
      const dict = file.sk.shell.tutor;
      expect(Object.keys(dict).sort(), locale).toEqual(Object.keys(TUTOR_LINE_KEYS).sort());
      for (const [key, table] of Object.entries(TUTOR_LINE_KEYS)) expect(dict[key], `${locale} ${key}`).toBe(table[locale]);
      expect(file.sk.shell.tutorNotOpen.length).toBeGreaterThan(0);
    }
  });
  it("every non-English line is a real translation, and Jawi is written in Jawi", () => {
    for (const [key, table] of Object.entries(TUTOR_LINE_KEYS)) {
      for (const l of ["ms", "ms-arab", "ar", "fr", "es", "pt", "te", "mr", "hi"]) expect(table[l], `${key} ${l}`).not.toBe(table.en);
      expect(table["ms-arab"].replace(/\{\w+\}|SK/g, ""), key).not.toMatch(/[A-Za-z]/);
    }
  });
});

describe("a student's 'say that in Malay' (2026-10-30)", () => {
  it("repeats her last explanation through the kit turn: ONE more call, ONE more live turn, never the Shell's model; a resend replays", async () => {
    const first = await readEvents(await turnPOST(turn("why are red blood cells red?")));
    const memory = (first.find((e) => e.type === "done") as { memory: string }).memory;
    const id = tid();
    const body = () =>
      new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnId: id, text: "say that in Malay", modality: "text", memory, collector: { path: `/sk/${SLUG}/5`, locale: "en", tutor: TUTOR } }) });
    const evs = await readEvents(await turnPOST(body()));
    expect(evs.map((e) => e.type)).toEqual(["meta", "lang", "text", "done"]);
    expect(evs[0]).toMatchObject({ intent: "lang" });
    expect(evs[1]).toEqual({ type: "lang", lang: "ms", dir: "ltr", speech: "ms-MY", override: true });
    // The kit's provider re-expressed the ORIGINAL (the stub's second line stands in for the Malay).
    expect(evs[2]).toEqual({ type: "text", text: "Red blood cells have no nucleus." });
    expect(teacher.calls).toHaveLength(2);
    expect(teacher.calls[1]!.system).toContain("Red blood cells carry oxygen around the body.");
    expect(mocks.constructed).toEqual([]);
    expect(db.rows("sk_usage")).toEqual([expect.objectContaining({ user_id: STUDENT, live_turns: 2 })]);
    // Resent with the same turn id: replayed, never a third call or a third live turn.
    await readEvents(await turnPOST(body()));
    expect(teacher.calls).toHaveLength(2);
    expect(db.rows("sk_usage")[0]).toMatchObject({ live_turns: 2 });
  });
});
