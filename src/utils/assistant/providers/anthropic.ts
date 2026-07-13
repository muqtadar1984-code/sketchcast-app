// Anthropic adapter — the swap-proof second implementation of LLMProvider.
// Wraps the SDK client the tutor already uses; supports streaming + tool_use.
// Selected with ASSISTANT_PROVIDER=anthropic (model via ASSISTANT_ANTHROPIC_MODEL).

import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@/utils/tutor/service";
import type { GenerateOpts, LLMProvider, StreamEvent, Turn } from "../provider";

type MsgParam = Anthropic.MessageParam;

/** Pure mapping: provider-agnostic turns → Anthropic messages. Exported for
 * contract tests. Tool results become tool_result blocks in a user turn. */
export function toAnthropicMessages(messages: Turn[]): MsgParam[] {
  const out: MsgParam[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.result }] });
    }
  }
  return out;
}

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  // Sonnet 5 is the quality tier for the student-facing assistant (same model the
  // tutor uses). Override per deploy with ASSISTANT_ANTHROPIC_MODEL.
  readonly model = process.env.ASSISTANT_ANTHROPIC_MODEL || "claude-sonnet-5";

  async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await anthropic().messages.create({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.6,
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        messages: toAnthropicMessages(opts.messages),
        ...(opts.tools?.length
          ? { tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })) }
          : {}),
        stream: true,
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      yield { type: "error", message: (e as Error).message, retryable: status === 429 || (status ?? 0) >= 500 };
      return;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    // Accumulate tool_use blocks (json args arrive as deltas) per block index.
    const pending = new Map<number, { id: string; name: string; json: string }>();
    try {
      for await (const ev of stream) {
        if (ev.type === "message_start") inputTokens = ev.message.usage.input_tokens;
        else if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
          pending.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
        } else if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") yield { type: "text", text: ev.delta.text };
          else if (ev.delta.type === "input_json_delta") {
            const p = pending.get(ev.index);
            if (p) p.json += ev.delta.partial_json;
          }
        } else if (ev.type === "content_block_stop") {
          const p = pending.get(ev.index);
          if (p) {
            pending.delete(ev.index);
            let args: Record<string, unknown> = {};
            try {
              args = p.json ? (JSON.parse(p.json) as Record<string, unknown>) : {};
            } catch {
              /* malformed tool args → empty; the tool will reject cleanly */
            }
            yield { type: "tool_call", call: { id: p.id, name: p.name, args } };
          }
        } else if (ev.type === "message_delta") {
          outputTokens = ev.usage.output_tokens;
        }
      }
    } catch (e) {
      yield { type: "error", message: (e as Error).message, retryable: true };
      return;
    }
    yield { type: "done", usage: { inputTokens, outputTokens } };
  }
}
