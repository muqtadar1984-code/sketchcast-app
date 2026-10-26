// The LLM provider seam for the AI Teaching Assistant. Everything outside
// src/utils/assistant/providers/* talks ONLY to this interface — the concrete
// provider (Gemini free tier today) is chosen by env, so moving providers is one
// new adapter, not an app change. Adapters must support STREAMING text and
// FUNCTION CALLING (the constrained math tool rides on it).

export type ToolDef = {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
};

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

/** Provider-agnostic conversation turn. `tool` carries a tool RESULT back to the
 * model (paired to the assistant turn whose toolCalls requested it). */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; result: string };

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number } }
  /** retryable=true → transient (rate limit); the caller shows a friendly
   * "one moment" state, never a raw error to a child. */
  | { type: "error"; message: string; retryable?: boolean };

export type GenerateOpts = {
  system: string;
  messages: Turn[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  /** Cancellation (SK B0). When it fires the adapter stops the upstream call
   * (the SDK/fetch request is aborted, so no more tokens are billed) and ends
   * its stream QUIETLY — no `error` event: the orchestrator reports the
   * cancellation itself, so callers see one `cancelled`, never a fake failure. */
  signal?: AbortSignal;
};

export interface LLMProvider {
  /** Stable id for logging/latency attribution ("gemini", "anthropic", "stub"). */
  readonly id: string;
  readonly model: string;
  stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void>;
}

/** True for the error a fetch / the Anthropic SDK throws when its signal fires —
 * the one failure an adapter swallows instead of surfacing. */
export function isAbortError(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  return err?.name === "AbortError" || err?.name === "APIUserAbortError" || /aborted/i.test(err?.message ?? "");
}

/** The active provider, chosen by env (default anthropic → Sonnet 5, the quality
 * tier for the student-facing assistant). Set ASSISTANT_PROVIDER=gemini to switch
 * to the Gemini free tier (e.g. once Google sponsorship lands). Import stays lazy
 * so a misconfigured alternate provider can't break the configured one. */
export async function assistantProvider(): Promise<LLMProvider> {
  const which = (process.env.ASSISTANT_PROVIDER || "anthropic").toLowerCase();
  if (which === "anthropic") {
    const { AnthropicProvider } = await import("./providers/anthropic");
    return new AnthropicProvider();
  }
  const { GeminiProvider } = await import("./providers/gemini");
  return new GeminiProvider();
}
