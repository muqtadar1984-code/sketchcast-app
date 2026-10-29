/**
 * S4 slice D: SK's book-activation lines (act-book-lines.ts) are the SAME
 * strings as the dictionary's sk.shell.book.* in all ten locales, with their
 * placeholders intact; the /activate page's dictionary (activate.*) and the
 * new card labels exist in every locale with English's keys and placeholders.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/act-book-lines.test.ts
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
import { BOOK_LINE_TABLES } from "../act-book-lines";
import { lineFor } from "../lines";

type Tree = { [k: string]: string | Tree };
type File = { sk: { shell: { book: Record<string, string>; cardParams: Record<string, string> } }; activate: Tree };
const FILES: Record<string, File> = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, File>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const flat = (t: Tree, p = ""): Array<[string, string]> => Object.entries(t).flatMap(([k, v]) => (typeof v === "string" ? [[p + k, v] as [string, string]] : flat(v, `${p}${k}.`)));
const locales = LOCALES.map((l) => l.value).sort();

describe("act-book-lines.ts ⇄ messages/*.json (sk.shell.book)", () => {
  it("every table has every locale, equal to the dictionary, placeholders as in English", () => {
    for (const [key, table] of Object.entries(BOOK_LINE_TABLES)) {
      expect(Object.keys(table).sort(), key).toEqual(locales);
      for (const loc of locales) {
        expect(table[loc], `${key}/${loc}`).toBe(FILES[loc].sk.shell.book[key]);
        expect(placeholders(table[loc]), `${key}/${loc}`).toEqual(placeholders(table.en));
        expect(table[loc].trim().length, `${key}/${loc}`).toBeGreaterThan(0);
      }
    }
    expect(Object.keys(FILES.en.sk.shell.book).sort()).toEqual(Object.keys(BOOK_LINE_TABLES).sort());
  });
  it("Malay in Jawi is Arabic script, not Rumi", () => {
    for (const [key, table] of Object.entries(BOOK_LINE_TABLES)) expect(table["ms-arab"], key).toMatch(/[؀-ۿ]/);
  });
  it("the card labels for the book card exist in every locale", () => {
    for (const loc of locales) for (const k of ["code_kind", "code", "order_ref", "child_label"]) expect(FILES[loc].sk.shell.cardParams[k], `${loc}/${k}`).toBeTruthy();
  });
  it("lineFor fills and falls back to English", () => {
    expect(lineFor(BOOK_LINE_TABLES.unlockedFor, "en", { book: "Biology", child: "Aisyah" })).toBe("Biology is now unlocked for Aisyah.");
    expect(lineFor(BOOK_LINE_TABLES.cardTitleFor, "xx", { child: "Aisyah" })).toBe("Activate a book code for Aisyah");
  });
});

describe("the /activate page dictionary (activate.*)", () => {
  it("every locale has English's keys, non-empty, with the same placeholders", () => {
    const keys = flat(FILES.en.activate).map(([k]) => k).sort();
    expect(keys).toEqual(expect.arrayContaining(["forWhich", "choose", "noChildNote", "unlockedFor", "errors.notYourChild", "errors.rateLimited", "errors.invalid", "errors.used"]));
    const enMap = Object.fromEntries(flat(FILES.en.activate));
    for (const loc of locales) {
      const m = Object.fromEntries(flat(FILES[loc].activate));
      expect(Object.keys(m).sort(), loc).toEqual(keys);
      for (const k of keys) {
        expect(m[k].trim().length, `${loc}/${k}`).toBeGreaterThan(0);
        expect(placeholders(m[k]), `${loc}/${k}`).toEqual(placeholders(enMap[k]));
      }
    }
  });
});
