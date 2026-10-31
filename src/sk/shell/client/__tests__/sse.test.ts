/**
 * The Shell's SSE reader: frames split across chunks, `event:`-less data lines,
 * CRLF, comments, a trailing frame without its blank line, and abort.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/sse.test.ts
 */
import { describe, expect, it } from "vitest";
import { createSseParser, parseEventJson, skTurnEvents } from "../sse";
import type { SkTurnEvent } from "../../types";

const META: SkTurnEvent = { type: "meta", sessionId: "s1", turnId: "t1", intent: "ask", capabilities: ["navigate"], memory: "m0" };
const TEXT1: SkTurnEvent = { type: "text", text: "Seven of " };
const TEXT2: SkTurnEvent = { type: "text", text: "twelve finished — ünïcödé ✓" };
const TOOL: SkTurnEvent = { type: "tool", name: "assignments.status", ok: true, summary: "7/12 done" };
const NAV: SkTurnEvent = { type: "navigate", path: "/dashboard/analytics?c=7B", label: "7B analytics" };
const DONE: SkTurnEvent = { type: "done", sources: ["assignments.status"], label: "grounded", latencyMs: 812, memory: "m1" };

const frame = (ev: SkTurnEvent) => `data: ${JSON.stringify(ev)}\n\n`;
const wire = [META, TEXT1, TEXT2, TOOL, NAV, DONE].map(frame).join("");

async function collectFrom(chunks: Array<string | Uint8Array>, signal?: AbortSignal): Promise<SkTurnEvent[]> {
  const out: SkTurnEvent[] = [];
  for await (const ev of skTurnEvents(chunks, signal)) out.push(ev);
  return out;
}

/** Cut a string into pieces of the given byte sizes (UTF-8), the last piece taking the rest. */
function cutBytes(s: string, sizes: number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(s);
  const out: Uint8Array[] = [];
  let at = 0;
  for (const n of sizes) {
    out.push(bytes.slice(at, at + n));
    at += n;
  }
  out.push(bytes.slice(at));
  return out;
}

describe("parseEventJson", () => {
  it("accepts the six contract types and rejects everything else", () => {
    expect(parseEventJson(JSON.stringify(DONE))).toEqual(DONE);
    expect(parseEventJson('{"type":"bogus"}')).toBeNull();
    expect(parseEventJson("not json")).toBeNull();
    expect(parseEventJson("")).toBeNull();
    expect(parseEventJson("[1,2]")).toBeNull();
    expect(parseEventJson("42")).toBeNull();
  });
});

describe("incremental parser", () => {
  it("yields a frame only once its blank line has arrived", () => {
    const p = createSseParser();
    expect(p.push('data: {"type":"text","text":"a"}')).toEqual([]);
    expect(p.push("\n")).toEqual([]);
    expect(p.push("\n")).toEqual([{ type: "text", text: "a" }]);
    expect(p.end()).toEqual([]);
  });

  it("handles a chunk boundary INSIDE a JSON frame, and inside a JSON string", () => {
    const f = frame(TEXT2);
    const cut = f.indexOf("twelve") + 3; // mid-word, mid-string
    const p = createSseParser();
    expect(p.push(f.slice(0, cut))).toEqual([]);
    expect(p.push(f.slice(cut))).toEqual([TEXT2]);
  });

  it("handles three frames and the head of a fourth in one chunk", () => {
    const p = createSseParser();
    const head = frame(DONE).slice(0, 12);
    const got = p.push(frame(META) + frame(TEXT1) + frame(TOOL) + head);
    expect(got).toEqual([META, TEXT1, TOOL]);
    expect(p.push(frame(DONE).slice(12))).toEqual([DONE]);
  });

  it("tolerates `event:` lines, ids, retry and comments — the type is inside the JSON", () => {
    const p = createSseParser();
    const got = p.push(`event: text\nid: 7\nretry: 1000\n: keep-alive\ndata: ${JSON.stringify(TEXT1)}\n\n`);
    expect(got).toEqual([TEXT1]);
  });

  it("joins multi-line data with newlines, per the SSE spec", () => {
    const p = createSseParser();
    const got = p.push('data: {"type":"text",\ndata: "text":"two lines"}\n\n');
    expect(got).toEqual([{ type: "text", text: "two lines" }]);
  });

  it("accepts CRLF, including a CRLF pair split across two chunks", () => {
    const p = createSseParser();
    const f = `data: ${JSON.stringify(TOOL)}\r\n\r\n`;
    const i = f.indexOf("\r\n\r\n") + 1; // between the first \r and \n
    expect(p.push(f.slice(0, i))).toEqual([]);
    expect(p.push(f.slice(i))).toEqual([TOOL]);
  });

  it("drops a malformed frame without losing the ones after it", () => {
    const p = createSseParser();
    const got = p.push(`data: {"type":"text","text":"a"\n\n${frame(TEXT1)}data: nonsense\n\n${frame(DONE)}`);
    expect(got).toEqual([TEXT1, DONE]);
  });

  it("flushes a trailing frame that never got its blank line when the stream ends", () => {
    const p = createSseParser();
    expect(p.push(`data: ${JSON.stringify(DONE)}`)).toEqual([]);
    expect(p.end()).toEqual([DONE]);
    expect(p.end()).toEqual([]);
  });

  it("ignores stray blank lines and whitespace between frames", () => {
    const p = createSseParser();
    expect(p.push(`\n\n\n${frame(META)}\n\n\n\n${frame(TEXT1)}`)).toEqual([META, TEXT1]);
  });
});

