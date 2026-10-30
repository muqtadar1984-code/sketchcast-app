/**
 * Model-first routing, pure parts (routing.ts): the env switch, the model
 * chooser (Haiku for short commands, Sonnet for teaching), escalation, the
 * hand-offs and the pre-model book-code rule. Stub providers only.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/routing.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubProvider, type StubTurn } from "@/utils/assistant/providers/stub";
import type { StreamEvent } from "@/utils/assistant/provider";
import { SkModelProvider, addUsage, chooseModel, escalationReason, escalationTools, handoffAfter, handoffBefore, isTeachingAsk, modelFirstDecision, skRouting } from "../routing";
import { makeCtx } from "./fixtures";
import type { SkContext } from "../types";

const ENV = ["SK_ROUTING", "SK_MODEL_FIRST_EMAILS", "SK_FAST_MODEL", "SK_SHELL_MODEL"];
beforeEach(() => {
  for (const k of ENV) vi.stubEnv(k, "");
});
afterEach(() => vi.unstubAllEnvs());

const teacher = makeCtx();
const student = makeCtx({ role: "student", hat: null, schoolId: null });
const withBoard = (c: SkContext): SkContext => ({ ...c, board: { sessionId: "s1", k: 0 } as SkContext["board"] });

describe("skRouting (SK_ROUTING / SK_MODEL_FIRST_EMAILS)", () => {
  it("defaults to rules", () => {
    expect(skRouting("t@school.example")).toBe("rules");
    expect(skRouting(null)).toBe("rules");
  });
  it("the allow-list turns model on for the listed users only (case-insensitive)", () => {
    vi.stubEnv("SK_MODEL_FIRST_EMAILS", " Founder@SketchCast.app, other@x.example ");
    expect(skRouting("founder@sketchcast.app")).toBe("model");
    expect(skRouting("FOUNDER@sketchcast.app")).toBe("model");
    expect(skRouting("t@school.example")).toBe("rules");
    expect(skRouting(undefined)).toBe("rules");
  });
  it("SK_ROUTING=model is everyone; SK_ROUTING=rules is the rollback that ignores the list", () => {
    vi.stubEnv("SK_MODEL_FIRST_EMAILS", "founder@sketchcast.app");
    vi.stubEnv("SK_ROUTING", "model");
    expect(skRouting("anyone@x.example")).toBe("model");
    vi.stubEnv("SK_ROUTING", "RULES");
    expect(skRouting("founder@sketchcast.app")).toBe("rules");
  });
});

describe("chooseModel", () => {
  const tier = (text: string, ctx: SkContext = teacher) => chooseModel(text, ctx).tier;
  it("Haiku for short or command-like messages", () => {
    for (const t of ["Hi SK, show me around?", "play chapter 1 of biology", "say that in Arabic", "post a notice to 7B: bring hats", "open my timetable", "thanks", "how many classes do I have?", "what's on my timetable today?", "buka diari 7B", "افتح التقويم"]) {
      expect(tier(t), t).toBe("fast");
    }
    expect(chooseModel("open analytics", teacher)).toEqual({ tier: "fast", model: "claude-haiku-5-5", reason: "command" });
  });
  it("Sonnet for teaching and explanations, whatever the length", () => {
    for (const t of ["explain photosynthesis", "why do plants need light?", "what is osmosis?", "compare mitosis and meiosis", "how does the heart pump blood", "terangkan fotosintesis", "اشرح البناء الضوئي"]) {
      expect(tier(t), t).toBe("full");
    }
    expect(chooseModel("explain photosynthesis", teacher)).toEqual({ tier: "full", model: "claude-sonnet-5-5", reason: "teaching_ask" });
  });
  it("Sonnet whenever a lesson, a kit or a highlight is open — even for 'next slide'", () => {
    expect(chooseModel("next slide", withBoard(teacher)).reason).toBe("teaching_open");
    expect(tier("pause", { ...student, tutor: { kit: "k1" } as SkContext["tutor"] })).toBe("full");
  });
  it("Sonnet for a long message that is not a command", () => {
    const long = "I was wondering whether you could look across all of my classes this term and tell me which of the units my students seem to find hardest overall";
    expect(chooseModel(long, teacher)).toMatchObject({ tier: "full", reason: "long" });
  });
  it("honours SK_FAST_MODEL and SK_SHELL_MODEL", () => {
    vi.stubEnv("SK_FAST_MODEL", "claude-haiku-4-5");
    vi.stubEnv("SK_SHELL_MODEL", "claude-sonnet-5");
    expect(chooseModel("open analytics", teacher).model).toBe("claude-haiku-4-5");
    expect(chooseModel("explain osmosis", teacher).model).toBe("claude-sonnet-5");
  });
  it("a data question is not a teaching question", () => {
    expect(isTeachingAsk("what is due tomorrow for 7B?")).toBe(false);
    expect(isTeachingAsk("what is a nerve cell?")).toBe(true);
  });
});

describe("escalation", () => {
  const on = escalationTools(teacher);
  it("a knowledge / teaching tool in the first round escalates; others do not", () => {
    expect(escalationReason([{ id: "1", name: "knowledge__search", args: {} }], "", on)).toBe("tool:knowledge.search");
    expect(escalationReason([{ id: "1", name: "board__explain", args: {} }], "", on)).toBe("tool:board.explain");
    expect(escalationReason([{ id: "1", name: "navigate", args: {} }], "", on)).toBeNull();
  });
  it("low confidence or nothing said escalates; a plain answer does not", () => {
    expect(escalationReason([], "I'm not sure what you mean.", on)).toBe("low_confidence");
    expect(escalationReason([], "I have nothing on that.", on)).toBe("low_confidence");
    expect(escalationReason([], "  ", on)).toBe("empty");
    expect(escalationReason([], "You're welcome.", on)).toBeNull();
  });
  it("a student's knowledge.search / tutor.explain are hand-offs, never escalations", () => {
    const s = escalationTools(student);
    expect(s.has("knowledge.search")).toBe(false);
    expect(s.has("tutor.explain")).toBe(false);
    expect(on.has("knowledge.search")).toBe(true);
  });

  const drain = async (p: SkModelProvider) => {
    const out: StreamEvent[] = [];
    for await (const ev of p.stream({ system: "s", messages: [{ role: "user", text: "q" }] })) out.push(ev);
    return out;
  };
  const maker = (scripts: Record<string, StubTurn[]>, made: string[]) => (model: string) => {
    made.push(model);
    return new StubProvider(scripts[model] ?? [{ text: ["?"] }]);
  };

  it("SkModelProvider: a fast round that is fine passes through, one provider built", async () => {
    const made: string[] = [];
    const p = new SkModelProvider({ tier: "fast", model: "claude-haiku-5-5", reason: "command" }, maker({ "claude-haiku-5-5": [{ text: ["Opening Analytics."] }] }, made), on);
    const out = await drain(p);
    expect(out).toEqual([{ type: "text", text: "Opening Analytics." }, { type: "done", usage: { inputTokens: 100, outputTokens: 50 } }]);
    expect(made).toEqual(["claude-haiku-5-5"]);
    expect(p.stats).toMatchObject({ tier: "fast", models: ["claude-haiku-5-5"], rounds: 1, escalated: null });
    expect(p.stats.firstTokenMs).not.toBeNull();
  });
  it("SkModelProvider: a fast round that wants knowledge.search is replayed on Sonnet, usage summed, later rounds stay there", async () => {
    const made: string[] = [];
    const scripts = {
      "claude-haiku-5-5": [{ toolCalls: [{ id: "h1", name: "knowledge__search", args: { query: "x" } }] }],
      "claude-sonnet-5-5": [{ toolCalls: [{ id: "s1", name: "knowledge__search", args: { query: "x" } }] }, { text: ["From the book."] }],
    };
    const p = new SkModelProvider({ tier: "fast", model: "claude-haiku-5-5", reason: "short" }, maker(scripts, made), on);
    const r1 = await drain(p);
    expect(r1).toEqual([{ type: "tool_call", call: { id: "s1", name: "knowledge__search", args: { query: "x" } } }, { type: "done", usage: { inputTokens: 200, outputTokens: 100 } }]);
    const r2 = await drain(p);
    expect(r2[0]).toEqual({ type: "text", text: "From the book." });
    expect(made).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(p.stats).toMatchObject({ models: ["claude-haiku-5-5", "claude-sonnet-5-5"], rounds: 2, escalated: "tool:knowledge.search" });
  });
  it("SkModelProvider: the full tier never buffers or escalates", async () => {
    const made: string[] = [];
    const p = new SkModelProvider({ tier: "full", model: "claude-sonnet-5-5", reason: "teaching_ask" }, maker({ "claude-sonnet-5-5": [{ text: ["I'm not sure."] }] }, made), on);
    await drain(p);
    expect(made).toEqual(["claude-sonnet-5-5"]);
    expect(p.stats.escalated).toBeNull();
  });
  it("addUsage keeps the cache fields only when present", () => {
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 })).toEqual({ inputTokens: 4, outputTokens: 6 });
    expect(addUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 5 }, { inputTokens: 3, outputTokens: 4, cacheWriteTokens: 7 })).toEqual({ inputTokens: 4, outputTokens: 6, cacheReadTokens: 5, cacheWriteTokens: 7 });
  });
});

describe("hand-offs", () => {
  it("before: a student's knowledge.search; a teacher's bare start_lesson", () => {
    expect(handoffBefore("knowledge__search", { query: "x" }, student)).toBe("student_knowledge");
    expect(handoffBefore("knowledge__search", { query: "x" }, teacher)).toBeNull();
    expect(handoffBefore("start_lesson", {}, teacher)).toBe("lesson_plan");
    expect(handoffBefore("start_lesson", { class: "7B" }, teacher)).toBe("lesson_plan");
    expect(handoffBefore("start_lesson", { chapter: "1" }, teacher)).toBeNull();
    expect(handoffBefore("start_lesson", {}, student)).toBeNull();
  });
  it("after: a control, a tutor move or reply; nothing for a failed result or plain data", () => {
    expect(handoffAfter({ ok: true, summary: "", walkthrough: "start" })).toBe("control");
    expect(handoffAfter({ ok: true, summary: "", tutor: { move: "play", args: {} } } as never)).toBe("tutor");
    expect(handoffAfter({ ok: true, summary: "", reply: { text: "x", label: "grounded", sources: [] } })).toBe("tutor");
    expect(handoffAfter({ ok: false, summary: "", walkthrough: "start" })).toBeNull();
    expect(handoffAfter({ ok: true, summary: "x", facts: [{ a: 1 }] })).toBeNull();
  });
});

describe("modelFirstDecision (the pre-model rules)", () => {
  it("a book code is decided before the model, for every role", () => {
    expect(modelFirstDecision("my code is SKB-ABCD-EFGH", teacher)).toMatchObject({ intent: "act", action: "book.activate" });
  });
  it("everything else is the model's — including what the rules used to take", () => {
    for (const t of ["Hi SK, show me around?", "open analytics", "say that in Arabic", "thanks", "post a notice to 7B: bring hats", "I have a code"]) {
      expect(modelFirstDecision(t, teacher), t).toEqual({ intent: "ask" });
    }
  });
  it("the short answer to SK's own book question stays a rule", () => {
    const parent = { ...makeCtx({ role: "parent", hat: null }), pending: { task: "book.activate", needs: ["child"] } } as SkContext;
    expect(modelFirstDecision("Aisyah", parent)).toMatchObject({ intent: "act", action: "book.activate", book: { childQuery: "Aisyah" } });
  });
});
