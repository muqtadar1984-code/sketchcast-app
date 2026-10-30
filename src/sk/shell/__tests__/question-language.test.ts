/**
 * questionLanguage (founder 2026-10-30): the language a question is written
 * in, decided with no model call — and NULL whenever it is not clear, so the
 * conversation keeps its language. A wrong guess is the one failure that
 * matters: Hinglish and Manglish come out null (or English), never Malay,
 * Portuguese or Hindi by accident.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/question-language.test.ts
 */
import { describe, expect, it } from "vitest";
import { questionLanguage, stripQuoted } from "../question-language";

const cases = (lang: string | null, list: string[]) => {
  for (const q of list) it(`${JSON.stringify(q)} → ${lang}`, () => expect(questionLanguage(q)).toBe(lang));
};

describe("Marathi (Devanagari, by its function words)", () => {
  cases("mr", [
    "प्रकाशसंश्लेषण म्हणजे काय?",
    "मला हे समजले नाही, पुन्हा सांगा",
    "पेशीच्या भिंतीचे काम काय आहे?",
    "तुम्ही मला एक उदाहरण देऊ शकता का?",
    "हृदय कसे काम करते?",
    "ठीक आहे",
    "photosynthesis म्हणजे काय?",
    "माझ्या मुलाचा गृहपाठ कुठे आहे",
  ]);
});

describe("Hindi (Devanagari)", () => {
  cases("hi", [
    "प्रकाश संश्लेषण क्या है?",
    "मुझे यह समझ नहीं आया",
    "आप मुझे एक उदाहरण दे सकते हैं?",
    "दिल कैसे काम करता है?",
    "कोशिका की दीवार का काम क्या है",
  ]);
});

describe("Telugu, Chinese, Arabic", () => {
  cases("te", ["కిరణజన్య సంయోగక్రియ అంటే ఏమిటి?", "నాకు అర్థం కాలేదు"]);
  cases("zh", ["什么是光合作用？", "请再解释一下", "细胞壁有什么作用", "好的"]);
  cases("ar", ["ما هو التمثيل الضوئي؟", "اشرح لي كيف يعمل القلب", "لم أفهم، أعد من فضلك", "أين الواجب"]);
});

describe("Jawi (Malay in Arabic script) → ms-arab", () => {
  cases("ms-arab", ["اڤ ايت فوتوسينتيسيس؟", "ساي تيدق فهم", "تراڠکن ڤروسيس ايت دڠن چونتوه"]);
});

describe("Urdu: not an SK answer language — answered in Arabic for now", () => {
  cases("ar", ["فوٹوسنتھیسس کیا ہے؟", "مجھے سمجھ نہیں آیا"]);
});

describe("Latin script", () => {
  cases("en", [
    "what is photosynthesis",
    "Can you explain how the heart works?",
    "What's the difference between mitosis and meiosis?",
    "how do I assign this to 7B",
    "what does «bonjour» mean in this sentence",
    "can you explain this one lah",
  ]);
  cases("ms", [
    "apa itu fotosintesis",
    "Boleh terangkan bagaimana jantung berfungsi?",
    "Apakah perbezaan antara mitosis dan meiosis?",
    "saya tidak faham bahagian ini",
    "macam mana nak tukar kelas ni",
  ]);
  cases("fr", ["Qu'est-ce que la photosynthèse ?", "Peux-tu m'expliquer comment fonctionne le cœur ?", "Je ne comprends pas cette partie", "Quelle est la différence entre la mitose et la méiose ?"]);
  cases("es", ["¿Qué es la fotosíntesis?", "Explícame cómo funciona el corazón", "No entiendo esta parte, por favor", "¿Cuál es la diferencia entre mitosis y meiosis?"]);
  cases("pt", ["O que é a fotossíntese?", "Você pode explicar como funciona o coração?", "Não entendo esta parte", "Qual é a diferença entre mitose e meiose?"]);
});

describe("short follow-ups: null (the conversation keeps its language)", () => {
  cases(null, ["ok", "next", "ya", "yes", "no", "हो", "हाँ", "नाही", "شكرا", "نعم", "好", "ok next", "next please", "continue", "teruskan", "sí", "oui", "sim", "thanks!", "?", "ok lah", "ठीक"]);
});

describe("numbers, names, maths, code, links: null", () => {
  cases(null, [
    "2 + 2 = ?",
    "12345",
    "x^2 + 3x - 4 = 0",
    "Ahmad bin Ali",
    "Siti Nurhaliza 7B",
    "https://example.com/what-is-this-page",
    "`const what = is + the`",
    "```\nwhat is the answer to this\n```",
    "\"what is the answer\"",
    "mitosis meiosis",
    "DNA RNA ATP",
  ]);
});

describe("Hinglish and Manglish never come out as something wrong", () => {
  const notWrong = (list: string[], allowed: Array<string | null>) => {
    for (const q of list) it(`${JSON.stringify(q)} → one of ${allowed.join("/")}`, () => expect(allowed).toContain(questionLanguage(q)));
  };
  notWrong(
    [
      "photosynthesis kya hai",
      "mujhe yeh samajh nahi aaya",
      "aap mujhe example de sakte ho kya",
      "yeh kaise kaam karta hai",
      "bhai ye chapter samjhao",
      "matlab kya hai iska",
      "mala samjat nahi",
      "heart kasa kaam karto",
    ],
    [null],
  );
  notWrong(["boleh explain photosynthesis tak", "this one how ah", "can lah", "teacher, the homework due bila?", "ok can, explain again pls"], [null, "en"]);
});

describe("mixed scripts: no guess", () => {
  cases(null, ["What is प्रकाशसंश्लेषण", "这个 क्या है", "ما هو 光合作用 的", "explain ఇది"]);
});

describe("not SK's languages: null", () => {
  cases(null, ["光合成とは何ですか", "광합성이란 무엇입니까", "ஒளிச்சேர்க்கை என்றால் என்ன", "Что такое фотосинтез?"]);
});

describe("stripQuoted", () => {
  it("drops quotes, code, links and e-mail addresses", () => {
    const s = stripQuoted('what is "ceci" `x` https://a.b/c www.x.y a@b.co «ok» “hi”');
    expect(s).not.toMatch(/ceci|https|www|a@b|«|“|`/);
    expect(s).toContain("what is");
  });
});
