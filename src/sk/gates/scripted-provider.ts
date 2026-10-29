// SK S5 slice E — the gates' SCRIPTED model (`--model scripted`, the
// default): no network, deterministic. It stands in for the Shell's
// AnthropicProvider when a turn reaches the model (the leader rules answer
// most leader questions without one).
//
// Round 1: the item's scripted tool calls (or none). Round 2: the item's
// `say`, with `{summary}` replaced by the first tool result's summary — the
// honest model that quotes its tool. In the unsupported bank `say` is a
// deliberate FABRICATION (an invented address, score, seat limit …): what
// the scripted run then measures is that the deterministic layers (rules,
// registry, scope cut, groundingCheck) refuse it on their own. The model's
// own judgement is what `--model live` measures.
//
// Every call's prompt size (system + messages + tool definitions) is
// counted, so the scripted run reports the token volume a live run would send.

import type { GenerateOpts, LLMProvider, StreamEvent, Turn } from "@/utils/assistant/provider";
import type { GateScript } from "./types";

export type CallSize = { inputChars: number; outputChars: number };

/** The characters a real provider would be sent for these options. */
export function promptChars(opts: GenerateOpts): number {
  const msgs = opts.messages.reduce((n, m: Turn) => n + JSON.stringify(m).length, 0);
  return opts.system.length + msgs + (opts.tools ? JSON.stringify(opts.tools).length : 0);
}

/** The summary inside a `<tool_result data_only="true">{json}</tool_result>`. */
export function toolSummary(result: string): string {
  const m = result.match(/^<tool_result[^>]*>([\s\S]*)<\/tool_result>$/);
  try {
    const body = JSON.parse(m ? m[1] : result) as { summary?: unknown };
    return typeof body.summary === "string" ? body.summary : "";
  } catch {
    return "";
  }
}

let callSeq = 0;

export class ScriptedGateProvider implements LLMProvider {
  readonly id = "gates-scripted";
  readonly model: string;
  constructor(
    model: string,
    private script: GateScript | undefined,
    private sizes: CallSize[],
  ) {
    this.model = model;
  }

  async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
    const inputChars = promptChars(opts);
    const lastUser = opts.messages.map((m) => m.role).lastIndexOf("user");
    const toolResults = opts.messages.slice(lastUser + 1).filter((m): m is Extract<Turn, { role: "tool" }> => m.role === "tool");
    const calls = this.script?.calls ?? [];
    if (!toolResults.length && calls.length) {
      const out = calls.map((c) => ({ id: `gate-call-${++callSeq}`, name: c.name.replace(/\./g, "__"), args: c.args ?? {} }));
      this.sizes.push({ inputChars, outputChars: JSON.stringify(out).length });
      for (const call of out) yield { type: "tool_call", call };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    const summary = toolResults.length ? toolSummary(toolResults[0].result) : "";
    const say = (this.script?.say ?? "I don't have that information.").replace("{summary}", summary);
    this.sizes.push({ inputChars, outputChars: say.length });
    if (opts.signal?.aborted) return;
    yield { type: "text", text: say };
    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
