/**
 * AI Teaching Assistant core — the invariants a reviewer must see hold:
 *  * Option-B grounding decides in_scope / off_topic / no_book correctly, and a
 *    contextless follow-up stays on the active topic.
 *  * the decline + no-book messages reference REAL in-scope topics (never
 *    answer "from nowhere").
 *  * the orchestrator runs a tool round then narrates, and is provider-agnostic
 *    (the StubProvider proves the swap — no Gemini/Anthropic refs needed).
 *  * the system-prompt contract injects the book grounding + the honest-mastery
 *    and stay-on-curriculum rules.
 * Run: npx vitest run
 */

import { describe, expect, it } from "vitest";
import { decideScope, scoreTopics, type Topic } from "@/utils/assistant/scope";
import { buildAssistantPrompt, declineMessage, NO_BOOK_MESSAGE } from "@/utils/assistant/prompt";
import { runAssistantTurn } from "@/utils/assistant/orchestrator";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { toGeminiContents, toGeminiBody } from "@/utils/assistant/providers/gemini";

const TOPICS: Topic[] = [
  { bookId: "b1", bookTitle: "Science 7", chapterNum: 1, title: "Cells and their structure" },
  { bookId: "b1", bookTitle: "Science 7", chapterNum: 2, title: "Photosynthesis in plants" },
  { bookId: "b1", bookTitle: "Science 7", chapterNum: 3, title: "Forces and motion" },
];

describe("Option-B scope decision", () => {
  it("in_scope: a question overlapping a topic grounds on the best chapter", () => {
    const d = decideScope("how does photosynthesis work?", TOPICS);
    expect(d.kind).toBe("in_scope");
    if (d.kind === "in_scope") expect(d.best.chapterNum).toBe(2);
  });

  it("off_topic: no overlap → decline, with REAL topics to redirect to", () => {
    const d = decideScope("who won the football world cup?", TOPICS);
    expect(d.kind).toBe("off_topic");
    if (d.kind === "off_topic") expect(d.suggestTopics.length).toBeGreaterThan(0);
  });

  it("no_book: empty scope → no_book state", () => {
    expect(decideScope("anything", []).kind).toBe("no_book");
  });

  it("a contextless follow-up stays on the active topic", () => {
    const active = TOPICS[1]!; // photosynthesis
    const d = decideScope("explain that one more time", TOPICS, { activeTopic: active });
    expect(d.kind).toBe("in_scope");
    if (d.kind === "in_scope") expect(d.best.chapterNum).toBe(2);
  });

  it("scoreTopics is deterministic and ranks the overlap first", () => {
    const ranked = scoreTopics("cells structure", TOPICS);
    expect(ranked[0]!.chapterNum).toBe(1);
    expect(ranked).toEqual(scoreTopics("cells structure", TOPICS));
  });
});

describe("messages reference real in-scope topics", () => {
  it("declineMessage names actual topics + subject", () => {
    const msg = declineMessage(TOPICS, "Science");
    expect(msg).toContain("Cells and their structure");
    expect(msg).toContain("Science");
  });
  it("NO_BOOK_MESSAGE never pretends to answer", () => {
    expect(NO_BOOK_MESSAGE.toLowerCase()).toContain("book");
  });
});

describe("system-prompt contract", () => {
  it("injects the book grounding + the core rules", () => {
    const sys = buildAssistantPrompt({
      gradeLabel: "Grade 7",
      grounding: { bookTitle: "Science 7", chapterTitle: "Cells", excerpt: "A cell is the basic unit of life." },
      topicList: ["Cells", "Photosynthesis"],
      mathToolsAvailable: true,
    });
    expect(sys).toContain("A cell is the basic unit of life.");
    expect(sys).toContain("BOOK-FIRST");
    expect(sys).toMatch(/NEVER hand over final answers/i);
    expect(sys).toContain("Grade 7");
    expect(sys).toMatch(/math tools/i);
  });
});

describe("orchestrator (provider-agnostic)", () => {
  it("streams text from a stub provider with no tools", async () => {
    const provider = new StubProvider([{ text: ["Photo", "synthesis ", "is…"] }]);
    let out = "";
    let done = false;
    for await (const ev of runAssistantTurn({ provider, system: "s", history: [], question: "explain" })) {
      if (ev.type === "text") out += ev.text;
      if (ev.type === "done") done = true;
    }
    expect(out).toBe("Photosynthesis is…");
    expect(done).toBe(true);
    expect(provider.calls[0]!.messages.at(-1)).toEqual({ role: "user", text: "explain" });
  });

  it("runs a tool round, feeds the result back, then narrates", async () => {
    const provider = new StubProvider([
      { toolCalls: [{ id: "t1", name: "solve", args: { expr: "x**2-5*x+6=0" } }] },
      { text: ["The solutions are x=2 and x=3."] },
    ]);
    const toolInputs: string[] = [];
    let toolEvent = "";
    let out = "";
    for await (const ev of runAssistantTurn({
      provider,
      system: "s",
      history: [],
      question: "solve x^2-5x+6=0",
      tools: [{ name: "solve", description: "d", parameters: {} }],
      runTool: async (call) => {
        toolInputs.push(String(call.args.expr));
        return JSON.stringify({ ok: true, result: ["2", "3"] });
      },
    })) {
      if (ev.type === "tool") toolEvent = ev.name;
      if (ev.type === "text") out += ev.text;
    }
    expect(toolEvent).toBe("solve");
    expect(toolInputs).toEqual(["x**2-5*x+6=0"]);
    expect(out).toContain("x=2 and x=3");
    // Second provider call must include the tool result in the message history.
    const second = provider.calls[1]!;
    expect(second.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("surfaces a retryable error without crashing", async () => {
    const provider: import("@/utils/assistant/provider").LLMProvider = {
      id: "boom",
      model: "x",
      async *stream() {
        yield { type: "error", message: "rate limited", retryable: true };
      },
    };
    const events = [];
    for await (const ev of runAssistantTurn({ provider, system: "s", history: [], question: "q" })) events.push(ev);
    expect(events).toEqual([{ type: "error", message: "rate limited", retryable: true }]);
  });
});

describe("gemini adapter mapping (pure, no network)", () => {
  it("maps turns to Gemini contents incl. tool round-trip", () => {
    const contents = toGeminiContents([
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "solve", args: { expr: "x=1" } }] },
      { role: "tool", toolCallId: "t1", name: "solve", result: "1" },
    ]);
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
    expect(contents[1]!.parts[0]).toHaveProperty("functionCall");
    expect(contents[2]!.parts[0]).toHaveProperty("functionResponse");
  });
  it("includes tools + system instruction in the body", () => {
    const body = toGeminiBody({ system: "sys", messages: [{ role: "user", text: "q" }], tools: [{ name: "solve", description: "d", parameters: { type: "object" } }] });
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body).toHaveProperty("tools");
  });
});
