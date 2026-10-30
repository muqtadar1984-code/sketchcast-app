/**
 * The corner avatar's speech bubble (founder 2026-10-30): what it shows and
 * when it fades — speaking, a text-only reply, the greeting, an error, a
 * confirmation waiting, a tour pinning it, hover holding it.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/bubble.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  BUBBLE_INITIAL,
  BUBBLE_READ_MIN_MS,
  GREETING_MIN_MS,
  SPEECH_LINGER_MS,
  bubbleFadeAt,
  bubbleOpen,
  bubbleReadingMs,
  bubbleReduce,
  replyPreview,
  shouldGreet,
  type BubbleEvent,
  type BubbleState,
} from "../bubble";

const run = (events: BubbleEvent[], from: BubbleState = BUBBLE_INITIAL) => events.reduce(bubbleReduce, from);

describe("speaking: the sentence being said, then a 4 s fade after the voice stops", () => {
  it("shows each sentence as it is spoken, in ONE message, never fading mid-speech", () => {
    let s = run([{ type: "sentence", text: "Hello there.", lang: "en-US", at: 1000 }]);
    expect(bubbleOpen(s)).toBe(true);
    expect(s.msg).toMatchObject({ kind: "speech", text: "Hello there.", speaking: true });
    const id = s.msg!.id;
    expect(bubbleFadeAt(s)).toBeNull();
    s = bubbleReduce(s, { type: "sentence", text: "Here are your classes.", at: 3000 });
    expect(s.msg).toMatchObject({ id, text: "Here are your classes." });
    expect(bubbleFadeAt(s)).toBeNull();
    s = bubbleReduce(s, { type: "speechEnd", at: 5000 });
    expect(bubbleFadeAt(s)).toBe(5000 + SPEECH_LINGER_MS);
    expect(SPEECH_LINGER_MS).toBe(4000);
    s = bubbleReduce(s, { type: "expire", id });
    expect(bubbleOpen(s)).toBe(false);
  });
  it("× closes the speech for the rest of that answer; the next speech opens again", () => {
    let s = run([{ type: "sentence", text: "One.", at: 0 }, { type: "close" }, { type: "sentence", text: "Two.", at: 10 }]);
    expect(bubbleOpen(s)).toBe(false);
    s = run([{ type: "speechEnd", at: 20 }, { type: "sentence", text: "A new answer.", at: 30 }], s);
    expect(bubbleOpen(s)).toBe(true);
    expect(s.msg?.text).toBe("A new answer.");
  });
  it("an expire meant for an older message never closes the current one", () => {
    let s = run([{ type: "sentence", text: "One.", at: 0 }, { type: "speechEnd", at: 1 }]);
    const old = s.msg!.id;
    s = bubbleReduce(s, { type: "sentence", text: "Two.", at: 2 });
    s = bubbleReduce(s, { type: "expire", id: old });
    expect(bubbleOpen(s)).toBe(true);
  });
});

describe("a text-only reply (read-aloud off): the first sentences, More, reading time", () => {
  it("previews the first two sentences and offers More", () => {
    expect(replyPreview("One. Two. Three.")).toEqual({ text: "One. Two.", more: true });
    expect(replyPreview("Just one.")).toEqual({ text: "Just one.", more: false });
    expect(replyPreview("")).toEqual({ text: "", more: false });
    const long = replyPreview(`${"word ".repeat(80)}end.`);
    expect(long.more).toBe(true);
    expect(long.text.endsWith("…")).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(241);
  });
  it("one message per turn, updated as the answer streams; fades after 55 ms a character, at least 4 s", () => {
    let s = run([{ type: "reply", key: "t1", text: "Your classes", at: 100 }]);
    const id = s.msg!.id;
    s = bubbleReduce(s, { type: "reply", key: "t1", text: "Your classes are 7A and 7B. Both have work due. Ask me for details.", lang: "en", dir: "ltr", at: 200 });
    expect(s.msg).toMatchObject({ id, kind: "reply", text: "Your classes are 7A and 7B. Both have work due.", more: true, dir: "ltr" });
    expect(bubbleFadeAt(s)).toBe(200 + bubbleReadingMs(s.msg!.text));
    expect(bubbleReadingMs("Hi.")).toBe(BUBBLE_READ_MIN_MS);
    expect(bubbleReadingMs("x".repeat(200))).toBe(200 * 55);
    // A new turn is a new message.
    s = bubbleReduce(s, { type: "reply", key: "t2", text: "Done.", at: 300 });
    expect(s.msg!.id).not.toBe(id);
  });
});

describe("hover / focus hold the bubble; leaving restarts its clock", () => {
  it("no fade while held, the full time again after", () => {
    let s = run([{ type: "reply", key: "t", text: "Short.", at: 0 }, { type: "hold", on: true, at: 1000 }]);
    expect(bubbleFadeAt(s)).toBeNull();
    s = bubbleReduce(s, { type: "hold", on: false, at: 9000 });
    expect(bubbleFadeAt(s)).toBe(9000 + BUBBLE_READ_MIN_MS);
  });
});

describe("the greeting: once per session, on a home page, never over something else", () => {
  it("shouldGreet", () => {
    expect(shouldGreet({ home: true, greeted: false, tour: false, text: "Hi, I'm SK." })).toBe(true);
    expect(shouldGreet({ home: false, greeted: false, tour: false, text: "Hi" })).toBe(false);
    expect(shouldGreet({ home: true, greeted: true, tour: false, text: "Hi" })).toBe(false);
    expect(shouldGreet({ home: true, greeted: false, tour: true, text: "Hi" })).toBe(false);
    expect(shouldGreet({ home: true, greeted: false, tour: false, text: "  " })).toBe(false);
  });
  it("stays at least GREETING_MIN_MS (how SK starts, founder 2026-10-30), longer if it takes longer to read; it never replaces an open message", () => {
    let s = run([{ type: "greeting", text: "Hi, I'm SK. Ask me anything.", at: 0 }]);
    expect(s.msg).toMatchObject({ kind: "greeting" });
    expect(bubbleFadeAt(s)).toBe(Math.max(GREETING_MIN_MS, bubbleReadingMs(s.msg!.text)));
    expect(bubbleFadeAt(s)).toBeGreaterThanOrEqual(10000);
    s = run([{ type: "sentence", text: "Speaking now.", at: 0 }, { type: "greeting", text: "Hi.", at: 1 }]);
    expect(s.msg?.kind).toBe("speech");
  });
});

describe("errors show in the bubble", () => {
  it("in the given wording, replacing what was there, with the reading-time fade", () => {
    const s = run([{ type: "sentence", text: "Working on it.", at: 0 }, { type: "error", text: "SK couldn't answer just now. Please try again.", at: 50 }]);
    expect(s.msg).toMatchObject({ kind: "error", text: "SK couldn't answer just now. Please try again." });
    expect(bubbleFadeAt(s)).toBe(50 + bubbleReadingMs("SK couldn't answer just now. Please try again."));
  });
});

describe("a confirmation waiting (text hidden): pinned until shown or settled", () => {
  it("stays over speech and replies, never fades, and goes on confirmDone", () => {
    let s = run([{ type: "confirm", text: "I need your confirmation.", at: 0 }, { type: "sentence", text: "Here's the card.", at: 1 }, { type: "reply", key: "t", text: "Text.", at: 2 }]);
    expect(s.msg).toMatchObject({ kind: "confirm" });
    expect(bubbleFadeAt(s)).toBeNull();
    s = bubbleReduce(s, { type: "confirmDone" });
    expect(bubbleOpen(s)).toBe(false);
  });
});

describe("a tour pins the bubble open", () => {
  it("open with no message, and nothing fades while it runs", () => {
    expect(bubbleOpen(BUBBLE_INITIAL, { tour: true })).toBe(true);
    const s = run([{ type: "sentence", text: "Here is the library.", at: 0 }, { type: "speechEnd", at: 10 }]);
    expect(bubbleFadeAt(s, { tour: true })).toBeNull();
    expect(bubbleFadeAt(s)).toBe(10 + SPEECH_LINGER_MS);
  });
  it("clear empties it", () => {
    expect(bubbleOpen(run([{ type: "reply", key: "t", text: "x.", at: 0 }, { type: "clear" }]))).toBe(false);
  });
});
