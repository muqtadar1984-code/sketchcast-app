/**
 * The words of "highlight a portion and ask SK" and the deck note's rewording,
 * in all ten locales: present, translated (not English), and Jawi in Jawi.
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/highlight-i18n.test.ts
 */
import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import msArab from "@/i18n/messages/ms-arab.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import te from "@/i18n/messages/te.json";
import mr from "@/i18n/messages/mr.json";
import hi from "@/i18n/messages/hi.json";

const ALL = { en, ms, "ms-arab": msArab, ar, fr, es, pt, te, mr, hi };
const pick = (m: typeof en) => ({ ask: m.present.board.askAboutThis, explain: m.sk.shell.explainSelection, note: m.present.doc.noteDeck });

describe("highlight-ask strings", () => {
  it("English is what the founder asked for", () => {
    expect(pick(en)).toEqual({ ask: "Ask SK about this", explain: "Explain this part", note: "Download, or load it onto the board as pages" });
  });
  it.each(Object.entries(ALL).filter(([l]) => l !== "en"))("%s: present and translated", (_l, m) => {
    const p = pick(m as typeof en);
    for (const k of ["ask", "explain", "note"] as const) {
      expect(p[k].trim().length).toBeGreaterThan(3);
      expect(p[k]).not.toBe(pick(en)[k]);
    }
    // The old deck note ("the board shows the slides from the video") is gone.
    expect(p.note).not.toBe("Download — the board shows the slides from the video");
  });
  it("ms-arab is Malay in Jawi script, not the Arabic strings", () => {
    const j = pick(msArab);
    const a = pick(ar);
    for (const k of ["ask", "explain", "note"] as const) expect(j[k]).not.toBe(a[k]);
    expect(j.explain + j.note).toMatch(/[ڤݢڠ]/u); // letters Jawi has and Arabic does not
  });
});
