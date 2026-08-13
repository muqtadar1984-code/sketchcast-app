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
  facts?: { doc_type?: string | null } | null;
  problems?: string[] | null;
} | null;

/** Dictionary keys under gate.docType — the worker's doc_type vocabulary.
 *  Anything unrecognized (or missing) reads as "other". */
export type DocTypeKey = "administrative" | "form_or_roster" | "other";

const DOC_TYPE_KEYS: readonly DocTypeKey[] = ["administrative", "form_or_roster", "other"];

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
