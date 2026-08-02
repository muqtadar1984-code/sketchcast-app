// Presentational cleanup for a book title. Uploaded PDFs often carry junk filenames
// (e.g. "pdfcoffee.com_cambridge-maths-5-learner-book-pdf-free"); when no human title was
// given, that filename ends up as the title. This turns a filename/slug into something
// readable WITHOUT touching a title a human (or the indexer) actually wrote — a real title
// has spaces and no download-site cruft, so we leave it alone.

import type { Dictionary } from "@/i18n/dictionaries";

// The ONE word this file invents (everything else is the teacher's own title,
// tidied): the placeholder for a book with no usable name. Passed in rather than
// hardcoded so it reads in the same language as the row around it. The type-only
// Dictionary import is erased at build time — the server-only module never
// reaches the browser bundle.
export type BookMessages = Dictionary["utils"]["book"];

const EN: BookMessages = { untitled: "Untitled book" };

const JUNK_TAIL = /[\s._-]*(pdf[\s._-]*free|free[\s._-]*pdf|ebook|pdf|free|download)\s*$/i;
const DOMAIN_HEAD = /^[a-z0-9-]+\.(?:com|net|org|pub|io|in|co|info|xyz)[._-]+/i;

/** True when the string looks like a filename/slug rather than a written title. */
function looksLikeFilename(s: string): boolean {
  return (
    !/\s/.test(s) || // no spaces at all → almost certainly a slug/filename
    /\.pdf$/i.test(s) ||
    DOMAIN_HEAD.test(s) ||
    /[\s._-](pdf|free)[\s._-]*(free|pdf)?\s*$/i.test(s)
  );
}

export function cleanBookTitle(raw: string | null | undefined, t: BookMessages = EN): string {
  const s = (raw ?? "").trim();
  if (!s) return t.untitled;
  if (!looksLikeFilename(s)) return s; // already a human/indexer title — don't touch it

  let cleaned = s.replace(/\.pdf$/i, "").replace(DOMAIN_HEAD, "");
  // Strip a couple of trailing junk tokens (…-pdf-free, …-free).
  cleaned = cleaned.replace(JUNK_TAIL, "").replace(JUNK_TAIL, "");
  cleaned = cleaned.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return t.untitled;
  // Title-case a slug so it reads like a title (leave digits as-is).
  cleaned = cleaned.replace(/\b([a-z])/gi, (_m, c: string) => c.toUpperCase());
  return cleaned;
}
