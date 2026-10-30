/**
 * 2026-10-30 — end-of-turn detection (founder: "it feels as if the speech
 * recognition is either too sharp or is incomplete"). A fake clock; no timers.
 * Run: node node_modules/vitest/vitest.mjs run src/utils/assistant/__tests__/endpointing.test.ts
 */
import { describe, expect, it } from "vitest";
import { createEndpointer, END_SILENCE_MS, endSilenceFor, HESITANT_SILENCE_MS, soundsUnfinished } from "@/utils/assistant/endpointing";

/** A fake clock: timers fire only when time is advanced past them. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    get pending() {
      return timers.size;
    },
  };
}

describe("soundsUnfinished: the longer grace", () => {
  it.each([
    "I want to know about photosynthesis and",
    "so the cell membrane is, um",
    "Can you explain why the sky is blue because",
    "what is",
    "the mitochondria,",
    "and then...",
    "and then…",
    "Um.",
    "osmosis",
    "hello there",
    "apa itu osmosis dan",
    "c'est quoi la photosynthèse et",
    "qué es la fotosíntesis pero",
    "o que é osmose porque",
    "ما هو التمثيل الضوئي و",
    "प्रकाश संश्लेषण क्या है और",
    "प्रकाश संश्लेषण म्हणजे काय आणि",
    "కిరణజన్య సంయోగక్రియ అంటే ఏమిటి మరియు",
    "什么是光合作用，因为",
    "什么是光合作用嗯",
  ])("unfinished: %s", (t) => {
    expect(soundsUnfinished(t)).toBe(true);
  });

  it.each([
    "What is osmosis?",
    "explain photosynthesis to me please",
    "Tell me about the water cycle.",
    "Apa itu osmosis?",
    "ما هو التمثيل الضوئي؟",
    "प्रकाश संश्लेषण क्या है।",
    "什么是光合作用？",
    "什么是光合作用",
    "So.", // a connective with a full stop after it is a whole sentence
    "",
  ])("finished: %s", (t) => {
    expect(soundsUnfinished(t)).toBe(false);
  });

  it("the waits: 1.5 s normally, 2.5 s when unfinished; both tunable", () => {
    expect(END_SILENCE_MS).toBe(1500);
    expect(HESITANT_SILENCE_MS).toBe(2500);
    expect(endSilenceFor("What is osmosis?")).toBe(1500);
    expect(endSilenceFor("what is osmosis and")).toBe(2500);
    expect(endSilenceFor("What is osmosis?", { silenceMs: 900 })).toBe(900);
    expect(endSilenceFor("um", { hesitantMs: 4000 })).toBe(4000);
  });
});

describe("createEndpointer", () => {
  function make(o: { silenceMs?: number; hesitantMs?: number } = {}) {
    const clock = fakeClock();
    let ends = 0;
    const ep = createEndpointer({ ...o, onEndOfTurn: () => ends++, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    return { clock, ep, ends: () => ends };
  }

  it("nothing heard → never ends (the recogniser's no-speech timeout owns that)", () => {
    const { clock, ep, ends } = make();
    ep.heard("");
    ep.heard("   ");
    clock.advance(60_000);
    expect(ends()).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it("keeps listening through short pauses: each new word re-arms the silence clock", () => {
    const { clock, ep, ends } = make();
    ep.heard("what is");
    clock.advance(2000); // a hesitation after "what is" (unfinished → 2.5 s)
    ep.heard("what is osmosis");
    clock.advance(1400);
    expect(ends()).toBe(0);
    ep.heard("what is osmosis in plants");
    clock.advance(1499);
    expect(ends()).toBe(0);
    clock.advance(1);
    expect(ends()).toBe(1);
    expect(ep.ended).toBe(true);
    expect(ep.text).toBe("what is osmosis in plants");
  });

  it("the same words again (a repeated partial, a partial turned final unchanged) do NOT extend the turn", () => {
    const { clock, ep, ends } = make();
    ep.heard("explain the water cycle please");
    clock.advance(1000);
    ep.heard("explain the water cycle please");
    ep.heard("  explain  the water cycle please ");
    clock.advance(500);
    expect(ends()).toBe(1);
  });

  it("a trailing connective or filler waits the longer grace", () => {
    const { clock, ep, ends } = make();
    ep.heard("photosynthesis needs sunlight and");
    clock.advance(1500);
    expect(ends()).toBe(0);
    clock.advance(999);
    expect(ends()).toBe(0);
    clock.advance(1);
    expect(ends()).toBe(1);
  });

  it("a short answer without a full stop waits the longer grace; with one, the normal wait", () => {
    const a = make();
    a.ep.heard("yes");
    a.clock.advance(1500);
    expect(a.ends()).toBe(0);
    a.clock.advance(1000);
    expect(a.ends()).toBe(1);
    const b = make();
    b.ep.heard("Yes.");
    b.clock.advance(1500);
    expect(b.ends()).toBe(1);
  });

  it("ends once; nothing after it, and cancel() silences it", () => {
    const { clock, ep, ends } = make({ silenceMs: 100 });
    ep.heard("tell me about cells please");
    clock.advance(100);
    ep.heard("tell me about cells please and more");
    clock.advance(10_000);
    expect(ends()).toBe(1);
    const c = make();
    c.ep.heard("tell me about cells please");
    c.ep.cancel();
    c.clock.advance(10_000);
    expect(c.ends()).toBe(0);
    expect(c.clock.pending).toBe(0);
  });
});
