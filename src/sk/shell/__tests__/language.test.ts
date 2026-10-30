/**
 * The answer language (founder 2026-10-30): the precedence function, the
 * "repeat that in X" / "back to English" phrasings in every language, the
 * RTL flag and speech tags, and the rules router's `lang` intent.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/language.test.ts
 */
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/locales";
import {
  LANG_INFO,
  SK_ANSWER_LANGS,
  answerLanguage,
  canSpeakList,
  langMeta,
  languageChosen,
  linesLocale,
  normalizeLanguage,
  overrideForBack,
  parseLanguageCommand,
  stickyAfterQuestion,
  targetCode,
} from "../language";
import { routeByRules } from "../rules";
import { buildShellPrompt } from "../prompt";
import { toolResultText } from "../runner";
import { makeCtx } from "./fixtures";

const repeatTo = (text: string) => {
  const c = parseLanguageCommand(text);
  return c && c.kind === "repeat" ? targetCode(c.target, "en") : `not-repeat:${JSON.stringify(c)}`;
};

describe("answerLanguage: override > the source's language > the UI locale", () => {
  it("an Arabic kit answers in Arabic by default with an English UI", () => {
    expect(answerLanguage({ override: null, sourceLanguages: ["ar"], uiLocale: "en" })).toEqual({ lang: "ar", from: "source" });
  });
  it("an explicit override beats the source", () => {
    expect(answerLanguage({ override: "ms", sourceLanguages: ["ar"], uiLocale: "en" })).toEqual({ lang: "ms", from: "override" });
  });
  it("mixed sources give the UI locale", () => {
    expect(answerLanguage({ override: null, sourceLanguages: ["ar", "en"], uiLocale: "fr" })).toEqual({ lang: "fr", from: "ui" });
  });
  it("one source in two spellings is still one source", () => {
    expect(answerLanguage({ override: null, sourceLanguages: ["ms-Arab", "ms-arab", null, ""], uiLocale: "en" }).lang).toBe("ms-arab");
    expect(answerLanguage({ override: null, sourceLanguages: ["zh-CN", "zh"], uiLocale: "en" }).lang).toBe("zh");
  });
  it("no source gives the UI locale", () => {
    expect(answerLanguage({ override: undefined, sourceLanguages: [], uiLocale: "ms" })).toEqual({ lang: "ms", from: "ui" });
    expect(answerLanguage({ uiLocale: null })).toEqual({ lang: "en", from: "ui" });
  });
  it("a source language SK cannot answer in falls back to the UI locale and says which", () => {
    expect(answerLanguage({ override: null, sourceLanguages: ["ta"], uiLocale: "en" })).toEqual({ lang: "en", from: "ui", unsupportedSource: "ta" });
  });
  it("an override that is not an answer language is ignored", () => {
    expect(answerLanguage({ override: "ta", sourceLanguages: ["ar"], uiLocale: "en" }).lang).toBe("ar");
  });
  it("normalizeLanguage reads codes, BCP-47 tags and names", () => {
    expect(normalizeLanguage("AR")).toBe("ar");
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("ms_MY")).toBe("ms");
    expect(normalizeLanguage("zh-Hans")).toBe("zh");
    expect(normalizeLanguage("Arabic")).toBe("ar");
    expect(normalizeLanguage("ta-IN")).toEqual({ unsupported: "ta-in" });
    expect(normalizeLanguage("")).toBeNull();
    expect(normalizeLanguage(42)).toBeNull();
  });
  it("back to X clears the override when X is what SK would say anyway, else sets it", () => {
    expect(overrideForBack("en", { sourceLanguages: [], uiLocale: "en" })).toBeNull();
    // Over an Arabic kit "back to English" must still mean English.
    expect(overrideForBack("en", { sourceLanguages: ["ar"], uiLocale: "en" })).toBe("en");
    expect(overrideForBack("ar", { sourceLanguages: ["ar"], uiLocale: "en" })).toBeNull();
  });
});

