// SK S7 K2 — the citation words in ten locales: the server's copy
// (knowledge-lines.ts) equals the dictionaries' sk.shell.knowledge.*, every
// locale has real text, and the line / chip read "Biology · ch 5 · Specialised cells".
// Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/knowledge-lines.test.ts
import { describe, expect, it } from "vitest";
import { KNOWLEDGE_CHAPTER, KNOWLEDGE_FROM, KNOWLEDGE_SOURCES, citationText, citeLine } from "../knowledge-lines";
import { citationChips } from "../client/citations";
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

const DICTS: Record<string, { sk: { shell: { knowledge: { sources: string; chapter: string; from: string } } } }> = { en, ms, "ms-arab": msArab, ar, fr, es, pt, te, mr, hi };

describe("citation strings", () => {
  it("the server's lines equal the dictionaries in all ten locales", () => {
    for (const [loc, d] of Object.entries(DICTS)) {
      expect(d.sk.shell.knowledge, loc).toEqual({ sources: KNOWLEDGE_SOURCES[loc], chapter: KNOWLEDGE_CHAPTER[loc], from: KNOWLEDGE_FROM[loc] });
      expect(KNOWLEDGE_CHAPTER[loc], loc).toContain("{n}");
      expect(KNOWLEDGE_FROM[loc], loc).toContain("{source}");
    }
  });
  it("translated, not copied: only French shares English's 'Sources'; ms-arab is in Jawi", () => {
    for (const loc of Object.keys(DICTS)) if (loc !== "en" && loc !== "fr") expect(KNOWLEDGE_SOURCES[loc], loc).not.toBe(KNOWLEDGE_SOURCES.en);
    for (const t of [KNOWLEDGE_SOURCES["ms-arab"], KNOWLEDGE_CHAPTER["ms-arab"], KNOWLEDGE_FROM["ms-arab"]]) expect(t).toMatch(/[\u0600-\u06FF]/u);
  });
  it("the citation line and the chips", () => {
    const c = { title: "Biology", chapter: 5, section: "Specialised cells" };
    expect(citationText(c, "en")).toBe("Biology · ch 5 · Specialised cells");
    expect(citeLine([c, c, { title: "Photosynthesis", chapter: null, section: "Photosynthesis" }], "en")).toBe("From: Biology · ch 5 · Specialised cells; Photosynthesis");
    expect(citeLine([{ title: "الأحياء", chapter: 5, section: "الخلايا" }], "ar")).toBe("المصدر: الأحياء · الفصل 5 · الخلايا");
    expect(citeLine([], "en")).toBe("");
    expect(citationChips([{ title: "Biology", chapter: 5, anchor: "s3", section: "Specialised cells", kind: "sketchcast_book" }, { title: "x", kind: "nope" }, null], ms.sk.shell.knowledge.chapter)).toEqual([
      { key: "sketchcast_book:Biology · bab 5 · Specialised cells", text: "Biology · bab 5 · Specialised cells", kind: "sketchcast_book" },
    ]);
    expect(citationChips("not a list", "ch {n}")).toEqual([]);
  });
});
