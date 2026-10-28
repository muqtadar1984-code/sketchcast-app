// SSE reader for POST /api/sk/shell/turn: text chunks in, SkTurnEvents out.
//
// The wire format is the plain one the contract fixes (src/sk/shell/types.ts):
// one JSON object per `data:` line, frames separated by a blank line. The
// event TYPE is inside the JSON, so an `event:` line is tolerated and ignored,
// as are `id:`, `retry:` and `:` comment lines. Network chunks do not respect
// frame boundaries — a chunk can end in the middle of a JSON object, or carry
// three frames and the head of a fourth — so the parser is incremental: feed
// it whatever arrived, it hands back only the frames that are complete.
//
// PURE: no fetch, no DOM. `skTurnEvents()` accepts a WHATWG ReadableStream
// (what `fetch` gives the panel) or any async iterable of strings / bytes, so
// the test feeds it arrays of deliberately mis-cut chunks.

import type { SkTurnEvent } from "../types";

const EVENT_TYPES: ReadonlySet<string> = new Set(["meta", "text", "tool", "navigate", "done", "error"]);

/** A frame's JSON → a typed event, or null when it is not one of ours.
 * Exported for the panel's own guards; a frame that fails here is dropped,
 * never thrown — a bad frame must not kill the rest of the answer. */
export function parseEventJson(data: string): SkTurnEvent | null {
  const s = data.trim();
  if (!s) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const type = (obj as { type?: unknown }).type;
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) return null;
  return obj as SkTurnEvent;
}

/** One frame's raw lines → the joined `data:` payload (multi-line data is
 * joined with "\n", per the SSE spec); other fields are ignored. */
function frameData(frame: string): string {
  const out: string[] = [];
  for (const rawLine of frame.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) out.push(line.slice(5).replace(/^ /, ""));
    // `event:` / `id:` / `retry:` and anything unknown: carry nothing here.
  }
  return out.join("\n");
}

export type SseParser = {
  /** Feed a chunk; returns every event whose frame is now complete. */
  push: (chunk: string) => SkTurnEvent[];
  /** The stream ended: flush a trailing frame that had no blank line after it. */
  end: () => SkTurnEvent[];
};

export function createSseParser(): SseParser {
  let buf = "";
  const take = (frames: string[]): SkTurnEvent[] => {
    const out: SkTurnEvent[] = [];
    for (const f of frames) {
      const ev = parseEventJson(frameData(f));
      if (ev) out.push(ev);
    }
    return out;
  };
  return {
    push(chunk) {
      buf += chunk;
      // Frames end at a blank line in any newline convention. Normalise CRLF
      // first so a "\r\n" split across two chunks still becomes one separator.
      const norm = buf.replace(/\r\n/g, "\n");
      const parts = norm.split(/\n\n+/);
      buf = parts.pop() ?? "";
      return take(parts);
    },
    end() {
      const rest = buf;
      buf = "";
      return rest.trim() ? take([rest]) : [];
    },
  };
}

type ByteOrText = string | Uint8Array;
export type SseSource = ReadableStream<Uint8Array> | AsyncIterable<ByteOrText> | Iterable<ByteOrText>;

async function* iterate(source: SseSource): AsyncGenerator<ByteOrText> {
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  for await (const chunk of source as AsyncIterable<ByteOrText>) yield chunk;
}

/** Every SkTurnEvent in the stream, in order, as an async generator. Stops
 * early (and releases the reader) when `signal` aborts; bytes are decoded as
 * UTF-8 with the decoder held across chunks so a multi-byte character split
 * between two reads survives. */
export async function* skTurnEvents(source: SseSource, signal?: AbortSignal): AsyncGenerator<SkTurnEvent> {
  const parser = createSseParser();
  const decoder = new TextDecoder();
  for await (const chunk of iterate(source)) {
    if (signal?.aborted) return;
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (const ev of parser.push(text)) yield ev;
  }
  if (signal?.aborted) return;
  const tail = decoder.decode();
  if (tail) for (const ev of parser.push(tail)) yield ev;
  for (const ev of parser.end()) yield ev;
}
