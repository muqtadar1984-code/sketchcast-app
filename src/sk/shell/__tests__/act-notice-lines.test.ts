/**
 * S5 slice D: SK's school-notice lines (act-notice-lines.ts) are the SAME
 * strings as the dictionary's sk.shell.notice.* in all ten locales, with their
 * placeholders intact; Malay in Jawi is Arabic script; the notice card's labels
 * exist in every locale.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/act-notice-lines.test.ts
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
import { NOTICE_LINE_TABLES } from "../act-notice-lines";
import { lineFor } from "../lines";

type File = { sk: { shell: { notice: Record<string, string>; cardParams: Record<string, string> } } };
const FILES: Record<string, File> = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, File>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const locales = LOCALES.map((l) => l.value).sort();

describe("act-notice-lines.ts ⇄ messages/*.json (sk.shell.notice)", () => {
  it("every table has every locale, equal to the dictionary, placeholders as in English", () => {
    for (const [key, table] of Object.entries(NOTICE_LINE_TABLES)) {
      expect(Object.keys(table).sort(), key).toEqual(locales);
      for (const loc of locales) {
        expect(table[loc], `${key}/${loc}`).toBe(FILES[loc].sk.shell.notice[key]);
        expect(placeholders(table[loc]), `${key}/${loc}`).toEqual(placeholders(table.en));
        expect(table[loc].trim().length, `${key}/${loc}`).toBeGreaterThan(0);
      }
    }
    expect(Object.keys(FILES.en.sk.shell.notice).sort()).toEqual(Object.keys(NOTICE_LINE_TABLES).sort());
  });
  it("only English is English: every other locale is translated", () => {
    for (const [key, table] of Object.entries(NOTICE_LINE_TABLES)) for (const loc of locales) if (loc !== "en") expect(table[loc], `${key}/${loc}`).not.toBe(table.en);
  });
  it("Malay in Jawi is Arabic script, not Rumi", () => {
    for (const [key, table] of Object.entries(NOTICE_LINE_TABLES)) expect(table["ms-arab"], key).toMatch(/[؀-ۿ]/);
  });
  it("the notice card's labels exist in every locale", () => {
    for (const loc of locales) for (const k of ["title", "body", "starts_at", "school_label", "seen_by"]) expect(FILES[loc].sk.shell.cardParams[k], `${loc}/${k}`).toBeTruthy();
  });
  it("lineFor fills and falls back to English", () => {
    expect(lineFor(NOTICE_LINE_TABLES.seenSchool, "en", { school: "Demo School" })).toBe("Every parent, student and teacher at Demo School");
    expect(lineFor(NOTICE_LINE_TABLES.postedStaff, "xx", { title: "Meeting" })).toBe("Posted to all staff: Meeting.");
  });
});
