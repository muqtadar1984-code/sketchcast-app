// The assistant turn loop: stream from the provider; when the model requests a
// tool (the constrained math service), run it, feed the result back, and stream
// the continuation — capped rounds so a confused model can't loop. Provider- and
// tool-agnostic (everything injected) so the whole flow is unit-tested with the
// StubProvider and a fake tool runner.

import type { GenerateOpts, LLMProvider, ToolCall, ToolDef, Turn } from "./provider";

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string } // surfaced so the UI can show "checking the math…"
  | { type: "done"; fullText: string; usage: { inputTokens: number; outputTokens: number }; toolCalls: number }
  | { type: "error"; message: string; retryable?: boolean };

export type TurnConfig = {
  provider: LLMProvider;
  system: string;
  history: Turn[]; // prior turns of THIS session (already compacted upstream)
  question: string;
  tools?: ToolDef[];
  runTool?: (call: ToolCall) => Promise<string>;
  maxToolRounds?: number;
  maxTokens?: number;
};

export async function* runAssistantTurn(cfg: TurnConfig): AsyncGenerator<TurnEvent, void, void> {
  const messages: Turn[] = [...cfg.history, { role: "user", text: cfg.question }];
  const maxRounds = cfg.maxToolRounds ?? 3;
  let fullText = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  let toolCallCount = 0;

  for (let round = 0; ; round++) {
    const opts: GenerateOpts = {
      system: cfg.system,
      messages,
      // Only offer tools while rounds remain, so the final pass must narrate.
      tools: round < maxRounds ? cfg.tools : undefined,
      maxTokens: cfg.maxTokens ?? 1024,
    };

    let roundText = "";
    const calls: ToolCall[] = [];
    let errored = false;
    for await (const ev of cfg.provider.stream(opts)) {
      if (ev.type === "text") {
        roundText += ev.text;
        fullText += ev.text;
        yield { type: "text", text: ev.text };
      } else if (ev.type === "tool_call") {
        calls.push(ev.call);
      } else if (ev.type === "done") {
        usage.inputTokens += ev.usage.inputTokens;
        usage.outputTokens += ev.usage.outputTokens;
      } else {
        yield { type: "error", message: ev.message, retryable: ev.retryable };
        errored = true;
      }
    }
    if (errored) return;

    if (!calls.length || !cfg.runTool || round >= maxRounds) {
      yield { type: "done", fullText, usage, toolCalls: toolCallCount };
      return;
    }

    // Tool round: append the assistant's (partial) turn + every result, continue.
    toolCallCount += calls.length;
    messages.push({ role: "assistant", text: roundText, toolCalls: calls });
    for (const call of calls) {
      yield { type: "tool", name: call.name };
      const result = await cfg.runTool(call);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, result });
    }
  }
}
