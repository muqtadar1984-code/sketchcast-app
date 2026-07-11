// Gemini adapter (free tier) — the ONLY file that knows Gemini's wire format.
// REST + SSE via fetch (no SDK dep): POST models/{model}:streamGenerateContent.
// Free-tier rate limits are handled with one polite retry, then a retryable
// error the UI turns into a friendly "one moment" state.
//
// NOTE (RUNBOOK): before children's data flows through this in production, the
// free tier's data-handling/training terms must be verified acceptable. This
// adapter exists precisely so we can move providers if they aren't.

import type { GenerateOpts, LLMProvider, StreamEvent, ToolCall, Turn } from "../provider";

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

/** Pure mapping: provider-agnostic turns → Gemini `contents`. Exported for
 * contract tests (no network). Tool results ride as functionResponse parts in a
 * user-role content, per the Gemini function-calling protocol. */
export function toGeminiContents(messages: Turn[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", parts: [{ text: m.text }] });
    else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
      if (parts.length) out.push({ role: "model", parts });
    } else {
      out.push({ role: "user", parts: [{ functionResponse: { name: m.name, response: { result: m.result } } }] });
    }
  }
  return out;
}

/** Pure mapping: request body for streamGenerateContent. Exported for tests. */
export function toGeminiBody(opts: GenerateOpts): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: toGeminiContents(opts.messages),
    ...(opts.tools?.length
      ? { tools: [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] }
      : {}),
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.6,
    },
  };
}

/** Pure: one parsed SSE JSON payload → stream events. Exported for tests. */
export function geminiChunkEvents(payload: unknown, mkId: () => string): StreamEvent[] {
  const events: StreamEvent[] = [];
  const cand = (payload as { candidates?: { content?: { parts?: GeminiPart[] } }[] })?.candidates?.[0];
  for (const part of cand?.content?.parts ?? []) {
    if ("text" in part && part.text) events.push({ type: "text", text: part.text });
    else if ("functionCall" in part) {
      const call: ToolCall = { id: mkId(), name: part.functionCall.name, args: part.functionCall.args ?? {} };
      events.push({ type: "tool_call", call });
    }
  }
  return events;
}

export class GeminiProvider implements LLMProvider {
  readonly id = "gemini";
  readonly model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      yield { type: "error", message: "GEMINI_API_KEY is not set." };
      return;
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse`;
    const body = JSON.stringify(toGeminiBody(opts));

    let res: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body,
      });
      if (res.status !== 429 && res.status !== 503) break;
      // Free-tier rate limit: one polite retry, honouring Retry-After up to 8s.
      const wait = Math.min(8000, (parseFloat(res.headers.get("retry-after") ?? "2") || 2) * 1000);
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!res || !res.ok || !res.body) {
      const retryable = !!res && (res.status === 429 || res.status >= 500);
      yield { type: "error", message: `Gemini request failed (${res?.status ?? "network"}).`, retryable };
      return;
    }

    // SSE: lines of `data: {json}` separated by blank lines.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let seq = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const mkId = () => `g${++seq}`;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue; // partial/garbled chunk — skip, never crash the stream
        }
        for (const ev of geminiChunkEvents(payload, mkId)) yield ev;
        const usage = (payload as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata;
        if (usage) {
          inputTokens = usage.promptTokenCount ?? inputTokens;
          outputTokens = usage.candidatesTokenCount ?? outputTokens;
        }
      }
    }
    yield { type: "done", usage: { inputTokens, outputTokens } };
  }
}
