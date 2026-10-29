/**
 * Board UX (2026-10-28): every new string is in all ten locales, translated
 * (not English left in place), with its placeholders intact; ms-arab is Malay
 * in Jawi, never the Arabic line.
 * Run: node node_modules/vitest/vitest.mjs run src/i18n/__tests__/board-ux-strings.test.ts
 */
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import ms from "../messages/ms.json";
import ar from "../messages/ar.json";
import fr from "../messages/fr.json";
import es from "../messages/es.json";
import pt from "../messages/pt.json";
import te from "../messages/te.json";
import mr from "../messages/mr.json";
import hi from "../messages/hi.json";
import msArab from "../messages/ms-arab.json";

const FILES = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as const;

/** path → the placeholders it must carry. */
const KEYS: Record<string, string[]> = {
  "present.bar.menu": [],
  "present.bar.backToDashboard": [],
  "present.bar.loadSlides": [],
  "present.doc.deck": [],
  "present.doc.noteDeck": [],
  "present.board.railHandle": [],
  "present.board.railClose": [],
  "sk.shell.loadingSlides": ["{k}", "{n}"],
  "sk.shell.slidesLoaded": ["{n}", "{a}", "{b}"],
};

/** Where the word really is the same: "Menu" in Malay, French and Portuguese. */
const SAME_OK: Record<string, string[]> = { "present.bar.menu": ["ms", "fr", "pt"] };

const at = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);

describe("Board UX strings", () => {
  for (const [path, holes] of Object.entries(KEYS)) {
    it(`${path}: present, translated, placeholders intact`, () => {
      const base = at(en, path);
      expect(typeof base).toBe("string");
      for (const [loc, file] of Object.entries(FILES)) {
        const v = at(file, path);
        expect(typeof v, `${loc} ${path}`).toBe("string");
        expect((v as string).trim().length, `${loc} ${path}`).toBeGreaterThan(0);
        if (loc !== "en" && !SAME_OK[path]?.includes(loc)) expect(v, `${loc} ${path} is still English`).not.toBe(base);
        for (const h of holes) expect(v as string, `${loc} ${path} lost ${h}`).toContain(h);
      }
      expect(at(msArab, path)).not.toBe(at(ar, path));
    });
  }
});
