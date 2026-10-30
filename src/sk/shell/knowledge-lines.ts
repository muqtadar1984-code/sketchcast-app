// SK S7 K2 — the fixed words of a knowledge citation, ten locales. SK writes
// the citation line itself from these (never the model's own wording), and the
// panel's chips use the same strings from src/i18n/messages/*.json
// `sk.shell.knowledge.*` (knowledge-lines.test.ts holds the copies equal).
// ms-arab is Malay in Jawi.

import { lineFor } from "./lines";

type Line = Record<string, string>;

/** "From: Biology · ch 5 · Specialised cells" */
export const KNOWLEDGE_FROM: Line = {
  en: "From: {source}",
  ms: "Sumber: {source}",
  "ms-arab": "سومبر: {source}",
  ar: "المصدر: {source}",
  fr: "Source : {source}",
  es: "Fuente: {source}",
  pt: "Fonte: {source}",
  te: "మూలం: {source}",
  mr: "स्रोत: {source}",
  hi: "स्रोत: {source}",
};

/** The chapter in a citation: "ch 5". */
export const KNOWLEDGE_CHAPTER: Line = {
  en: "ch {n}",
  ms: "bab {n}",
  "ms-arab": "باب {n}",
  ar: "الفصل {n}",
  fr: "chap. {n}",
  es: "cap. {n}",
  pt: "cap. {n}",
  te: "అధ్యాయం {n}",
  mr: "धडा {n}",
  hi: "अध्याय {n}",
};

/** The panel's label over the citation chips. */
export const KNOWLEDGE_SOURCES: Line = {
  en: "Sources",
  ms: "Sumber",
  "ms-arab": "سومبر",
  ar: "المصادر",
  fr: "Sources",
  es: "Fuentes",
  pt: "Fontes",
  te: "మూలాలు",
  mr: "स्रोत",
  hi: "स्रोत",
};

export type CitationParts = { title: string; chapter: number | null; section?: string | null };

/** "Biology · ch 5 · Specialised cells" (a part that is missing or repeats the title is left out). */
export function citationText(c: CitationParts, locale: string | null | undefined): string {
  const parts = [c.title.trim()];
  if (c.chapter != null && Number.isFinite(c.chapter)) parts.push(lineFor(KNOWLEDGE_CHAPTER, locale, { n: c.chapter }));
  const section = (c.section ?? "").trim();
  if (section && section.toLowerCase() !== c.title.trim().toLowerCase()) parts.push(section);
  return parts.filter(Boolean).join(" · ");
}

/** The one citation line SK adds under an answer from its knowledge. */
export function citeLine(list: CitationParts[], locale: string | null | undefined): string {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const c of list) {
    const t = citationText(c, locale);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    texts.push(t);
    if (texts.length === 2) break;
  }
  return texts.length ? lineFor(KNOWLEDGE_FROM, locale, { source: texts.join("; ") }) : "";
}
