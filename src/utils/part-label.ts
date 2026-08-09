// Part labels — the app-side mirror of the worker's `shared/part_label.py`.
//
// The founder's rule, verbatim: *every part must carry the chapter name and the
// part number, not just "Part 1", "Part 2"*.
//
// The worker composes that rule for the string it PERSISTS (generations.title).
// This module composes it for everything the app RENDERS — the Library card
// above all, which is the surface the teacher actually looks at and the one the
// bug report was about. The two must agree, so the degrade rules below are a
// line-for-line mirror of the Python:
//
//   heading usable          → the heading is the name
//   no usable heading       → "<chapter> · Part k of n"
//   single-part chapter     → "<chapter>" alone; "Part 1 of 1" is noise
//   never                   → a bare ordinal ("Part 3"), which names nothing
//
// TWO THINGS THE PYTHON DOES NOT HAVE TO DO, and this file must:
//
// 1. LOCALISE. The worker bakes English "Part"/"of" into a stored string and
//    can never take it back. Nothing composed here is stored, so every word
//    comes from the message catalogue and the label reads in the teacher's
//    language in all ten locales.
//
// 2. ISOLATE FOR BIDI. "Part 3 of 7" is a Latin+digit run; an Arabic or Jawi
//    chapter name is RTL. Concatenated raw inside an RTL paragraph the bidi
//    algorithm reorders the runs and the label comes out in the wrong visual
//    order (the ordinal jumps to the far side of the separator). Each
//    substituted run is therefore wrapped in U+2068 FIRST STRONG ISOLATE …
//    U+2069 POP DIRECTIONAL ISOLATE — the character-level equivalent of the
//    <bdi> element, used here because a label also travels into `title=` and
//    `aria-label=` attributes where an element cannot go. Render sites wrap the
//    result in <bdi> as well, which isolates the label from ITS surroundings.
//    (The messages test forbids bidi controls inside the catalogue files; these
//    are added at compose time, around runtime values, which is exactly where
//    they belong.)
//
// PURE — no next/*, no server-only — so a server component and a client card
// can both call it.

import { fmt } from "@/i18n/format";

/** The message slice the composer needs. `LibraryMessages` satisfies it. */
export type PartLabelMessages = {
  /** "Part {n} of {total}" */
  partOfTotal: string;
  /** "{chapter} · {part}" */
  partAnchored: string;
  /** "{chapter} · {part} — {heading}" */
  partAnchoredTitled: string;
  /** Fallback name for a chapter with no title at all ("Untitled lesson"). */
  untitled: string;
};

// Exact-match only, and deliberately SHORT — mirrors _PLACEHOLDER_RE. "Content"
// is the structurer's no-headings-found placeholder and was 47% of every part
// in production. A substring rule would eat real headings like "Content of the
// cell".
const PLACEHOLDER_RE = /^(content|contents|text|body|untitled|chapter|section)$/i;

// "3", "3.", "(4)", "1 - " … a heading that is only a number names nothing.
// Mirrors _BARE_NUMERAL_RE, en/em dashes and parentheses included — the old
// card-local filter (/^[\d.)\s-]+$/) missed "(4)" and "1 — ".
const BARE_NUMERAL_RE = /^[\d.)(\s\-–—]+$/;

// Escapes, not the literal characters: U+2068/U+2069 are invisible, so a
// literal here would be a diff nobody can see and a copy-paste nobody can keep.
const FSI = "\u2068";
const PDI = "\u2069";

/** Wrap a runtime value so its direction cannot leak into the label around it. */
const iso = (s: string): string => `${FSI}${s}${PDI}`;

/** Collapse runs of whitespace; "" for null/undefined. Mirrors `" ".join(s.split())`. */
const tidy = (s: unknown): string => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");

/** Case/space-insensitive comparison key. Mirrors `_fold`. */
const fold = (s: unknown): string => tidy(s).toLowerCase();

