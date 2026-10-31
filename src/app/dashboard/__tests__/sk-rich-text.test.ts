/**
 * SK's chat renders a lesson (student Board phase 3, 2026-10-31): headings,
 * a numbered list, bold, maths inline and as a block (a fraction is a
 * two-row box, never "\frac"), a price stays a price, a plain reply renders
 * exactly as before — and the ten locales carry the new chat strings.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/sk-rich-text.test.ts
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SkRichText from "../sk-rich-text";
import RichText from "@/components/rich-text";
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

const html = (text: string) => renderToStaticMarkup(createElement(SkRichText, { text }));

const LESSON = [
  "**Extra** · beyond your lesson",
  "",
  "### Equivalent fractions",
  "They show the same amount.",
  "",
  "**Steps**",
  "1. Multiply the top and bottom by the same number.",
  "2. Or divide them.",
  "",
  "**A new example**",
  "Simplify $\\frac{10}{15}$.",
  "- Both divide by 5.",
  "$$\\frac{10}{15} = \\frac{2}{3}$$",
  "**Answer:** $x^2$",
].join("\n");

describe("a lesson in SK's chat", () => {
  const out = html(LESSON);

  it("heading, numbered steps, a bullet, bold", () => {
    expect(out).toContain('role="heading"');
    expect(out).toContain("Equivalent fractions");
    expect(out).toMatch(/<ol[^>]*><li>.*Multiply the top and bottom.*<\/li><li>.*Or divide them\..*<\/li><\/ol>/);
    expect(out).toMatch(/<ul[^>]*><li>.*Both divide by 5\..*<\/li><\/ul>/);
    expect(out).toContain("<strong>Extra</strong>");
  });

  it("maths drawn, never shown as markup", () => {
    expect(out).not.toContain("\\frac");
    expect(out).not.toContain("$");
    expect(out).toContain('data-sk-math="frac"');
    expect(out).toContain('data-sk-math="block"');
    expect(out).toContain('aria-label="10/15=2/3"');
    expect(out).toMatch(/<sup[^>]*>.*2.*<\/sup>/);
  });

  it("a plain reply renders exactly as before; a price is not maths", () => {
    const plain = "Osmosis moves water. It costs $2 and $3.";
    expect(html(plain)).toBe(renderToStaticMarkup(createElement(RichText, { text: plain })));
  });
});

describe("the new chat strings, in all ten locales", () => {
  const files = { en, ms, "ms-arab": msArab, ar, fr, es, pt, te, mr, hi } as const;
  it("sk.shell.teach is complete and translated", () => {
    const keys = Object.keys(en.sk.shell.teach).sort();
    expect(keys).toEqual(["extraNo", "extraOffer", "extraYes", "gapNote", "pictureFrom"]);
    for (const [loc, f] of Object.entries(files)) {
      const t = (f as typeof en).sk.shell.teach;
      expect(Object.keys(t).sort(), loc).toEqual(keys);
      for (const k of keys) expect((t as Record<string, string>)[k].trim(), `${loc}.${k}`).toBeTruthy();
      expect(t.pictureFrom, loc).toContain("{n}");
      if (loc !== "en") expect(t.extraOffer, loc).not.toBe(en.sk.shell.teach.extraOffer);
    }
  });
});
