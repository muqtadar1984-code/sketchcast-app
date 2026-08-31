// Where a lesson's files live in the artifacts bucket.
//
// THE PATH IS THE AUTHORIZATION, which is why it is derived and never accepted.
// The artifacts bucket carries one storage policy —
// `(storage.foldername(name))[1] = auth.uid()::text` — so a teacher's own
// browser session may write anywhere under her own uid folder and nowhere else.
// That is what lets the board upload its PDF and its frozen frames directly,
// with no server round trip for the bytes and no signed-upload dance.
//
// It also means a client-supplied path would be a client-supplied claim. The
// server never takes one: it recomputes the path from the session row it just
// authorised (teacher_id + session id) and compares, or simply uses its own.
// A caller who wanted to point pdf_path at somebody else's object would have to
// change a uuid it does not control.
//
// Pure and shared: the browser builds the path it uploads to, the routes build
// the path they sign, and the two agree by construction rather than by protocol.

/** The exported roll. One per session, overwritten rather than versioned:
 *  re-exporting an unchanged board produces byte-identical output (see
 *  board/export-pdf.ts), so upsert is idempotent rather than destructive. */
export const rollPdfPath = (teacherId: string, sessionId: string): string =>
  `${teacherId}/present/${sessionId}/board.pdf`;

/**
 * A frozen video frame, numbered by the page it landed on.
 *
 * Keyed on the PAGE INDEX rather than a capture counter, because that is what
 * makes it stable: freeze twice onto page 4 and the second capture replaces the
 * first, which is exactly what the roll shows. A counter would leave the first
 * one orphaned in the bucket with nothing pointing at it.
 */
export const framePath = (teacherId: string, sessionId: string, pageIndex: number): string =>
  `${teacherId}/present/${sessionId}/frame-${pageIndex}.jpg`;

/** Everything a session owns, for a delete that leaves nothing behind. */
export const sessionFolder = (teacherId: string, sessionId: string): string =>
  `${teacherId}/present/${sessionId}`;

/**
 * Is this a path this session is allowed to own?
 *
 * Used on the server side of the upload confirmation. Not a security boundary
 * on its own — the storage policy is — but it turns "the client sent something
 * odd" into a 400 rather than a row pointing at an object that will never exist.
 */
export function ownsPath(teacherId: string, sessionId: string, path: string): boolean {
  const prefix = `${sessionFolder(teacherId, sessionId)}/`;
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  // A name, not a subfolder and not nothing: a trailing slash is a directory
  // and there is no such object to sign.
  return !!name && !name.includes("/");
}
