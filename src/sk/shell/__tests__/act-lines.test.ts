/**
 * The S2 action lines (act-lines.ts) are the SAME strings as the dictionary's
 * sk.shell.act.* in all ten locales — the server speaks the former, the
 * dictionary carries the latter for the UI and translators — with their
 * placeholders intact, and the card param labels exist for every locale.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/act-lines.test.ts
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
import { ACT_LINE_TABLES } from "../act-lines";
import { lineFor } from "../lines";

type Shell = { sk: { shell: { act: Record<string, string>; cardParams: Record<string, string> } } };
const FILES: Record<string, Shell> = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, Shell>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("act-lines.ts ⇄ messages/*.json (sk.shell.act)", () => {
  it("every table has every registry locale, equal to the dictionary, placeholders as in English", () => {
    const locales = LOCALES.map((l) => l.value).sort();
    for (const [key, table] of Object.entries(ACT_LINE_TABLES)) {
      expect(Object.keys(table).sort(), key).toEqual(locales);
      for (const loc of locales) {
        expect(table[loc], `${key}/${loc}`).toBe(FILES[loc].sk.shell.act[key]);
        expect(placeholders(table[loc]), `${key}/${loc}`).toEqual(placeholders(table.en));
      }
    }
    expect(Object.keys(FILES.en.sk.shell.act).sort()).toEqual(Object.keys(ACT_LINE_TABLES).sort());
  });
  it("the card labels exist in every locale for the same keys", () => {
    const keys = Object.keys(FILES.en.sk.shell.cardParams).sort();
    expect(keys).toEqual(expect.arrayContaining(["body", "count", "entry_date", "note_type", "parents_only", "target_label", "yes", "no"]));
    for (const { value } of LOCALES) expect(Object.keys(FILES[value].sk.shell.cardParams).sort(), value).toEqual(keys);
  });
  it("lineFor fills and falls back to English", () => {
    expect(lineFor(ACT_LINE_TABLES.remindSent, "en", { n: 4 })).toBe("Sent reminders to 4 families (diary).");
    expect(lineFor(ACT_LINE_TABLES.diaryCardTitle, "xx", { target: "7B" })).toBe("Post to 7B's diary");
  });
});
