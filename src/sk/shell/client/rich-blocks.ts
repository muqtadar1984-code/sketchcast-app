// SK's chat text as BLOCKS (student Board phase 3, 2026-10-31): the little
// Markdown SK's lessons use — a heading, paragraphs, numbered and bulleted
// lists, **bold** / *italic*, maths inline ($…$) and on its own line ($$…$$)
// — parsed into typed blocks the chat renders as plain React elements
// (sk-rich-text.tsx: no HTML strings, no injection surface). Every other SK
// reply is plain sentences and renders exactly as before (one paragraph).
//
// Plus the two flat forms: `plainOf` for the speech bubble and the caption,
// `spokenOf` for the read-aloud (the maths said as words, the markup gone).
//
// PURE: no DOM, no React.

import { emphasisSegments } from "@/utils/emphasis";
import { parseTex, texPlain, texSpoken, type TexNode } from "./tex";

export type Inline = { kind: "text"; text: string; bold?: boolean; italic?: boolean } | { kind: "math"; tex: TexNode[]; display?: boolean };

export type Block =
  | { kind: "heading"; inline: Inline[] }
  | { kind: "para"; lines: Inline[][] }
  | { kind: "ol"; items: Inline[][] }
  | { kind: "ul"; items: Inline[][] }
  | { kind: "math"; tex: TexNode[] };

/**
 * Split a line on its maths. `$$…$$` anywhere; `$…$` the way Pandoc reads it
 * so a price is never maths: the opening `$` is followed by a non-space, the
 * closing one is preceded by a non-space and NOT followed by a digit ("costs
 * $20 and $15" has no maths in it). `\$` is a dollar sign.
 */
export function splitMath(line: string): Array<{ math: false; text: string } | { math: true; tex: string; display: boolean }> {
  const out: Array<{ math: false; text: string } | { math: true; tex: string; display: boolean }> = [];
  let buf = "";
  let i = 0;
  const s = line ?? "";
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "$") {
      buf += "$";
      i += 2;
      continue;
    }
    if (c === "$" && s[i + 1] === "$") {
      const end = s.indexOf("$$", i + 2);
      if (end > i + 2) {
        if (buf) out.push({ math: false, text: buf });
        buf = "";
        out.push({ math: true, tex: s.slice(i + 2, end).trim(), display: true });
        i = end + 2;
        continue;
      }
    }
    if (c === "$" && s[i + 1] && !/\s/.test(s[i + 1])) {
      let j = i + 1;
      let close = -1;
      while (j < s.length) {
        if (s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === "$" && !/\s/.test(s[j - 1]) && !/\d/.test(s[j + 1] ?? "")) {
          close = j;
          break;
        }
        j++;
      }
      if (close > i + 1) {
        if (buf) out.push({ math: false, text: buf });
        buf = "";
        out.push({ math: true, tex: s.slice(i + 1, close), display: false });
        i = close + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  if (buf) out.push({ math: false, text: buf });
  return out;
}

/** One line → its inline runs (maths, then **bold** / *italic* in the rest). */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  for (const part of splitMath(line)) {
    if (part.math) {
      out.push({ kind: "math", tex: parseTex(part.tex), ...(part.display ? { display: true } : {}) });
      continue;
    }
    for (const seg of emphasisSegments(part.text)) {
      if (!seg.text) continue;
      out.push({ kind: "text", text: seg.text, ...(seg.bold ? { bold: true } : {}), ...(seg.italic ? { italic: true } : {}) });
    }
  }
  return out;
}

const HEADING = /^#{1,4}\s+(.+)$/;
const OL = /^\s*(\d{1,2})[.)]\s+(.+)$/;
const UL = /^\s*[-*•]\s+(.+)$/;
const BLOCK_MATH = /^\s*\$\$([\s\S]+?)\$\$\s*$/;

/** SK's text → blocks. A reply with none of the markup is one paragraph. */
export function parseBlocks(text: string): Block[] {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: Inline[][] | null = null;
  let list: { kind: "ol" | "ul"; items: Inline[][] } | null = null;
  const flush = () => {
    if (para?.length) out.push({ kind: "para", lines: para });
    if (list?.items.length) out.push(list);
    para = null;
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    // A $$ block over several lines.
    if (line.trim() === "$$") {
      const end = lines.findIndex((l, j) => j > i && l.trim() === "$$");
      if (end > i) {
        flush();
        out.push({ kind: "math", tex: parseTex(lines.slice(i + 1, end).join(" ")) });
        i = end;
        continue;
      }
    }
    const bm = BLOCK_MATH.exec(line);
    if (bm) {
      flush();
      out.push({ kind: "math", tex: parseTex(bm[1].trim()) });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      out.push({ kind: "heading", inline: parseInline(h[1].trim()) });
      continue;
    }
    const ol = OL.exec(line);
    const ul = ol ? null : UL.exec(line);
    if (ol || ul) {
      const kind = ol ? "ol" : "ul";
      if (para) {
        out.push({ kind: "para", lines: para });
        para = null;
      }
      if (list && list.kind !== kind) {
        out.push(list);
        list = null;
      }
      list ??= { kind, items: [] };
      list.items.push(parseInline((ol ? ol[2] : ul![1]).trim()));
      continue;
    }
    if (list) {
      out.push(list);
      list = null;
    }
    para ??= [];
    para.push(parseInline(line));
  }
  flush();
  return out;
}

// ── flat forms ───────────────────────────────────────────────────────────────

/** Drop the Markdown marks of one line (the maths handled by the caller). */
const unmark = (s: string) =>
  s
    .replace(/^#{1,4}\s+/, "")
    .replace(/^\s*[-*•]\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1$2");

const flatLine = (line: string, math: (tex: string) => string) =>
  splitMath(unmark(line))
    .map((p) => (p.math ? math(p.tex) : p.text))
    .join("")
    .trim();

/** The text as the bubble and the caption show it: no marks, maths as Unicode. */
export function plainOf(text: string): string {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => flatLine(l, (tex) => texPlain(parseTex(tex))))
    .filter(Boolean)
    .join("\n");
}

/** The text as SK reads it aloud: no marks; maths as words (English) or as
 *  symbols its own voice reads (every other language). Lines become
 *  sentences so the voice pauses between steps. */
export function spokenOf(text: string, lang?: string | null): string {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => flatLine(l, (tex) => texSpoken(parseTex(tex), lang)))
    .filter(Boolean)
    .map((l) => (/[.!?؟。।:]$/u.test(l) ? l : `${l}.`))
    .join(" ");
}

/** Does this text carry any of the lesson markup (so it needs the block renderer)? */
export function hasMarkup(text: string): boolean {
  return /(^|\n)\s*(?:#{1,4}\s|\d{1,2}[.)]\s|[-*•]\s|\$\$)/.test(text ?? "") || splitMath(text ?? "").some((p) => p.math);
}
