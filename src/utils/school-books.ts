import { gradeLevel } from "./narration";

// Which of the school's books belong in front of THIS teacher.
//
// The shelf is shared, not assigned — the school uploads once and every teacher
// may use anything on it (founder, 2026-08-05). That decision removed a whole
// admin surface, but it left a presentation problem: a 40-teacher secondary
// school has books for every subject and every form, and a Form 1 Science
// teacher should not scroll past Form 5 Accounting to reach their own.
//
// So relevance is DERIVED, never curated. We already know what a teacher
// teaches — `classes.grade` for the classes they own and `timetable_slots.
// subject` for the periods they're timetabled — and indexing already records a
// book's grade and subject. Nobody has to maintain anything, and nothing is
// hidden: what doesn't match is one disclosure away, so being wrong costs a
// click rather than a missing book.

/** What a teacher actually teaches, gathered from their classes + timetable. */
export type TeachingProfile = {
  /** Raw grade strings from classes.grade — "Form 1", "Tingkatan 1", "5". */
  grades: string[];
  /** Raw subject strings from timetable_slots.subject. */
  subjects: string[];
};

/** The book fields relevance actually reads. */
export type ShelfBook = { grade: string | null; subject: string | null };

/** Lowercase, strip punctuation and collapse spaces, so "Science " and
 *  "science" and "Science:" are one subject. */