/**
 * The first section heading worth showing as a part's name, or null.
 *
 * Drops blanks, bare numerals, the placeholders above, and any heading that is
 * just an echo of the chapter title (which tells the teacher nothing the row
 * above it doesn't already say). Mirrors `part_heading`.
 */
export function partHeading(titles: readonly string[] | null | undefined, chapterTitle = ""): string | null {
  const chapterKey = fold(chapterTitle);
  for (const raw of titles ?? []) {
    const heading = tidy(raw);
    if (!heading || BARE_NUMERAL_RE.test(heading) || PLACEHOLDER_RE.test(heading)) continue;
    if (fold(heading) === chapterKey) continue;
    return heading;
  }
  return null;
}

/** The showable subset of a part's section headings, in order. Mirrors `clean_part_titles`. */
export function cleanPartTitles(
  titles: readonly string[] | null | undefined,
  chapterTitle = "",
  limit = 3,
): string[] {
  const chapterKey = fold(chapterTitle);
  const out: string[] = [];
  for (const raw of titles ?? []) {
    const heading = tidy(raw);
    if (!heading || BARE_NUMERAL_RE.test(heading) || PLACEHOLDER_RE.test(heading)) continue;
    if (fold(heading) === chapterKey || out.includes(heading)) continue;
    out.push(heading);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * "Part 3 of 7", localised — or null when the ordinal names nothing.
 *
 * Null for a single-part chapter (`total <= 1`): "Part 1 of 1" is noise, and a
 * re-index that shrinks a part map used to emit exactly that. Null, not a bare
 * "Part 3", when the total is unknown — a bare ordinal is the string the rule
 * forbids, so callers get nothing to render rather than the wrong thing.
 */
export function partOrdinal(t: PartLabelMessages, part: number, total: number): string | null {
  if (!Number.isFinite(part) || !Number.isFinite(total)) return null;
  if (part < 1 || total <= 1) return null;
  return fmt(t.partOfTotal, { n: part, total });
}

/** The chapter name, tidied, or the localised "untitled" fallback. */
export function chapterName(t: PartLabelMessages, chapterTitle: string | null | undefined): string {
  return tidy(chapterTitle) || t.untitled;
}

/**
 * "<chapter> · Part 3 of 7" — the chapter-anchored ordinal, with no heading.
 *
 * This is the string that guarantees the rule: wherever a part is named without
 * a heading of its own, the chapter name travels with the number. Degrades to
 * the plain chapter name for a single-part chapter.
 */
export function partAnchor(
  t: PartLabelMessages,
  chapterTitle: string | null | undefined,
  part: number,
  total: number,
): string {
  const name = chapterName(t, chapterTitle);
  const ordinal = partOrdinal(t, part, total);
  return ordinal ? fmt(t.partAnchored, { chapter: iso(name), part: iso(ordinal) }) : name;
}

/**
 * The full, one-string name of a part — the mirror of Python `part_label`.
 *
 *     "Feedback Loops · Part 3 of 7 — Balancing loops"   (heading available)
 *     "Feedback Loops · Part 3 of 7"                     (no usable heading)
 *     "Feedback Loops"                                   (single-part chapter)
 *
 * Used where a part needs ONE string: a tooltip, an aria-label, a report. The
 * card splits it across its title and meta lines instead, from the same pieces.
 */
export function partLabel(
  t: PartLabelMessages,
  {
    chapterTitle,
    part,
    total,
    titles,
  }: {
    chapterTitle?: string | null;
    part: number;
    total: number;
    titles?: readonly string[] | null;
  },
): string {
  const name = chapterName(t, chapterTitle);
  const ordinal = partOrdinal(t, part, total);
  if (!ordinal) return name;
  const heading = partHeading(titles, chapterTitle ?? "");
  return heading
    ? fmt(t.partAnchoredTitled, { chapter: iso(name), part: iso(ordinal), heading: iso(heading) })
    : fmt(t.partAnchored, { chapter: iso(name), part: iso(ordinal) });
}
