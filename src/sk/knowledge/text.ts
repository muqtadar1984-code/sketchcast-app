// SK S7 K1 — the pure text helpers behind the three importers: block
// flattening (the same rules as 0160's sk_block_text), the paragraph splitter
// for uploads, chunking to the 8000-char block cap, and a cheap script-based
// language guess. No I/O; importable from tests and scripts.

/** sk_knowledge_blocks.text is capped at 8000 characters (migration 0174). */
export const MAX_BLOCK_CHARS = 8000;
/** An upload paragraph block is at most this long (design K1). */
export const USER_BOOK_BLOCK_CHARS = 1200;

const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

/** A language code the blocks table accepts, or null. */
export function normLanguage(lang: unknown): string | null {
  if (typeof lang !== "string") return null;
  const l = lang.trim().toLowerCase().replace(/_/g, "-");
  return LANG_RE.test(l) ? l : null;
}

/** Markdown emphasis and heading marks stripped, whitespace collapsed. */
export function plain(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Any JSON value as plain text (arrays/objects joined with spaces). */
export function flat(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(flat).filter(Boolean).join(" ");
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(flat).filter(Boolean).join(" ");
  return "";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The text one manuscript block contributes — 0160's sk_block_text rules:
 * paragraph / key_idea / extension / think → text (think's `answer` is an
 * answer key and is NEVER included); key_term → "term: text"; misconception →
 * wrong + right; figure → caption; list → items; table → caption + cells;
 * worked_example → problem + steps + answer (a worked example IS teaching).
 * Unlike 0160, an unknown block type contributes only its `text`/`caption`,
 * never its whole body — a new block type must not leak an answer field.
 */
export function blockText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  let t: string;
  switch (b.type) {
    case "paragraph":
    case "key_idea":
    case "extension":
    case "think":
      t = str(b.text);
      break;
    case "key_term":
      t = `${str(b.term)}: ${str(b.text)}`;
      break;
    case "misconception":
      t = `Common mistake: ${str(b.wrong)} Correct idea: ${str(b.right)}`;
      break;
    case "figure":
      t = str(b.caption);
      break;
    case "list":
      t = flat(b.items);
      break;
    case "table":
      t = `${str(b.caption)} ${flat(b.columns)} ${flat(b.rows)}`;
      break;
    case "worked_example":
      t = `${str(b.problem)} ${flat(b.steps)} ${str(b.answer)}`;
      break;
    default:
      t = `${str(b.text)} ${str(b.caption)}`;
  }
  return plain(t);
}

/** A whole section's text: every block's text, one per line. */
export function flattenSection(section: { blocks?: unknown }): string {
  const blocks = Array.isArray(section?.blocks) ? section.blocks : [];
  return blocks.map(blockText).filter(Boolean).join("\n");
}

// ── splitting ───────────────────────────────────────────────────────────────
// Sentence ends: . ! ? and the Arabic/Urdu/Devanagari marks, followed by space.
const SENTENCE_END = /([.!?\u061F\u06D4\u0964])\s+/g;
const sentences = (p: string): string[] => p.replace(SENTENCE_END, "$1\n").split("\n");

/** Cut one over-long run at the last whitespace before `max` (else at `max`). */
function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    const cut = rest.lastIndexOf(" ", max);
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Pack pieces greedily into chunks of at most `max`, joined by `sep`. */
function pack(pieces: string[], max: number, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (!p) continue;
    if (!cur) cur = p;
    else if (cur.length + sep.length + p.length <= max) cur += sep + p;
    else {
      out.push(cur);
      cur = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** One paragraph (whitespace already collapsed) as pieces of at most `max`. */
function splitLong(p: string, max: number): string[] {
  if (p.length <= max) return [p];
  const parts = sentences(p).flatMap((s) => (s.length > max ? hardSplit(s, max) : [s]));
  return pack(parts, max, " ");
}

/**
 * Text → chunks of at most `max` characters: paragraphs on blank lines (a
 * paragraph's own line breaks become spaces — PDF text breaks every line),
 * consecutive short paragraphs packed together, a long one split at sentence
 * ends, a sentence longer than `max` cut at whitespace.
 */
export function splitParagraphs(source: string, max: number = USER_BOOK_BLOCK_CHARS): string[] {
  if (typeof source !== "string" || !source.trim()) return [];
  const paras = source
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return pack(paras.flatMap((p) => splitLong(p, max)), max, "\n\n");
}

/** A section/article text cut to the block cap (usually one chunk). */
export function chunkText(text: string, max: number = MAX_BLOCK_CHARS): string[] {
  if (!text.trim()) return [];
  if (text.length <= max) return [text.trim()];
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean).flatMap((l) => splitLong(l.replace(/\s+/g, " "), max));
  return pack(lines, max, "\n");
}

// ── language ────────────────────────────────────────────────────────────────
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/g;
const LATIN = /[A-Za-z\u00C0-\u024F]/g;

/** Cheap script detection for an upload with no language: Arabic script → 'ar', else 'en'. */
export function detectLanguage(text: string): "ar" | "en" {
  const sample = (text ?? "").slice(0, 20000);
  const arabic = sample.match(ARABIC_SCRIPT)?.length ?? 0;
  const latin = sample.match(LATIN)?.length ?? 0;
  return arabic > 0 && arabic >= latin ? "ar" : "en";
}
