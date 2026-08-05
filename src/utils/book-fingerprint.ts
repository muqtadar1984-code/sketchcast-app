import { canonicalSubjectWord } from "./school-books";

// Spotting a book the school already has, BEFORE anyone pays to index it.
//
// The shelf alone saves nothing: a teacher holding a PDF uploads it unless
// something says "your school already has this". Indexing is the expensive
// step — Docling OCR, figure detection, a full Claude pass — so the whole
// point of the repository is catching the duplicate at the picker, not
// discovering it afterwards.
//
// Two signals, because two different duplicates exist:
//   · the publisher's soft copy circulated among staff  → byte-identical
//   · two teachers SCANNING the same physical book      → never byte-identical
// The fingerprint catches the first with certainty; the title comparison
// catches the second, which is the one that actually costs money twice.

/** SHA-256 over the file's size plus its first and last 2 MB.
 *
 *  NOT a whole-file digest, deliberately. Hashing 200 MB (the bucket's limit)
 *  means holding it all in memory and several seconds of main-thread work —
 *  on the mid-range Android phones the page scanner exists for, that reads as
 *  a freeze. Size + both ends is decisive for the case that matters: two
 *  copies of one publisher PDF match, and two different books essentially
 *  never do. It only has to be good enough to raise a QUESTION — the answer is
 *  always the teacher's.
 *
 *  Small files are covered completely, since the two slices overlap.
 */
export async function fingerprintFile(file: File): Promise<string> {
  const EDGE = 2 * 1024 * 1024;
  const head = await file.slice(0, EDGE).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - EDGE)).arrayBuffer();
  const sizeBytes = new TextEncoder().encode(`${file.size}:`);

  const buf = new Uint8Array(sizeBytes.length + head.byteLength + tail.byteLength);
  buf.set(sizeBytes, 0);
  buf.set(new Uint8Array(head), sizeBytes.length);
  buf.set(new Uint8Array(tail), sizeBytes.length + head.byteLength);

  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The comparable core of a book title.
 *
 *  Real filenames are noisy — "Form 1 Science (2nd Edition) FINAL_v2.pdf",
 *  "1015966800 As English General Paper Textbook". Strip the punctuation, the
 *  edition and copy markers, and any long digit run (ISBNs and scanner ids),
 *  so two teachers naming the same book differently still collide.
 */
export function titleCore(raw: string | null | undefined): string {
  return (
    (raw ?? "")
      .toLowerCase()
      .replace(/\.(pdf|docx?)$/i, "")
      // Underscores are separators, not letters. Without this, \b never fires
      // inside "FINAL_v2" and the noise words survive.
      .replace(/_+/g, " ")
      .replace(/\b\d{5,}\b/g, " ") // ISBNs, scanner ids
      .replace(/\b\d+(st|nd|rd|th)\s+edition\b/g, " ")
      .replace(/\bedition\b/g, " ")
      // ONLY the v-prefixed form. A bare number is never noise here — it is
      // the grade, and it is the single most discriminating token in the
      // title. Stripping it made "Form 1 Science" and "Form 5 Science" the
      // same book.
      .replace(/\bv\d+(\.\d+)*\b/g, " ")
      .replace(/\b(final|copy|scan|scanned|draft)\b/g, " ")
      .replace(/[^a-z0-9؀-ۿऀ-ॿఀ-౿ ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Do these two titles plausibly name the same book?
 *
 * Deliberately conservative. A false "you already have this" is worse than a
 * duplicate row: it tells a teacher their book is on the shelf when it is not,
 * and they stop looking. So this demands a real overlap of meaningful words,
 * not a shared "science".
 */
export function titlesLookSame(a: string | null | undefined, b: string | null | undefined): boolean {
  const A = titleCore(a);
  const B = titleCore(b);
  if (!A || !B) return false;
  if (A === B) return true;

  // Word overlap, ignoring one- and two-letter noise — but NEVER a bare
  // number. "1" and "5" are the whole difference between Form 1 Science and
  // Form 5 Science, and a length filter would throw both away.
  //
  // Subject words are folded to one vocabulary first, so Maths/Mathematics and
  // Sains/Science stop reading as different books. Verified against the real
  // library: this is what connects "Cambridge Maths 5 Learner Book" to
  // "Cambridge Primary Mathematics Learner's Book 5".
  const words = (s: string) =>
    new Set(
      s
        .split(" ")
        .filter((w) => w.length > 2 || /^\d+$/.test(w))
        .map((w) => canonicalSubjectWord(w) || w),
    );
  const wa = words(A);
  const wb = words(B);
  if (wa.size < 2 || wb.size < 2) return false; // too thin to judge

  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  // Every meaningful word of the shorter title must appear in the longer one.
  // "Form 1 Science" vs "Form 1 Science Learner's Book" matches;
  // "Form 1 Science" vs "Form 1 History" does not.
  return shared === Math.min(wa.size, wb.size) && shared >= 2;
}