describe("skTurnEvents over a stream", () => {
  it("keeps the contract's event order meta → text/tool/navigate → done", async () => {
    const got = await collectFrom([wire]);
    expect(got.map((e) => e.type)).toEqual(["meta", "text", "text", "tool", "navigate", "done"]);
    expect(got[0]).toEqual(META);
    expect(got[5]).toEqual(DONE);
  });

  it("is chunking-invariant: every 1-, 7- and 23-byte cut gives the same events", async () => {
    const whole = await collectFrom([wire]);
    for (const n of [1, 7, 23]) {
      const bytes = new TextEncoder().encode(wire);
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += n) chunks.push(bytes.slice(i, i + n));
      expect(await collectFrom(chunks)).toEqual(whole);
    }
  });

  it("survives a multi-byte character split between two byte chunks", async () => {
    const f = frame(TEXT2);
    const bytes = new TextEncoder().encode(f);
    // "ü" is 2 bytes; find its first byte and cut between the two.
    const uIdx = bytes.findIndex((b, i) => b === 0xc3 && bytes[i + 1] === 0xbc);
    expect(uIdx).toBeGreaterThan(0);
    const got = await collectFrom(cutBytes(f, [uIdx + 1]));
    expect(got).toEqual([TEXT2]);
  });

  it("reads a WHATWG ReadableStream (what fetch hands the panel)", async () => {
    const enc = new TextEncoder();
    const parts = [wire.slice(0, 40), wire.slice(40, 90), wire.slice(90)];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    const out: SkTurnEvent[] = [];
    for await (const ev of skTurnEvents(stream)) out.push(ev);
    expect(out).toEqual([META, TEXT1, TEXT2, TOOL, NAV, DONE]);
  });

  it("stops yielding once the signal aborts", async () => {
    const ac = new AbortController();
    const out: SkTurnEvent[] = [];
    for await (const ev of skTurnEvents([frame(META), frame(TEXT1), frame(TEXT2), frame(DONE)], ac.signal)) {
      out.push(ev);
      if (ev.type === "text") ac.abort();
    }
    expect(out.map((e) => e.type)).toEqual(["meta", "text"]);
  });

  it("an error frame comes through typed", async () => {
    const got = await collectFrom([frame(META), frame({ type: "error", message: "model unavailable" })]);
    expect(got[1]).toEqual({ type: "error", message: "model unavailable" });
  });
});

// 2026-10-31: the founder's voice "show me around" never started the tour —
// the server's `walkthrough` event was dropped here as an unknown type.
describe("every server event type is accepted", () => {
  it("passes a walkthrough event through", () => {
    expect(parseEventJson(JSON.stringify({ type: "walkthrough" }))).toEqual({ type: "walkthrough" });
    expect(parseEventJson(JSON.stringify({ type: "walkthrough", action: "next" }))).toEqual({ type: "walkthrough", action: "next" });
  });

  it("accepts each `type` in the SkTurnEvent union (types.ts)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/sk/shell/types.ts"), "utf8");
    const union = src.slice(src.indexOf("export type SkTurnEvent"));
    const block = union.slice(0, union.indexOf(";\n") > 0 ? union.indexOf(";\n") : undefined);
    const types = [...block.matchAll(/\|\s*\{\s*type:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(5);
    for (const t of types) expect(parseEventJson(JSON.stringify({ type: t })), t).not.toBeNull();
  });
});
