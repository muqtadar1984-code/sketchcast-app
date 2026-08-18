// Markdown → speakable plain text, for EVERY voice surface (founder,
// 2026-08-18: the narrator was reading "asterisk asterisk" mid-sentence).
//
// The chat models answer in markdown even when their prompt says not to
// (buildSystemPrompt already says "no markdown" — the narrator incident
// proves prompt compliance is not a defense, same lesson as the Gemini
// SSML-in-the-text-field failure). So the guarantee lives here, at the
// boundary where text becomes speech: browser speechSynthesis utterances,
// the streaming sentence queue, and the hosted-voice synthesis input all
// pass through speakableText() first.
//
// PURE module — no React, no DOM — so it is unit-testable and safe to
// import from client components and API routes alike.

/** Strip markdown/markup so TTS reads words, never punctuation art. */
export function speakableText(text: string): string {
  let s = String(text ?? "");

  // Fenced code blocks: drop the fences (and language tag), keep the code
  // text — reading it is still better than the word "backtick" three times.
  s = s.replace(/```[a-zA-Z0-9_-]*\n?/g, "");
  // Inline code: keep the content.
  s = s.replace(/`([^`]*)`/g, "$1");

  // Images then links: speak the label, never the URL.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Emphasis pairs — ***bold italic***, **bold**, *italic*, __/_, ~~strike~~.
  // Innermost first; three passes cover any sane nesting depth.
  for (let i = 0; i < 3; i++) {
    s = s.replace(/(\*{1,3}|_{1,3}|~~)(\S(?:[\s\S]*?\S)?)\1/g, "$2");
  }

  // Line-start structure: headings, blockquotes, bullets, horizontal rules.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  s = s.replace(/^[ \t]*>[ \t]?/gm, "");
  s = s.replace(/^[ \t]*[-*+•][ \t]+/gm, "");
  s = s.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "");

  // Table pipes read as pauses, not "vertical bar".
  s = s.replace(/[ \t]*\|[ \t]*/g, ", ");

  // Whatever emphasis markers survive (unbalanced pairs, markers split across
  // streamed sentences) must never reach the voice. '#' is deliberately kept:
  // "question #2" speaks naturally as "number 2".
  s = s.replace(/[*~]+/g, " ");
  s = s.replace(/(^|\s)_+|_+(\s|$)/g, "$1$2"); // strip underscores at word edges, keep snake_case joins

  // Tidy: collapse space runs and the ", ," a stripped table can leave.
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/(, )+,?/g, ", ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