function normSubject(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿऀ-ॿఀ-౿ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Malaysian schools record subjects in Malay while the book on the shelf is
// often printed in English (and the reverse). Without this, a school writing
// "Sains" and a book indexed "Science" read as a CONTRADICTION and the teacher
// is shown neither — the single most likely way this feature fails quietly in
// its first market. First entry in each group is the canonical form; order
// matters, because the more specific subject must be tested first ("Matematik
// Tambahan" is not "Matematik", and Add Maths contains Maths).
const SUBJECT_SYNONYMS: string[][] = [
  ["additional mathematics", "matematik tambahan", "add maths", "add math", "addmaths"],
  ["islamic education", "pendidikan islam", "pai"],
  ["moral education", "pendidikan moral", "moral"],
  ["physical education", "pendidikan jasmani", "pjk", "pj"],
  ["design and technology", "reka bentuk dan teknologi", "rbt"],
  ["malay", "bahasa melayu", "bahasa malaysia", "bm"],
  ["english", "bahasa inggeris", "english language"],
  ["chinese", "bahasa cina", "mandarin"],
  ["tamil", "bahasa tamil"],
  ["mathematics", "matematik", "maths", "math"],
  ["science", "sains"],
  ["physics", "fizik"],
  ["chemistry", "kimia"],
  ["biology", "biologi"],
  ["history", "sejarah"],
  ["geography", "geografi"],
  ["accounting", "perakaunan"],
  ["economics", "ekonomi"],
  ["business", "perniagaan"],
  ["art", "pendidikan seni", "seni visual"],
  ["civics", "sivik"],
];

/** Fold a SINGLE token onto its canonical subject name, exact matches only.
 *
 *  Exported for title comparison (book-fingerprint), where the same vocabulary
 *  split shows up inside book titles: "Cambridge Maths 5" and "Cambridge
 *  Primary Mathematics … 5" are one book, and in Malaysian schools the pair is
 *  more often Sains/Science or Matematik/Mathematics. No containment here —
 *  a lone word carries too little context to risk it. */
export function canonicalSubjectWord(word: string): string {
  const n = normSubject(word);
  if (!n) return "";
  for (const group of SUBJECT_SYNONYMS) if (group.includes(n)) return group[0];
  return n;
}

/** Fold a subject onto its canonical name, so "Sains" and "Science" are one
 *  thing. `mapped` says whether the table recognised it, which decides below
 *  whether a looser comparison is still safe. */
function canonicalSubject(raw: string | null | undefined): { name: string; mapped: boolean } {
  const n = normSubject(raw);
  if (!n) return { name: "", mapped: false };
  for (const group of SUBJECT_SYNONYMS) {
    for (const g of group) {
      if (n === g) return { name: group[0], mapped: true };
      // Containment runs ONE WAY: the input may CONTAIN a synonym ("Cambridge
      // Primary Science" → science). The reverse would fold a shorter, more
      // general subject into a longer, more specific one — plain "Mathematics"
      // would land in the Additional Mathematics group purely because that
      // name contains it. Length-guarded so short entries like "art" can't
      // swallow "earth science".
      if (g.length >= 4 && n.length >= 4 && n.includes(g)) return { name: group[0], mapped: true };
    }
  }
  return { name: n, mapped: false };
}

// Two known subjects compare by EQUALITY — canonicalisation has already done
// the work of pulling a subject out of a longer printed title, so any remaining
// difference is a real one (Add Maths is not Maths). Containment survives only
// where neither side is in the table, which is the one case it still helps.
function subjectMatches(bookSubject: string | null, taught: string[]): boolean {
  const b = canonicalSubject(bookSubject);
  if (!b.name) return false;
  return taught.some((t) => {
    const s = canonicalSubject(t);
    if (!s.name) return false;
    if (s.name === b.name) return true;
    if (s.mapped || b.mapped) return false; // both known and different ⇒ different
    if (s.name.length < 4 || b.name.length < 4) return false;
    return b.name.includes(s.name) || s.name.includes(b.name);
  });
}

// Grades match on the NORMALISED level, not the string, so a school writing
// "Tingkatan 1" and a book printed "Form 1" are the same shelf. gradeLevel()
// already reconciles the systems (and puts Form 1 above Standard 6).
function gradeMatches(bookGrade: string | null, taught: string[]): boolean {
  const b = gradeLevel(bookGrade);
  if (b === null) return false;
  return taught.some((t) => gradeLevel(t) === b);
}

/**
 * Is this book worth putting in front of this teacher?
 *
 * A signal only counts when BOTH sides carry it — the book has the field AND we
 * know that much about the teacher. Indexing does not always recover a grade or
 * a subject, and a teacher may hold a timetable but own no classes (or the
 * reverse), so a book must never be buried for failing a test that had no data
 * on one side. Absence of evidence is not evidence against.
 *
 * The rule: no CONTRADICTED signal, and at least one POSITIVE one. A book we
 * know nothing about lands in the remainder, which is right — we cannot claim
 * it is theirs.
 */
export function isRelevant(book: ShelfBook, profile: TeachingProfile): boolean {
  const hasGrade = gradeLevel(book.grade) !== null;
  const hasSubject = normSubject(book.subject) !== "";
  if (!hasGrade && !hasSubject) return false;

  // `null` means "not testable", NOT "failed" — an empty list on the teacher's
  // side would otherwise make every book look contradicted.
  const gradeOk = hasGrade && profile.grades.length > 0 ? gradeMatches(book.grade, profile.grades) : null;
  const subjectOk = hasSubject && profile.subjects.length > 0 ? subjectMatches(book.subject, profile.subjects) : null;

  if (gradeOk === false || subjectOk === false) return false; // contradicted
  return gradeOk === true || subjectOk === true; // needs one positive
}

/**
 * Split the school shelf into what this teacher sees first and what waits
 * behind "Also in your school (N)".
 *
 * A teacher with no classes and no timetable — a brand-new joiner, the case
 * this feature exists to fix — matches nothing, and would be shown an empty
 * shelf with everything hidden behind a disclosure. That is the worst possible
 * first run, so an unknown teaching profile surfaces the WHOLE shelf instead.
 */
export function splitShelf<T extends ShelfBook>(
  books: T[],
  profile: TeachingProfile,
): { relevant: T[]; rest: T[] } {
  const knowsNothing = profile.grades.length === 0 && profile.subjects.length === 0;
  if (knowsNothing) return { relevant: books, rest: [] };

  const relevant: T[] = [];
  const rest: T[] = [];
  for (const b of books) (isRelevant(b, profile) ? relevant : rest).push(b);

  // Nothing matched, but the school HAS books. Showing an empty shelf with the
  // whole thing folded away behind a disclosure is the worst of both — and a
  // total miss is far more likely to mean thin metadata (a book indexed with no
  // grade, a subject spelled a way the table doesn't know) than a school that
  // genuinely owns nothing for this teacher. Fail open.
  if (relevant.length === 0) return { relevant: rest, rest: [] };

  return { relevant, rest };
}
