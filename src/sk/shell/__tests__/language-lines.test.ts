/**
 * SK's answer-language lines (language-lines.ts) are the SAME strings as the
 * dictionary's sk.shell.lang.* in all ten locales, with their placeholders;
 * zh (an answer language with no UI dictionary) is present in the tables only.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/language-lines.test.ts
 */
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/locales";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import te from "@/i18n/messages/te.json";
import mr from "@/i18n/messages/mr.json";
import hi from "@/i18n/messages/hi.json";
import msArab from "@/i18n/messages/ms-arab.json";
import { LANG_CAN_SPEAK, LANG_NOTHING_TO_REPEAT, LANG_SOURCE_UNSUPPORTED, LANG_SWITCHED, langLine } from "../language-lines";
import { SK_ANSWER_LANGS } from "../language";

type Lang = { nothingToRepeat: string; canSpeak: string; switched: string; sourceUnsupported: string };
const FILES = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, { sk: { shell: { lang: Lang } } }>;
const TABLES: Array<[keyof Lang, Record<string, string>, string[]]> = [
  ["nothingToRepeat", LANG_NOTHING_TO_REPEAT, []],
  ["canSpeak", LANG_CAN_SPEAK, ["{list}"]],
  ["switched", LANG_SWITCHED, ["{language}"]],
  ["sourceUnsupported", LANG_SOURCE_UNSUPPORTED, ["{source}", "{language}"]],
];

describe("language-lines.ts ⇄ messages/*.json", () => {
  it("every UI locale's line equals the dictionary's, placeholders intact", () => {
    for (const { value } of LOCALES) {
      for (const [key, table, holders] of TABLES) {
        expect(table[value], `${key} ${value}`).toBe(FILES[value]!.sk.shell.lang[key]);
        for (const h of holders) expect(table[value], `${key} ${value} ${h}`).toContain(h);
      }
    }
  });
  it("each table covers every answer language (zh included), each a real translation", () => {
    for (const [key, table] of TABLES) {
      expect(Object.keys(table).sort(), key).toEqual([...SK_ANSWER_LANGS].sort());
      for (const l of SK_ANSWER_LANGS) if (l !== "en") expect(table[l], `${key} ${l}`).not.toBe(table.en);
    }
  });
  it("Jawi lines are in the Arabic script, Malay ones in Rumi", () => {
    for (const [, table] of TABLES) {
      expect(table["ms-arab"]).toMatch(/[؀-ۿ]/);
      expect(table.ms).not.toMatch(/[؀-ۿ]/);
    }
  });
  it("the nothing-to-repeat line in the current language, English for an unknown one", () => {
    expect(langLine(LANG_NOTHING_TO_REPEAT, "en")).toBe("There's nothing to repeat yet — ask me something first.");
    expect(langLine(LANG_NOTHING_TO_REPEAT, "zh")).toBe("还没有可以重复的内容——请先问我一个问题。");
    expect(langLine(LANG_NOTHING_TO_REPEAT, "xx")).toBe(LANG_NOTHING_TO_REPEAT.en);
    expect(langLine(LANG_SWITCHED, "ms", { language: "Bahasa Melayu" })).toBe("Baik — saya akan menjawab dalam Bahasa Melayu mulai sekarang.");
  });
});
