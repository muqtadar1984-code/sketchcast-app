// The assistant turn loop: stream from the provider; when the model requests a
// tool (the constrained math service), run it, feed the result back, and stream
// the continuation — capped rounds so a confused model can't loop. Provider- and
// tool-agnostic (everything injected) so the whole flow is unit-tested with the
// StubProvider and a fake tool runner.

import type { GenerateOpts, LLMProvider, ToolCall, ToolDef, Turn, Usage } from "./provider";

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string } // surfaced so the UI can show "checking the math…"
  | { type: "done"; fullText: string; usage: Usage; toolCalls: number }
  | { type: "error"; message: string; retryable?: boolean }
  /** The caller's signal fired (student pressed Stop, tab closed, SK barge-in).
   * Carries what was streamed so far and the usage billed to that point; the
   * turn is NOT a failure and MUST NOT be banked as a finished answer. */
  | { type: "cancelled"; fullText: string; usage: Usage; toolCalls: number };

export type TurnConfig = {
  provider: LLMProvider;
  system: string;
  history: Turn[]; // prior turns of THIS session (already compacted upstream)
  question: string;
  tools?: ToolDef[];
  /** Runs one tool call. Every call the model makes in ONE round is started
   * together (Promise.all) and the results go back in the model's order; the
   * turn's `signal` is handed to each so a stopped turn stops its reads too. */
  runTool?: (call: ToolCall, signal?: AbortSignal) => Promise<string>;
  maxToolRounds?: number;
  maxTokens?: number;
  /** Cancels the turn: the in-flight model call is aborted, no further tool
   * round starts, and the generator ends with one `cancelled` event. */
  signal?: AbortSignal;
};

export async function* runAssistantTurn(cfg: TurnConfig): AsyncGenerator<TurnEvent, void, void> {
  const messages: Turn[] = [...cfg.history, { role: "user", text: cfg.question }];
  const maxRounds = cfg.maxToolRounds ?? 3;
  let fullText = "";
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let toolCallCount = 0;
  const cancelled = (): TurnEvent => ({ type: "cancelled", fullText, usage, toolCalls: toolCallCount });

  for (let round = 0; ; round++) {
    if (cfg.signal?.aborted) {
      yield cancelled();
      return;
    }
    const opts: GenerateOpts = {
      system: cfg.system,
      messages,
      // Only offer tools while rounds remain, so the final pass must narrate.
      tools: round < maxRounds ? cfg.tools : undefined,
      maxTokens: cfg.maxTokens ?? 1024,
      signal: cfg.signal,
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
        // Prompt-cache tokens appear only when a provider reports them, so a
        // turn with no cache activity keeps its two-field usage.
        if (ev.usage.cacheReadTokens) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + ev.usage.cacheReadTokens;
        if (ev.usage.cacheWriteTokens) usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + ev.usage.cacheWriteTokens;
      } else {
        yield { type: "error", message: ev.message, retryable: ev.retryable };
        errored = true;
      }
    }
    if (errored) return;
    // An adapter ends quietly on abort; the signal says whether this was a
    // finished stream or a cut one (a cut stream never sees the model's `done`).
    if (cfg.signal?.aborted) {
      yield cancelled();
      return;
    }

    if (!calls.length || !cfg.runTool || round >= maxRounds) {
      yield { type: "done", fullText, usage, toolCalls: toolCallCount };
      return;
    }

    // Tool round: append the assistant's (partial) turn + every result, continue.
    // The round's calls are independent of one another (each carries its own
    // arguments; none can see another's result until the next model pass), so
    // they run SIDE BY SIDE — the round costs the slowest call, not the sum
    // (live, 2026-10-28: assignments.status 4.0 s + learners.risk 3.9 s back to
    // back). The results are appended in the model's order, whatever finished
    // first, so the history the model reads back is the same as before.
    toolCallCount += calls.length;
    messages.push({ role: "assistant", text: roundText, toolCalls: calls });
    if (cfg.signal?.aborted) {
      yield cancelled();
      return;
    }
    for (const call of calls) yield { type: "tool", name: call.name };
    const runTool = cfg.runTool;
    const results = await Promise.all(calls.map((call) => runTool(call, cfg.signal)));
    calls.forEach((call, i) => messages.push({ role: "tool", toolCallId: call.id, name: call.name, result: results[i] }));
  }
}
