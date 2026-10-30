/**
 * "SK understands an action however it is phrased" through POST
 * /api/sk/shell/turn (founder 2026-10-30: "SK does not show me around when i
 * use the phrase 'Hi SK, show me around?'"):
 *   - the founder's exact phrase, and framed paraphrases of the tour and the
 *     language commands, are decided by the RULES — the same events as the
 *     bare phrase, and no model is constructed;
 *   - a real question with the same words still goes to the model;
 *   - the model's safety net: when the model picks start_tour / tour_control /
 *     set_answer_language / repeat_in_language, the route stops it (one model
 *     round, no narration round) and emits exactly what the rule emits.
 * Stub providers only — no paid model call.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-intent.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  queue: [] as unknown[][],
  constructed: [] as string[],
  opts: [] as GenerateOpts[],
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
        super((mocks.queue.shift() ?? [{ text: ["(unscripted)"] }]) as StubTurn[]);
        mocks.constructed.push(model);
      }
      async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
        mocks.opts.push(opts);
        yield* super.stream(opts);
      }
    },
  };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { LANG_SWITCHED } from "@/sk/shell/language-lines";
import { WALKTHROUGH_START } from "@/sk/shell/walkthrough-lines";
import { verifyMemory } from "@/sk/shell/memory";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "SK_SHELL_MODEL", "SK_TRANSLATE_MODEL", "SK_AUDIT"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
const tables = () => ({
  profiles: [{ role: "teacher", school_id: SCHOOL_ID }],
  schools: [{ config: {} }],
  coordinator_scope: [],
  parent_links: [],
  classes: [{ id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
  enrollments: [],
  books: [],
});

type Ev = Record<string, unknown> & { type: string };
const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const turn = (text: string, extra: Record<string, unknown> = {}) => ({ turnId: `t-${Math.random().toString(36).slice(2)}`, text, modality: "text", collector: { path: "/dashboard", locale: "en" }, ...extra });
async function say(text: string, extra: Record<string, unknown> = {}): Promise<{ ev: Ev[]; text: string; done: Ev; memory: string }> {
  const ev = (await readEvents(await POST(req(turn(text, extra))))) as Ev[];
  const done = ev.find((e) => e.type === "done")!;
  return { ev, done, memory: done.memory as string, text: ev.filter((e) => e.type === "text").map((e) => e.text).join("") };
}
const START_LINE = WALKTHROUGH_START.en;

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "route-test-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  mocks.cookies = { sc_hat: "teacher" };
  mocks.queue = [];
  mocks.constructed = [];
  mocks.opts = [];
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
  mocks.createClient.mockResolvedValue(fakeSession(tables(), { user: USER }));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

describe("the founder's phrase, end to end", () => {
  it("'Hi SK, show me around?' → the walkthrough START event and its line, no model", async () => {
    const r = await say("Hi SK, show me around?");
    expect(r.ev.map((e) => e.type)).toEqual(["meta", "walkthrough", "text", "done"]);
    expect(r.ev[0]).toMatchObject({ intent: "tour" });
    expect(r.ev[1]).toEqual({ type: "walkthrough" }); // no action = start from stop 1
    expect(r.text).toBe(START_LINE);
    expect(r.done).toMatchObject({ sources: [], label: "navigation" });
    expect(mocks.constructed).toEqual([]);
  });
  it("the same for framed paraphrases in several languages", async () => {
    for (const text of [
      "Hey SK! Can I get a tour?",
      "Could you walk me through the app, please?",
      "OK so how does this app work?",
      "Give me a quick demo, thanks",
      "Assalamualaikum SK, tunjukkan sekeliling",
      "مرحبا، خذني في جولة؟",
      "Bonjour SK, fais-moi visiter",
      "नमस्ते SK, मुझे सब दिखाओ।",
    ]) {
      const r = await say(text);
      // (A message written in Arabic or Hindi also carries a `lang` event: the
      // start line is said in her language.)
      const types = r.ev.map((e) => e.type).filter((t) => t !== "lang");
      expect(types, text).toEqual(["meta", "walkthrough", "text", "done"]);
      expect(r.ev.find((e) => e.type === "walkthrough"), text).toEqual({ type: "walkthrough" });
      expect(r.ev[0], text).toMatchObject({ intent: "tour" });
    }
    expect(mocks.constructed).toEqual([]);
  });
  it("a real question with the same words still goes to the model (and starts nothing)", async () => {
    mocks.queue.push([{ text: ["The membrane controls what enters the cell."] }]);
    const r = await say("Hi SK, show me around the cell membrane?");
    expect(r.ev[0]).toMatchObject({ intent: "ask" });
    expect(r.ev.some((e) => e.type === "walkthrough")).toBe(false);
    expect(mocks.constructed).toHaveLength(1);
  });
  it("a framed tour command while the tour is on moves the running tour, no model", async () => {
    const walk = { active: true, paused: true, role: "teacher", stop: "output", index: 3, total: 14 };
    const r = await say("Hey SK, please continue the tour, thanks!", { walk });
    expect(r.ev.map((e) => e.type)).toEqual(["meta", "walkthrough", "done"]);
    expect(r.ev[1]).toEqual({ type: "walkthrough", action: "resume" });
    expect(mocks.constructed).toEqual([]);
  });
  it("a framed language switch is the rule's switch, no model", async () => {
    const r = await say("Hi SK, could you speak Arabic from now on, please?");
    expect(r.ev[0]).toMatchObject({ intent: "lang" });
    expect(r.ev.find((e) => e.type === "lang")).toEqual({ type: "lang", lang: "ar", dir: "rtl", speech: "ar-SA", override: true });
    expect(r.text).toBe(LANG_SWITCHED.ar.replace("{language}", "العربية"));
    expect(verifyMemory(r.memory)!.langOverride).toBe("ar");
    expect(mocks.constructed).toEqual([]);
  });
});

describe("the model's safety net (shell-controls.ts)", () => {
  it("start_tour → the walkthrough START event and the rule's line; the model stops after ONE round", async () => {
    // A phrasing no rule takes: the model picks the tool.
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "start_tour", args: {} }] }, { text: ["(must never be asked for)"] }]);
    const r = await say("I'm totally new to all this, where do I even begin");
    expect(r.ev[0]).toMatchObject({ intent: "ask" });
    expect(r.ev.map((e) => e.type)).toEqual(["meta", "tool", "walkthrough", "text", "done"]);
    expect(r.ev.find((e) => e.type === "walkthrough")).toEqual({ type: "walkthrough" });
    expect(r.text).toBe(START_LINE);
    expect(r.done).toMatchObject({ sources: ["start_tour"], label: "navigation", usage: { inputTokens: 100, outputTokens: 50 } });
    expect(mocks.constructed).toHaveLength(1);
    expect(mocks.opts).toHaveLength(1); // no narration round
    // The tools the model saw include the four controls.
    const names = (mocks.opts[0]!.tools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["start_tour", "tour_control", "set_answer_language", "repeat_in_language"]));
    expect(mocks.opts[0]!.system).toContain("start_tour");
  });
  it("tour_control → the walkthrough action for the running tour", async () => {
    const walk = { active: true, paused: false, role: "teacher", stop: "output", index: 3, total: 14 };
    for (const action of ["next", "back", "pause", "skip", "resume"]) {
      mocks.queue.push([{ toolCalls: [{ id: "c1", name: "tour_control", args: { action } }] }]);
      const r = await say("hmm can we have a look at whatever comes after this bit", { walk });
      expect(r.ev.find((e) => e.type === "walkthrough"), action).toEqual({ type: "walkthrough", action });
      expect(r.done, action).toMatchObject({ sources: ["tour_control"], label: "navigation" });
    }
  });
  it("tour_control with a bad action is refused and nothing moves", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "tour_control", args: { action: "explode" } }] }, { text: ["I can't do that."] }]);
    const r = await say("do something odd with the tour thing");
    expect(r.ev.some((e) => e.type === "walkthrough")).toBe(false);
  });
  it("set_answer_language → the switch the rule makes (lang event, line, sticky override), no translation call", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "set_answer_language", args: { language: "Hindi" } }] }]);
    const r = await say("my colleagues mostly use Hindi so let's keep things in that");
    expect(r.ev.find((e) => e.type === "lang" && e.lang === "hi")).toEqual({ type: "lang", lang: "hi", dir: "ltr", speech: "hi-IN", override: true });
    expect(r.text).toBe(LANG_SWITCHED.hi.replace("{language}", "हिन्दी"));
    const mem = verifyMemory(r.memory)!;
    expect(mem.langOverride).toBe("hi");
    expect(mem.lastAnswer).toBeUndefined(); // the switch line is never "the last explanation"
    expect(r.done).toMatchObject({ usage: { inputTokens: 100, outputTokens: 50 } });
    expect(mocks.constructed).toHaveLength(1);
  });
  it("set_answer_language 'my language' → back to the page's language (override cleared)", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "set_answer_language", args: { language: "my language" } }] }]);
    const r = await say("whatever the page uses is fine for me");
    expect(r.text).toBe(LANG_SWITCHED.en.replace("{language}", "English"));
    expect(verifyMemory(r.memory)!.langOverride).toBeUndefined();
  });
  it("repeat_in_language → the rule's repeat: ONE translation call on the last answer", async () => {
    const EXPLANATION = "Diffusion is the movement of particles from a high concentration to a low one.";
    mocks.queue.push([{ text: [EXPLANATION] }]);
    const first = await say("what is diffusion");
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "repeat_in_language", args: { language: "ms" } }] }]);
    mocks.queue.push([{ text: ["Resapan ialah pergerakan zarah dari kepekatan tinggi ke kepekatan rendah."] }]);
    const r = await say("hmm my students would follow that better in their mother tongue, Malay", { memory: first.memory });
    expect(r.ev.find((e) => e.type === "lang" && e.lang === "ms")).toMatchObject({ lang: "ms", override: true });
    expect(r.text).toBe("Resapan ialah pergerakan zarah dari kepekatan tinggi ke kepekatan rendah.");
    expect(r.done).toMatchObject({ sources: ["sk.repeat"] });
    // The Shell model (one round) + the translation model — as the rule's repeat.
    expect(mocks.constructed).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    const mem = verifyMemory(r.memory)!;
    expect(mem.langOverride).toBe("ms");
    expect(mem.lastAnswer?.text).toBe(EXPLANATION);
  });
  it("an unsupported language → 'I can speak …', no translation call", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "set_answer_language", args: { language: "Klingon" } }] }]);
    const r = await say("speak to me like a Klingon would");
    expect(r.text).toContain("English");
    expect(r.done).toMatchObject({ label: "declined" });
    expect(mocks.constructed).toHaveLength(1);
  });
});
