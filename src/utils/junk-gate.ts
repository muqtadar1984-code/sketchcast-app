// Junk-upload gate (soft confirm ONLY — founder decision). The WORKER decides
// whether an upload looks like a textbook and stamps books.health.gate =
// "confirm" | "none" at index time, along with health.facts.doc_type and
// human-readable health.problems[] sentences. The app never re-derives the
// rule: it reads health.gate and nothing else, so the worker can tune the
// heuristic without an app deploy. Absent health, or an absent gate key
// (every book indexed before the gate existed), means "none" — old books
// behave exactly as before.
//
// Nothing is ever hard-blocked: a gated book shows a caution note on its row
// and a confirm dialog when a generation starts; confirming proceeds. The
// confirmation is RECORDED — stampConfirmation() merges a junk_gate marker
// into the params of every generation row that insert queues, so support and
// the console can see the teacher was warned before their credits were spent.

/** The slice of books.health this gate reads. Structural on purpose: the full
 *  BookHealth shape lives with its badge (book-health-badge.tsx), and these
 *  helpers must stay importable from plain utils and tests. */
export type GateHealth = {
  gate?: string | null;
  facts?: {
    doc_type?: string | null;
    /** Stamped unconditionally by the worker since 2026-08-23: the
     *  chapter-list OUTCOME verdict (agent1_ingestion/chapter_quality),
     *  independent of which detection rung won. Absent on older books. */
    chapter_quality?: { suspect?: boolean | null } | null;
    /** The worker's own answer to "did this gate because the MAP is wrong,
     *  rather than because the DOCUMENT is junk?" — strictly broader than
     *  chapter_quality.suspect, which three structure arms leave False (one
     *  whole-book unit, an oversized unmapped tail, repeated relocation
     *  suspicion). Absent on rows indexed before 2026-08-24. */
    structure_problem?: boolean | null;
  } | null;
  problems?: string[] | null;
} | null;

/** Dictionary keys under gate.docType — the worker's doc_type vocabulary.
 *  Anything unrecognized (or missing) reads as "other".
 *
 *  "textbook" joined 2026-08-23 (Sara Junaidi's book): the worker now gates a
 *  GENUINE textbook whose CHAPTER MAP is suspect (junk bookmark titles, a
 *  mid-book hole, unrepairable boundaries), and the old collapse-to-"other"
 *  rendered "Unrecognized document" over a real Cambridge science book — the
 *  wrong claim on a trust-critical dialog. A gated textbook gets its own
 *  header label; whether the dialog/banner use the structure-problem copy is
 *  a SEPARATE question answered by the worker's stamped verdict (see
 *  isStructureGate), so workbook/notes/exam_material/"unknown" books with a
 *  suspect map get accurate structure framing too — only their header label
 *  still collapses to "other" (four more strings weren't worth the
 *  translation debt yet). */
export type DocTypeKey = "administrative" | "form_or_roster" | "textbook" | "other";

const DOC_TYPE_KEYS: readonly DocTypeKey[] = ["administrative", "form_or_roster", "textbook", "other"];

/** Should the gate render its STRUCTURE-problem copy ("check this book's
 *  chapters") instead of the junk-material copy ("doesn't look like a
 *  textbook")? Driven by the worker's actual verdict —
 *  facts.chapter_quality.suspect — never inferred from the doc-type label:
 *  keying on doc_type === "textbook" gave a 2-page textbook gated by the
 *  VOLUME rule chapter-problem copy contradicting its quoted reason, and a
 *  book indexed during a classifier outage (doc_type "unknown") the old
 *  "Unrecognized document" claim over a correct chapter-quality sentence.
 *  The two junk-MATERIAL categories keep their own framing even when the map
 *  is also suspect — "this is a form/roster" is the more diagnostic claim. */
export function isStructureGate(health: GateHealth | undefined): boolean {
  // facts.structure_problem is the worker's whole answer and is checked FIRST.
  // Keying on chapter_quality.suspect ALONE was wrong: three of the worker's
  // structure arms — one whole-book unit, an unmapped tail over 25%, two or
  // more relocation suspicions — gate without setting `suspect`, so a genuine
  // textbook with a broken map read "Doesn't look like a textbook". Two
  // reviewers hit it independently on a real 339-page Cambridge scan
  // (2026-08-24). `suspect` stays as the FALLBACK, not as the test: rows
  // indexed before that date carry no structure_problem key at all, and for
  // them a true `suspect` is still the best evidence available.
  const facts = health?.facts;
  const structural = facts?.structure_problem === true || facts?.chapter_quality?.suspect === true;
  if (!structural) return false;
  const dt = docTypeKey(health);
  return dt !== "administrative" && dt !== "form_or_roster";
}

/** Does this book need the confirm step? ONLY an explicit "confirm" gates —
 *  absent health, an absent gate key, "none", or any unknown value all mean
 *  the book behaves exactly as today. */
export function isGated(health: GateHealth | undefined): boolean {
  return health?.gate === "confirm";
}

/** The worker's own words for WHY — health.problems[] sentences, quoted as-is
 *  in the dialog (worker-produced English, untranslated by design). */
export function gateReasons(health: GateHealth | undefined): string[] {
  return (health?.problems ?? []).filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
}

/** health.facts.doc_type as a dictionary key for the doc-type label. */
export function docTypeKey(health: GateHealth | undefined): DocTypeKey {
  const dt = health?.facts?.doc_type;
  return DOC_TYPE_KEYS.includes(dt as DocTypeKey) ? (dt as DocTypeKey) : "other";
}

/** The record of the confirmation, merged into a generation row's params at
 *  insert time (params is jsonb — no migration). Never clobbers existing keys;
 *  a null/absent params becomes just the marker. */
export function stampConfirmation(
  params: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return { ...(params ?? {}), junk_gate: { confirmed_at: new Date().toISOString() } };
}
