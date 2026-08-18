// Markdown emphasis → typed segments, for the chat bubbles. The models bold
// with **markers** despite their prompts; the voice half strips them
// (speakable.ts) and this is the display half — the bubbles render real
// emphasis instead of raw asterisks (founder, 2026-08-18).
//
// PURE and deliberately tiny: bold/italic pairs only, single line each,
// longest marker first so ** is never read as two *. Anything unbalanced or
// unrecognized stays literal text — never guessed, never dropped. Rendering
// happens in components/rich-text.tsx as React nodes, so there is no HTML
// string anywhere and no injection surface.

export type EmphasisSegment = { text: string; bold: boolean; italic: boolean };

// Markdown's edge rule, enforced: emphasis content never starts or ends with
// whitespace — so "2 ** 3" and a lone dangling * stay literal arithmetic/text.
const EDGE = "([^*\\s](?:[^*\\n]*[^*\\s])?)";
const EMPHASIS = new RegExp(`\\*\\*\\*${EDGE}\\*\\*\\*|\\*\\*${EDGE}\\*\\*|\\*${EDGE}\\*`, "g");

export function emphasisSegments(text: string): EmphasisSegment[] {
  const s = String(text ?? "");
  const out: EmphasisSegment[] = [];
  let last = 0;
  for (const m of s.matchAll(EMPHASIS)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: s.slice(last, at), bold: false, italic: false });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true, italic: true });
    else if (m[2] !== undefined) out.push({ text: m[2], bold: true, italic: false });
    else out.push({ text: m[3]!, bold: false, italic: true });
    last = at + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), bold: false, italic: false });
  return out;
}