describe("the repeat phrasings route to the language they name", () => {
  const cases: Array<[string, string]> = [
    ["say that in Malay", "ms"],
    ["Say that in Malay.", "ms"],
    ["repeat in Arabic", "ar"],
    ["explain that again in English", "en"],
    ["in Chinese please", "zh"],
    ["can you say it in French?", "fr"],
    ["translate that into Spanish", "es"],
    ["now in Portuguese", "pt"],
    ["say that in Jawi", "ms-arab"],
    ["say that in my language", "en"],
    ["Malay please", "ms"],
    ["ulang dalam bahasa Arab", "ar"],
    ["terangkan dalam bahasa Inggeris", "en"],
    ["tolong ulangkan itu dalam bahasa Melayu", "ms"],
    ["dalam bahasa Cina", "zh"],
    ["أعد ذلك بالعربية", "ar"],
    ["بالإنجليزية", "en"],
    ["اشرح ذلك مرة أخرى باللغة الفرنسية", "fr"],
    ["قلها بالملايوية من فضلك", "ms"],
    ["用中文再说一遍", "zh"],
    ["用英文说", "en"],
    ["中文", "zh"],
    ["en français", "fr"],
    ["répète-le en anglais", "en"],
    ["en español", "es"],
    ["dilo en árabe por favor", "ar"],
    ["em português", "pt"],
    ["repete isso em inglês", "en"],
    ["हिंदी में", "hi"],
    ["इसे अंग्रेज़ी में दोहराओ", "en"],
    ["తెలుగులో", "te"],
    ["ఇంగ్లీష్‌లో మళ్ళీ చెప్పండి", "en"],
    ["मराठीत", "mr"],
    ["इंग्रजीत पुन्हा सांगा", "en"],
    ["دالم بهاس ملايو", "ms"],
    ["اولڠ دالم بهاس عرب", "ar"],
  ];
  it.each(cases)("%s → %s", (text, code) => {
    expect(repeatTo(text)).toBe(code);
  });

  it("each target language's own name for itself routes to it", () => {
    const own: Record<string, string> = { en: "in English", ms: "dalam Bahasa Melayu", "ms-arab": "دالم جاوي", ar: "بالعربية", fr: "en français", es: "en español", pt: "em português", hi: "हिंदी में", te: "తెలుగులో", mr: "मराठीत", zh: "用中文说" };
    for (const l of SK_ANSWER_LANGS) expect(repeatTo(own[l]!), l).toBe(l);
  });

  it("an unknown language is a command SK answers with the list", () => {
    const c = parseLanguageCommand("say that in Tamil");
    expect(c).toEqual({ kind: "repeat", target: { unsupported: "tamil" } });
    expect(targetCode(c!.target, "en")).toBeNull();
    expect(parseLanguageCommand("ulang dalam bahasa Tamil")).toEqual({ kind: "repeat", target: { unsupported: "tamil" } });
  });

  it("phrasings that name no language, or ask a new question, are not commands", () => {
    for (const t of [
      "explain photosynthesis in Malay",
      "explain that in detail",
      "explain it in simple language",
      "terangkan dalam bahasa mudah",
      "what is diffusion?",
      "show me 7B's analytics",
      "in 7B",
      "how do you say cell in Malay",
      "Malay",
      "بكم",
      "بالتفصيل",
      "细胞是什么",
    ]) {
      expect(parseLanguageCommand(t), t).toBeNull();
    }
  });
});

describe("back phrasings", () => {
  const back = (t: string) => {
    const c = parseLanguageCommand(t);
    return c?.kind === "back" ? targetCode(c.target, "ms") : `not-back:${JSON.stringify(c)}`;
  };
  it.each([
    ["back to English", "en"],
    ["go back to Arabic", "ar"],
    ["use my language", "ms"],
    ["kembali ke bahasa Melayu", "ms"],
    ["kembali ke bahasa saya", "ms"],
    ["tukar balik ke bahasa Inggeris", "en"],
    ["عد إلى العربية", "ar"],
    ["ارجع للإنجليزية", "en"],
    ["استخدم لغتي", "ms"],
    ["换回中文", "zh"],
    ["用我的语言", "ms"],
    ["reviens au français", "fr"],
    ["vuelve al español", "es"],
    ["volta ao português", "pt"],
    // 2026-10-30: a switch from now on, no repeat.
    ["speak in Marathi", "mr"],
    ["talk to me in Malay", "ms"],
    ["reply in Arabic from now on", "ar"],
    ["switch to Hindi", "hi"],
    ["change the language to Chinese", "zh"],
    ["please speak in Telugu", "te"],
  ])("%s → %s", (text, code) => {
    expect(back(text)).toBe(code);
  });
  it("a switch phrasing that names no language is not a command", () => {
    for (const t of ["switch to the next slide", "change to slide 4", "speak in a simple way", "talk in detail"]) expect(parseLanguageCommand(t), t).toBeNull();
  });
});

