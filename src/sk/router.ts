// SK B4 — the intent router. Turns one utterance into
//   { kind: command | route | question | answer, command?, needsGrounding, confidence }
// (contracts §4). Two layers:
//   1. a DETERMINISTIC regex layer for the closed command set — no model, no
//      network, and what the tests pin;
//   2. a Haiku proposal through the existing LLMProvider with a strict JSON
//      schema (one tool, closed enums), used only when the regex layer has no
//      answer. The proposal is VALIDATED by code: an unknown command, a unit
//      that is not in the graph or a malformed payload falls back to
//      `question`, never to a guess. The router may only propose (plan §3).

import type { LLMProvider, ToolDef } from "@/utils/assistant/provider";
import { resolveUnitKey } from "./graph";
import { COMMANDS, EXPLAIN_STYLES, ROUTE_COMMANDS, type Command, type CommandArgs, type CommandName, type ExplainStyle, type Intent, type TeachingGraph } from "./types";

export type RouterContext = {
  graph: TeachingGraph;
  /** A check is open → a bare word or number is an answer, not a question. */
  checkOpen: boolean;
  provider?: LLMProvider;
  signal?: AbortSignal;
  /** Deadline for the model proposal; after it the deterministic default answers. */
  timeoutMs?: number;
};

export const ROUTER_TOOL: ToolDef = {
  name: "classify_utterance",
  description: "Classify ONE student utterance to SK, the tutor. Choose exactly one kind. Use `command` for the closed set only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "needsGrounding", "confidence"],
    properties: {
      kind: { type: "string", enum: ["command", "route", "question", "answer"] },
      command: { type: "string", enum: [...COMMANDS] },
      unitKey: { type: "string", description: "A unit key from the list given, when the student names one." },
      n: { type: "integer", minimum: 1, maximum: 10 },
      style: { type: "string", enum: [...EXPLAIN_STYLES] },
      scope: { type: "string", enum: ["segment", "unit"] },
      needsGrounding: { type: "boolean", description: "true when answering needs the unit's content (a question about the topic)." },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
};

export function routerSystemPrompt(graph: TeachingGraph, checkOpen: boolean): string {
  const units = graph.units.map((u) => `${u.unit_key}: ${u.title}`).join("; ");
  return [
    "You classify what a school student just said to SK, an animated tutor, while a lesson segment is paused.",
    "Call classify_utterance exactly once. Never answer the student.",
    "kind=command for: repeat, slower, erase, continue, skip (scope segment). kind=route for: skip (scope unit), goto, practise, return, explain_again.",
    `kind=answer ONLY when a check question is open (open now: ${checkOpen ? "yes" : "no"}) and the student is answering it.`,
    "Otherwise kind=question. needsGrounding=true when the question is about the lesson topic.",
    `Units in this chapter: ${units}.`,
  ].join("\n");
}

const isCommand = (v: unknown): v is CommandName => typeof v === "string" && (COMMANDS as readonly string[]).includes(v);
const isStyle = (v: unknown): v is ExplainStyle => typeof v === "string" && (EXPLAIN_STYLES as readonly string[]).includes(v);

const intent = (kind: Intent["kind"], source: Intent["source"], confidence: number, command?: Command, needsGrounding = false): Intent => ({
  kind,
  ...(command ? { command } : {}),
  needsGrounding,
  confidence,
  source,
});

const cmd = (name: CommandName, args: CommandArgs = {}): Command => ({ name, args });
const kindFor = (name: CommandName, args: CommandArgs): Intent["kind"] => (ROUTE_COMMANDS.includes(name) && !(name === "skip" && args.scope === "segment") ? "route" : "command");

// ── Layer 1: deterministic patterns for the closed set ─────────────────────
// Order matters: a target-bearing "go back to unit 2" is a goto, a bare "go
// back" is a return; "skip this bit" skips the segment, "skip this unit" the unit.
const RX = {
  repeat: /^\s*(?:(?:can|could) you )?(?:repeat(?: that| it)?|say (?:that|it) again|(?:once )?again|replay|one more time|what did you say)\s*[.!?]*\s*$/i,
  slower: /\b(?:slower|slow down|too fast|not so fast)\b/i,
  erase: /^\s*(?:(?:please )?(?:erase|clear|wipe)(?: the board| that| it| this)?)\s*[.!?]*\s*$/i,
  continue: /^\s*(?:continue|go on|carry on|resume|keep going|next|ok(?:ay)?(?:,? (?:go on|continue|next))?|let'?s (?:go on|continue|move on)|move on)\s*[.!?]*\s*$/i,
  skipSegment: /\bskip (?:this |the )?(?:bit|segment|part|video|clip|explanation)\b/i,
  skipUnit: /(?:\bskip\b|\bi (?:already )?know (?:this|that|it)\b|\bi know all this\b)/i,
  gotoTarget: /\b(?:go|jump|take me|move|switch|back) (?:on )?to (?:the )?(?:unit |section |u)?([a-z0-9][a-z0-9 _-]{0,40}?)\s*[.!?]*\s*$/i,
  practise: /\b(?:practi[sc]e|exercises?|quiz me|give me (?:some |a few |(\d+) )?(?:questions|problems)|(\d+) (?:questions|problems)|let me try (?:some|a few))\b/i,
  checkMe: /\b(?:check me|test me|am i ready|quick check)\b/i,
  return: /^\s*(?:(?:go|take me) back(?: to (?:where (?:i|we) (?:was|were)|the (?:bookmark|diagram|drawing|microscope)))?|return|back)\s*[.!?]*\s*$/i,
  explainAgain: /\b(?:explain (?:that |it |this )?(?:again|differently|another way|more simply|simpler|in a simpler way)|i (?:don'?t|do not) (?:get|understand|follow)(?: it| this| that)?|(?:i'?m |i am )?confused|another example|show me (?:a picture|a diagram|visually)|can you draw (?:it|that|this))\b/i,
  styleSimpler: /\b(?:simpl|easier|easy|basic)/i,
  styleVisual: /\b(?:draw|picture|diagram|visual|show me)\b/i,
  numberOf: /\b(\d{1,2})\b/,
  /** A short bare token while a check is open: "b", "true", "40", "×400". */
  shortAnswer: /^\s*[×x]?\s*[a-z0-9.\-/%° ]{1,24}\s*$/i,
  /** Reads as a question: ends in "?" or opens with a question word. */
  question: /\?\s*$|^\s*(?:what|why|how|when|where|which|who|whose|can|could|would|should|is|are|do|does|did|will)\b/i,
};

export const looksLikeQuestion = (text: string): boolean => RX.question.test(text);

/** Layer 1 alone (exported so tests pin it). Returns null when nothing matched. */
export function classifyByRules(text: string, graph: TeachingGraph, checkOpen: boolean): Intent | null {
  const s = text.trim();
  if (!s) return null;
  const route = (c: Command) => intent(kindFor(c.name, c.args), "regex", 0.95, c);

  if (RX.repeat.test(s)) return route(cmd("repeat"));
  if (RX.slower.test(s)) return route(cmd("slower"));
  if (RX.erase.test(s)) return route(cmd("erase"));
  if (RX.continue.test(s)) return route(cmd("continue"));

  const goto = RX.gotoTarget.exec(s);
  if (goto) {
    // "go back to the microscope" names a THING → the bookmark; "go back to
    // unit 2" names a unit → goto. Only an explicit unit wins over "back".
    const back = /\bback\b/i.test(goto[0]);
    const explicitUnit = /\b(?:unit|section)\s?\d{1,2}\b|\b[us]\d{1,2}\b/i.test(s);
    if (back && !explicitUnit) return route(cmd("return"));
    const key = resolveUnitKey(graph, goto[1]!);
    if (key) return route(cmd("goto", { unitKey: key }));
    if (back) return route(cmd("return"));
  }
  if (RX.return.test(s)) return route(cmd("return"));

  if (RX.skipSegment.test(s)) return route(cmd("skip", { scope: "segment" }));
  if (RX.skipUnit.test(s)) {
    const m = /\b(?:unit|section|u)\s?(\d{1,2}|[a-z0-9_-]+)\b/i.exec(s);
    const unitKey = m ? resolveUnitKey(graph, m[1]!) : undefined;
    return route(cmd("skip", { scope: "unit", withCheck: true, ...(unitKey ? { unitKey } : {}) }));
  }
  if (RX.checkMe.test(s)) return intent("route", "regex", 0.9, cmd("practise", { n: 0 }));
  const pr = RX.practise.exec(s);
  if (pr) {
    const n = Number(pr[1] ?? pr[2] ?? RX.numberOf.exec(s)?.[1]);
    return route(cmd("practise", Number.isInteger(n) && n > 0 ? { n } : {}));
  }
  if (RX.explainAgain.test(s)) {
    const style: ExplainStyle | undefined = RX.styleVisual.test(s) ? "visual" : RX.styleSimpler.test(s) ? "simpler" : undefined;
    return route(cmd("explain_again", style ? { style } : {}));
  }
  if (checkOpen && RX.shortAnswer.test(s) && !/\?/.test(s)) return intent("answer", "regex", 0.8);
  return null;
}

/** Layer 2's output, validated by code. Exported so tests pin the validation. */
export function parseProposal(args: Record<string, unknown>, graph: TeachingGraph, checkOpen: boolean): Intent | null {
  const kind = args.kind;
  if (kind !== "command" && kind !== "route" && kind !== "question" && kind !== "answer") return null;
  const confidence = typeof args.confidence === "number" && Number.isFinite(args.confidence) ? Math.min(1, Math.max(0, args.confidence)) : 0.5;
  const needsGrounding = args.needsGrounding === true;
  if (kind === "question") return intent("question", "llm", confidence, undefined, needsGrounding);
  if (kind === "answer") return checkOpen ? intent("answer", "llm", confidence) : intent("question", "llm", confidence, undefined, needsGrounding); // an answer with no open check is a question
  if (!isCommand(args.command)) return null;
  const a: CommandArgs = {};
  if (typeof args.unitKey === "string") {
    const key = resolveUnitKey(graph, args.unitKey);
    if (!key) return null; // the model named a unit that does not exist → refuse the proposal
    a.unitKey = key;
  }
  if (typeof args.n === "number" && Number.isInteger(args.n) && args.n > 0) a.n = Math.min(10, args.n);
  if (isStyle(args.style)) a.style = args.style;
  if (args.scope === "segment" || args.scope === "unit") a.scope = args.scope;
  if (args.command === "skip") {
    a.scope ??= kind === "command" ? "segment" : "unit";
    if (a.scope === "unit") a.withCheck = true;
  }
  if (args.command === "goto" && !a.unitKey) return null;
  const c = cmd(args.command, a);
  return intent(kindFor(c.name, c.args), "llm", confidence, c);
}

/** What answers when neither layer is sure: a question — the safest default. */
export const defaultIntent = (checkOpen: boolean, text: string): Intent =>
  checkOpen && !looksLikeQuestion(text) ? intent("answer", "default", 0.5) : intent("question", "default", 0.5, undefined, true);

/** The router. Regex first; the model only when the regex layer has nothing. */
export async function classify(text: string, ctx: RouterContext): Promise<Intent> {
  const byRules = classifyByRules(text, ctx.graph, ctx.checkOpen);
  if (byRules) return byRules;
  if (!ctx.provider) return defaultIntent(ctx.checkOpen, text);

  const abort = new AbortController();
  const onParentAbort = () => abort.abort();
  ctx.signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), ctx.timeoutMs ?? 4000);
  try {
    let proposal: Record<string, unknown> | null = null;
    for await (const ev of ctx.provider.stream({
      system: routerSystemPrompt(ctx.graph, ctx.checkOpen),
      messages: [{ role: "user", text: text.slice(0, 400) }],
      tools: [ROUTER_TOOL],
      maxTokens: 200,
      signal: abort.signal,
    })) {
      if (ev.type === "tool_call" && ev.call.name === ROUTER_TOOL.name && !proposal) proposal = ev.call.args;
      if (ev.type === "error") break;
    }
    return (proposal && parseProposal(proposal, ctx.graph, ctx.checkOpen)) ?? defaultIntent(ctx.checkOpen, text);
  } catch {
    return defaultIntent(ctx.checkOpen, text);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onParentAbort);
  }
}
