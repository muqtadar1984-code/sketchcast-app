// Scripted stub provider — proves the provider swap (no vendor references) and
// drives orchestrator tests deterministically: each call to stream() plays the
// next scripted turn (text chunks, optional tool calls), no network.

import type { GenerateOpts, LLMProvider, StreamEvent, ToolCall } from "../provider";

export type StubTurn = { text?: string[]; toolCalls?: ToolCall[] };

export class StubProvider implements LLMProvider {
  readonly id = "stub";
  readonly model = "stub-1";
  /** Every GenerateOpts stream() received — assert prompts/tools in tests. */
  readonly calls: GenerateOpts[] = [];
  private turn = 0;

  constructor(private script: StubTurn[]) {}

  async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
    this.calls.push(opts);
    const t = this.script[Math.min(this.turn++, this.script.length - 1)] ?? {};
    // Honour cancellation the way a real adapter does: stop between chunks,
    // end quietly (no error, no done) once the signal has fired.
    for (const chunk of t.text ?? []) {
      if (opts.signal?.aborted) return;
      yield { type: "text", text: chunk };
    }
    for (const call of t.toolCalls ?? []) yield { type: "tool_call", call };
    if (opts.signal?.aborted) return;
    yield { type: "done", usage: { inputTokens: 100, outputTokens: 50 } };
  }
}
