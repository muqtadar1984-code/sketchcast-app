// SK S7 K2 — the panel's citation chips (pure, client-safe). A `done` event's
// `citations` (the books, articles and uploads an answer came from) become
// short chips under SK's bubble: "Biology · ch 5 · Specialised cells". The
// chapter word comes from the dictionary (sk.shell.knowledge.chapter, ten
// locales; the same strings as shell/knowledge-lines.ts).

import type { SkCitation } from "../types";

export const CITATION_CHIPS_MAX = 3;

/** The chips to show: well-formed citations only, each once, capped. */
export function citationChips(list: unknown, chapterTemplate: string, max = CITATION_CHIPS_MAX): Array<{ key: string; text: string; kind: SkCitation["kind"] }> {
  if (!Array.isArray(list)) return [];
  const out: Array<{ key: string; text: string; kind: SkCitation["kind"] }> = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const c = raw as Partial<SkCitation> | null;
    if (!c || typeof c.title !== "string" || !c.title.trim()) continue;
    if (c.kind !== "sketchcast_book" && c.kind !== "article" && c.kind !== "user_book") continue;
    const parts = [c.title.trim().slice(0, 80)];
    if (typeof c.chapter === "number" && Number.isFinite(c.chapter)) parts.push(chapterTemplate.replace("{n}", String(c.chapter)));
    const section = typeof c.section === "string" ? c.section.trim().slice(0, 80) : "";
    if (section && section.toLowerCase() !== c.title.trim().toLowerCase()) parts.push(section);
    const text = parts.join(" · ");
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ key: `${c.kind}:${text}`, text, kind: c.kind });
    if (out.length >= max) break;
  }
  return out;
}
