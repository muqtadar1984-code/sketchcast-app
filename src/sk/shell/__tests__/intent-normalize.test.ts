/**
 * The ONE normaliser every no-model intent rule reads through (founder
 * 2026-10-30: "SK does not show me around when i use the phrase 'Hi SK, show
 * me around?'"): the greeting / address / filler frame and the trailing
 * politeness and punctuation come off; the middle never does.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/intent-normalize.test.ts
 */
import { describe, expect, it } from "vitest";
import { frameIntent, intentWords, normalizeIntent, plainQuotes, stripIntentFrame } from "../intent-normalize";

describe("normalizeIntent: the frame comes off", () => {
  const CASES: Array<[string, string]> = [
    // the founder's phrase
    ["Hi SK, show me around?", "show me around"],
    ["hi sk show me around", "show me around"],
    ["Hey SK! Show me around.", "show me around"],
    ["Hello, SK — show me around please", "show me around"],
    ["OK so um, can you give me a tour please?", "give me a tour"],
    ["SK, could you please say that in Malay, thanks!", "say that in malay"],
    ["Hey there, would you open the diary for me?", "open the diary"],
    ["Good morning SK. I'd like to start the lesson now.", "start the lesson"],
    ["Please, kindly, go back to English", "go back to english"],
    ["Can u skip the tour pls", "skip the tour"],
    ["I need you to open my analytics, thank you", "open my analytics"],
    ["Let's start the walkthrough!!!", "start the walkthrough"],
    ["“Show me around”", "show me around"],
    ["  SHOW   ME   AROUND  ", "show me around"],
    // Malay (Rumi + Jawi greetings)
    ["Assalamualaikum SK, tunjukkan sekeliling", "tunjukkan sekeliling"],
    ["Hai SK, tolong buka diari ya", "buka diari"],
    ["Salam, boleh tak ulang dalam bahasa Arab?", "ulang dalam bahasa arab"],
    // Arabic
    ["مرحبا، خذني في جولة؟", "خذني في جولة"],
    ["السلام عليكم SK، من فضلك ابدأ الجولة", "ابدأ الجولة"],
    ["لو سمحت أعد ذلك بالعربية، شكرا", "أعد ذلك بالعربية"],
    // French / Spanish / Portuguese
    ["Bonjour SK, fais-moi visiter s'il vous plaît", "fais-moi visiter"],
    ["Salut ! Peux-tu répéter en anglais ?", "répéter en anglais"],
    ["¡Hola SK! ¿Me das un recorrido, por favor?", "me das un recorrido"],
    ["Olá, me mostra o app, obrigado", "me mostra o app"],
    // Hindi / Marathi / Telugu
    ["नमस्ते SK, मुझे सब दिखाओ।", "मुझे सब दिखाओ"],
    ["नमस्कार, कृपया टूर दाखवा", "टूर दाखवा"],
    ["నమస్తే, దయచేసి నాకు అన్నీ చూపించు", "నాకు అన్నీ చూపించు"],
    // Chinese (glued politeness)
    ["你好，请用中文再说一遍吧", "用中文再说一遍"],
  ];
  for (const [input, want] of CASES) {
    it(JSON.stringify(input), () => {
      expect(normalizeIntent(input)).toBe(want);
    });
  }
});

describe("the middle is never touched (questions stay questions)", () => {
  it("keeps the words after the command", () => {
    expect(normalizeIntent("show me around the cell membrane?")).toBe("show me around the cell membrane");
    expect(normalizeIntent("Hi SK, what is a tour in geography?")).toBe("what is a tour in geography");
    expect(normalizeIntent("how do I continue a lesson?")).toBe("how do i continue a lesson");
    expect(normalizeIntent("what can you do in the diary?")).toBe("what can you do in the diary");
  });
  it("a frame word inside a word is not a frame word", () => {
    for (const t of ["hindi please", "sorting the kits", "okapi facts", "well-being of cells", "so-called cells", "skeleton", "history"]) {
      expect(normalizeIntent(t).split(" ")[0], t).toBe(t.toLowerCase().split(" ")[0]);
    }
  });
  it("a message that is ONLY politeness is left as it is (the ack / thanks rules take it)", () => {
    expect(normalizeIntent("thanks")).toBe("thanks");
    expect(normalizeIntent("thank you")).toBe("thank you");
    expect(normalizeIntent("Thanks SK!")).toBe("thanks");
  });
  it("a bare greeting is empty", () => {
    expect(normalizeIntent("Hi SK!")).toBe("");
    expect(normalizeIntent("hello")).toBe("");
    expect(normalizeIntent("مرحبا")).toBe("");
  });
});

describe("frameIntent reports what it took off", () => {
  it("framed = a frame WORD went; punctuation alone does not count", () => {
    expect(frameIntent("Malay please")).toMatchObject({ lowered: "malay", framed: true, question: false });
    expect(frameIntent("Malay?")).toMatchObject({ lowered: "malay", framed: false, question: true });
    expect(frameIntent("Hi SK, show me around?")).toMatchObject({ framed: true, question: true });
    expect(frameIntent("كيف يعمل التطبيق؟")).toMatchObject({ lowered: "كيف يعمل التطبيق", question: true });
  });
  it("stripIntentFrame keeps the original case (kit titles are looked up by it)", () => {
    expect(stripIntentFrame("Hi SK, start the lesson on Plant and Animal Cells please")).toBe("start the lesson on Plant and Animal Cells");
  });
});

describe("the word helpers", () => {
  it("plainQuotes: curly quotes off, apostrophes plain", () => {
    expect(plainQuotes("“Let’s go” «now»")).toBe("Let's go now");
  });
  it("intentWords: lower-case, punctuation to spaces", () => {
    expect(intentWords("Hi, continue with the tour?")).toBe("hi continue with the tour");
    expect(intentWords("تابع الجولة؟")).toBe("تابع الجولة");
  });
});