describe("2026-10-30 precedence: the question's own language > the conversation's > the source's > the UI's", () => {
  it("a confident question language beats the conversation's language and the source's", () => {
    expect(answerLanguage({ question: "mr", override: "ms", sourceLanguages: ["ar"], uiLocale: "en" })).toEqual({ lang: "mr", from: "question" });
    expect(answerLanguage({ question: "en", override: null, sourceLanguages: ["ar"], uiLocale: "ms" })).toEqual({ lang: "en", from: "question" });
  });
  it("no confident question language: the conversation's, then the source's (the book/article default), then the UI's", () => {
    expect(answerLanguage({ question: null, override: "mr", sourceLanguages: ["ar"], uiLocale: "en" })).toEqual({ lang: "mr", from: "override" });
    expect(answerLanguage({ question: null, override: null, sourceLanguages: ["ar"], uiLocale: "en" })).toEqual({ lang: "ar", from: "source" });
    expect(answerLanguage({ question: null, override: null, sourceLanguages: [], uiLocale: "hi" })).toEqual({ lang: "hi", from: "ui" });
  });
  it("a question language that is not an answer language is ignored", () => {
    expect(answerLanguage({ question: "ta", sourceLanguages: ["ar"], uiLocale: "en" })).toEqual({ lang: "ar", from: "source" });
  });
  it("stickyAfterQuestion: a confident question becomes the conversation's language, cleared when it is the natural one", () => {
    // Marathi on an English page: kept, so "ok" / "next" stay in Marathi.
    expect(stickyAfterQuestion("mr", null, { sourceLanguages: [], uiLocale: "en" })).toBe("mr");
    expect(stickyAfterQuestion("mr", "ms", { sourceLanguages: [], uiLocale: "en" })).toBe("mr");
    // English on an English page: nothing to keep (the page's own language).
    expect(stickyAfterQuestion("en", "mr", { sourceLanguages: [], uiLocale: "en" })).toBeNull();
    // English over an Arabic book: kept (the book would say Arabic).
    expect(stickyAfterQuestion("en", null, { sourceLanguages: ["ar"], uiLocale: "en" })).toBe("en");
    // Arabic over an Arabic book: the book's own — nothing to keep.
    expect(stickyAfterQuestion("ar", "en", { sourceLanguages: ["ar"], uiLocale: "en" })).toBeNull();
    // No confident question: the conversation's language as it was.
    expect(stickyAfterQuestion(null, "mr", { sourceLanguages: ["ar"], uiLocale: "en" })).toBe("mr");
    expect(stickyAfterQuestion(null, undefined, { sourceLanguages: [], uiLocale: "en" })).toBeNull();
  });
  it("languageChosen: the user's own language (question or conversation), not the material's or the page's", () => {
    expect(languageChosen({ from: "question" })).toBe(true);
    expect(languageChosen({ from: "override" })).toBe(true);
    expect(languageChosen({ from: "source" })).toBe(false);
    expect(languageChosen({ from: "ui" })).toBe(false);
  });
});

describe("direction, voice and lines locale follow the language", () => {
  it("ar and ms-arab are RTL, the rest LTR", () => {
    for (const l of SK_ANSWER_LANGS) expect(langMeta(l).dir, l).toBe(l === "ar" || l === "ms-arab" ? "rtl" : "ltr");
  });
  it("the speech tags match the dictation table (voice-client.ts SPEECH_LANG)", () => {
    expect(langMeta("ar").speech).toBe("ar-SA");
    expect(langMeta("ms-arab").speech).toBe("ms-MY");
    expect(langMeta("zh").speech).toBe("zh-CN");
    expect(langMeta("hi").speech).toBe("hi-IN");
  });
  it("the ten UI locales are answer languages; zh is answer-only and its lines are English", () => {
    for (const { value } of LOCALES) expect(SK_ANSWER_LANGS).toContain(value);
    expect(LOCALES.map((l) => l.value as string)).not.toContain("zh");
    expect(linesLocale("zh")).toBe("en");
    expect(linesLocale("ar")).toBe("ar");
  });
  it("I can speak … names every language in its own name", () => {
    const list = canSpeakList();
    for (const l of SK_ANSWER_LANGS) expect(list).toContain(LANG_INFO[l].own);
  });
});

describe("the rules router's lang intent", () => {
  const ctx = () => makeCtx();
  const now = new Date("2026-10-30T09:00:00Z");
  it("routes a repeat and a back for any role, before Board / navigate rules", () => {
    expect(routeByRules("say that in Malay", ctx(), now)).toEqual({ intent: "lang", command: { kind: "repeat", target: { code: "ms" } } });
    expect(routeByRules("back to English", ctx(), now)).toEqual({ intent: "lang", command: { kind: "back", target: { code: "en" } } });
    const student = { ...ctx(), user: { ...ctx().user, role: "student" as const } };
    expect(routeByRules("explain that again in English", student, now).intent).toBe("lang");
  });
  it("leaves other turns alone", () => {
    expect(routeByRules("show me analytics", ctx(), now).intent).toBe("navigate");
    expect(routeByRules("explain photosynthesis in Malay", ctx(), now).intent).toBe("ask");
  });
});

describe("the model is told the answer language", () => {
  it("override, source and UI each phrase rule 6; zh is named", () => {
    const base = makeCtx();
    expect(buildShellPrompt({ ctx: { ...base, answer: { lang: "zh", from: "override", override: "zh", uiLocale: "en" } }, capabilities: [] })).toContain("6. Answer in Simplified Chinese (zh-CN) — the user asked for");
    expect(buildShellPrompt({ ctx: { ...base, answer: { lang: "ar", from: "source", override: null, uiLocale: "en" } }, capabilities: [] })).toContain("6. Answer in Arabic, the language of the lesson material");
    expect(buildShellPrompt({ ctx: base, capabilities: [] })).toContain("If tool results carry a source_language");
  });
  it("a tool result that names its source's language carries it to the model", () => {
    expect(toolResultText({ ok: true, summary: "x", language: "ar" })).toContain('"source_language":"ar"');
    expect(toolResultText({ ok: true, summary: "x" })).not.toContain("source_language");
  });
});
