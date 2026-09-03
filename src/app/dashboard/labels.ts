// The Library's shared message type and its two label helpers — in a module
// with NO "use client" directive, and that absence is the entire point.
//
// These used to live in content-cell.tsx, which is a Client Component. A
// Client Component module can be IMPORTED by a Server Component, but every one
// of its exports arrives on the server as a client reference: it can be
// rendered as a component or handed down as a prop, and nothing else. Calling
// one is a runtime throw — "Attempted to call statusLabel() from the server but
// statusLabel is on the client." That is exactly what the dashboard page did,
// in the "Other lessons" block, for any generation with no book and a status
// other than "done".
//
// It hid for weeks because that block only renders ORPHANS — generations whose
// book has been deleted (generations.book_id is ON DELETE SET NULL) — and only
// calls statusLabel for the ones still queued, processing or errored. The first
// reader to combine both was the founder, on 2026-09-03, deleting every book on
// a shelf that still carried a kit which had failed on a Vertex 429 three weeks
// earlier. The page then failed on every load until this landed.
//
// Both helpers are pure lookups on the dictionary. They belong here; the cell
// that renders them does not. src/__tests__/server-client-boundary.test.ts
// keeps the next helper from drifting back.

import type { Dictionary } from "@/i18n/dictionaries";

/** The Library's messages, plus the two shared groups its cells reach for. The
 * import above is type-only, so the server-only dictionaries module is erased
 * from every client bundle that names this type. */
export type LibraryMessages = Dictionary["library"] & {
  common: Dictionary["common"];
  utils: Dictionary["utils"];
};

/** A generation's raw DB status word ("queued", "processing", …) in the reader's
 * language; an unknown status shows as itself rather than blank. */
export const statusLabel = (t: LibraryMessages, status: string): string =>
  (t.status as Record<string, string>)[status] ?? status;

/** A generation kind ("presentation", "exam_paper", …) as its display name. The
 * message keys ARE the kind strings, so the DB value indexes the dictionary
 * directly and no kind → label map has to be kept in sync anywhere. */
export const kindLabel = (t: LibraryMessages, kind: string): string =>
  (t.kinds as Record<string, string>)[kind] ?? kind;
