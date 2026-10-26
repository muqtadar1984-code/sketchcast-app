// SK B4 — the intent router: the regex layer needs no network; the model
// proposal is validated by code; the default is a question.
import { describe, expect, it } from "vitest";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { classify, classifyByRules, parseProposal, ROUTER_TOOL } from "../router";
import { graph } from "./fixtures";

const g = graph();
const rules = (text: string, checkOpen = false) => classifyByRules(text, g, checkOpen);

describe("regex layer: the closed command set", () => {
  it.each([
    ["repeat", "repeat"],
    ["Can you say that again?", "repeat"],
    ["slower please", "slower"],
    ["you're going too fast", "slower"],
    ["erase that", "erase"],
    ["clear the board", "erase"],
    ["continue", "continue"],
    ["ok go on", "continue"],
    ["next", "continue"],
  ])("%s → command %s", (text, name) => {
    const i = rules(text)!;
    expect(i.kind).toBe("command");
    expect(i.command?.name).toBe(name);
    expect(i.source).toBe("regex");
  });
  it("skip: a bare skip or 'I know this' skips the UNIT with the check; 'skip this bit' skips the segment", () => {
    expect(rules("skip")!).toMatchObject({ kind: "route", command: { name: "skip", args: { scope: "unit", withCheck: true } } });
    expect(rules("I already know this")!.command?.args.scope).toBe("unit");
    expect(rules("skip unit 5")!.command?.args.unitKey).toBe("u5");
    expect(rules("skip this bit")!).toMatchObject({ kind: "command", command: { name: "skip", args: { scope: "segment" } } });
  });
  it("goto resolves unit keys, numbers and titles; a thing (not a unit) is a return", () => {
    expect(rules("go to unit 5")!).toMatchObject({ kind: "route", command: { name: "goto", args: { unitKey: "u5" } } });
    expect(rules("jump to u2")!.command?.args.unitKey).toBe("u2");
    expect(rules("take me to actual size")!.command?.args.unitKey).toBe("u5");
    expect(rules("go back to the microscope")!.command?.name).toBe("return");
    expect(rules("go back to unit 2")!.command).toEqual({ name: "goto", args: { unitKey: "u2" } });
    expect(rules("go back")!.command?.name).toBe("return");
    expect(rules("take me back to where I was")!.command?.name).toBe("return");
  });
  it("practise / check me / explain again, with styles and counts", () => {
    expect(rules("give me 3 questions")!).toMatchObject({ kind: "route", command: { name: "practise", args: { n: 3 } } });
    expect(rules("let's practise")!.command).toEqual({ name: "practise", args: {} });
    expect(rules("check me")!.command).toEqual({ name: "practise", args: { n: 0 } });
    expect(rules("explain that again")!.command).toEqual({ name: "explain_again", args: {} });
    expect(rules("I don't get it")!.command?.name).toBe("explain_again");
    expect(rules("can you draw it?")!.command?.args.style).toBe("visual");
    expect(rules("explain it more simply")!.command?.args.style).toBe("simpler");
  });
  it("has no answer for a real question, or for a bare word with no check open", () => {
    expect(rules("why does the image look bigger?")).toBeNull();
    expect(rules("b")).toBeNull();
  });
  it("with a check open, a short bare token is an answer", () => {
    expect(rules("b", true)).toMatchObject({ kind: "answer", source: "regex" });
    expect(rules("×400", true)?.kind).toBe("answer");
    expect(rules("what is an objective?", true)).toBeNull(); // still a question
  });
});

describe("the model proposal is validated by code", () => {
  it("accepts a well-formed proposal", () => {
    expect(parseProposal({ kind: "route", command: "goto", unitKey: "u5", confidence: 0.9, needsGrounding: false }, g, false)).toMatchObject({ kind: "route", command: { name: "goto", args: { unitKey: "u5" } }, source: "llm", confidence: 0.9 });
    expect(parseProposal({ kind: "question", needsGrounding: true, confidence: 0.7 }, g, false)).toMatchObject({ kind: "question", needsGrounding: true });
  });
  it("refuses an unknown command, an unknown unit, a goto without a unit, or a bad kind", () => {
    expect(parseProposal({ kind: "command", command: "launch_missiles", confidence: 1 }, g, false)).toBeNull();
    expect(parseProposal({ kind: "route", command: "goto", unitKey: "u99", confidence: 1 }, g, false)).toBeNull();
    expect(parseProposal({ kind: "route", command: "goto", confidence: 1 }, g, false)).toBeNull();
    expect(parseProposal({ kind: "spell", confidence: 1 }, g, false)).toBeNull();
  });
  it("an 'answer' with no open check becomes a question; a skip route gets the check", () => {
    expect(parseProposal({ kind: "answer", confidence: 0.8 }, g, false)?.kind).toBe("question");
    expect(parseProposal({ kind: "answer", confidence: 0.8 }, g, true)?.kind).toBe("answer");
    expect(parseProposal({ kind: "route", command: "skip", confidence: 0.8 }, g, false)?.command?.args).toEqual({ scope: "unit", withCheck: true });
    expect(parseProposal({ kind: "command", command: "skip", confidence: 0.8 }, g, false)).toMatchObject({ kind: "command", command: { args: { scope: "segment" } } });
  });
  it("the tool schema is closed: enums for kind and command", () => {
    const props = (ROUTER_TOOL.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.kind!.enum).toEqual(["command", "route", "question", "answer"]);
    expect(props.command!.enum).toContain("explain_again");
    expect((ROUTER_TOOL.parameters as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });
});

describe("classify()", () => {
  it("never calls the model when the regex layer answers", async () => {
    const provider = new StubProvider([{ toolCalls: [{ id: "t", name: "classify_utterance", args: { kind: "question", confidence: 1 } }] }]);
    const i = await classify("repeat", { graph: g, checkOpen: false, provider });
    expect(i.command?.name).toBe("repeat");
    expect(provider.calls).toHaveLength(0);
  });
  it("uses the model's validated proposal otherwise, with the strict tool and a short prompt", async () => {
    const provider = new StubProvider([{ toolCalls: [{ id: "t", name: "classify_utterance", args: { kind: "route", command: "practise", n: 2, confidence: 0.85, needsGrounding: false } }] }]);
    const i = await classify("hmm could I try a couple myself", { graph: g, checkOpen: false, provider });
    expect(i).toMatchObject({ kind: "route", command: { name: "practise", args: { n: 2 } }, source: "llm" });
    expect(provider.calls[0]!.tools).toEqual([ROUTER_TOOL]);
    expect(provider.calls[0]!.system).toContain("u5: Actual size");
  });
  it("falls back to question when the proposal is invalid, the model errors, or there is no provider", async () => {
    const bad = new StubProvider([{ toolCalls: [{ id: "t", name: "classify_utterance", args: { kind: "route", command: "goto", unitKey: "u99", confidence: 1 } }] }]);
    expect((await classify("go somewhere", { graph: g, checkOpen: false, provider: bad })).kind).toBe("question");
    const erroring = { id: "x", model: "x", async *stream() { yield { type: "error" as const, message: "boom" }; } };
    expect((await classify("why?", { graph: g, checkOpen: false, provider: erroring })).source).toBe("default");
    expect(await classify("why is the sky blue", { graph: g, checkOpen: false })).toMatchObject({ kind: "question", source: "default", needsGrounding: true });
    expect((await classify("40", { graph: g, checkOpen: true })).kind).toBe("answer");
  });
});
