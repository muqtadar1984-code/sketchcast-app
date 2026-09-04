// The student's deck download — the pure decision behind /api/deck/{genId}.
//
// WHY A ROUTE AND NOT A SIGNED URL. Until 2026-09-04 the student dashboard
// signed the deck's .pptx for an hour at render and put that URL straight in
// the row's href. The row then had to guess, on the client, whether its own
// link was still alive before letting the click record the item complete —
// and a client-router restore (back/forward, or any remount from the bfcache
// of Next's own router cache) handed the row the CACHED hour-old URL together
// with a FRESH mount clock. The age check reset to zero, the expired link
// passed, the row wrote "Completed", and the download failed at storage. No
// client-side check can close that: the row cannot tell a URL it just
// received from one it has been holding since breakfast.
//
// So the client holds no signed URL at all. The row links here, and the URL
// is minted at CLICK time, after the share is re-checked, with a lifetime
// (DECK_URL_TTL_SECONDS) short enough that it cannot go stale between the
// redirect and the fetch that follows it. Expiry stops being a thing the
// browser reasons about. It is the same move /api/quiz/{generationId} made
// for questions.json, for a different reason.
//
// PURE-ish: the store is injected, exactly like the quiz's loadPaperWith, so
// the permission decision and the artifact selection are testable without a
// database, a session or a network.

import { isAssignedToStudent, type QuizDb } from "../quiz/logic";

/** The store this needs: the same read surface the quiz's share check uses,
 * plus the artifacts table. Nothing writes. */
export type DeckStore = QuizDb;

/** How long the signed URL lives. Five minutes: minted on the click, followed
 * at once, and then it has to survive the DOWNLOAD ITSELF.
 *
 * The first cut said sixty seconds, on the reasoning that the URL only had to
 * carry one redirect into the download manager. It has to carry more than
 * that: a deck is tens of megabytes, a school connection is shared by a class
 * of thirty, and a transfer interrupted at minute two cannot be resumed once
 * the token is dead — the browser retries the same expired URL and the student
 * is left with a part-file and no way back except a page reload. Five minutes
 * is still nothing like the HOUR the dashboard used to sign for, and that hour
 * was dangerous for a different reason entirely: it was a lifetime the link
 * spent sitting in a rendered page, which is the thing this route removes.
 * Nothing here is held anywhere — it is minted per click, behind the share
 * check, and never cached. */
export const DECK_URL_TTL_SECONDS = 300;

/** The name the file saves as. Baked into the signed URL as a
 * Content-Disposition, which is what keeps the click a DOWNLOAD: without it
 * iOS Safari opens a .pptx inline in the same tab (Quick Look) and unloads
 * the dashboard while the row is still recording the download. Pinned against
 * docDownloadName("deck", "deck_pptx") in the tests so the two cannot drift. */
export const DECK_FILENAME = "Deck.pptx";

export type DeckFailure = { ok: false; status: number; error: string };
export type DeckResult = { ok: true; path: string; filename: string } | DeckFailure;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Multi-part artifact ordering, the same rule the dashboard uses: NOT a path
 * sort (ICU puts "." after "_", so deck.pptx would sort behind
 * deck_part2.pptx), and no suffix means Part 1. A deck-kind generation
 * carries exactly one .pptx today; ordering costs nothing and means a future
 * multi-part deck hands over Part 1 rather than whichever row came back
 * first. */
const partNum = (path: string): number => {
  const m = /_part(\d+)\.[a-z0-9]+$/i.exec(path);
  return m ? Number(m[1]) : 1;
};

/** ARTIFACT SELECTION. The deck file among a generation's artifacts, or null
 * when it carries none. Only 'deck_pptx' is ever eligible: this route must
 * never become a way to fetch a docx (which for a legacy generation still
 * carries the answer key) or a questions_json (which IS the marking scheme)
 * by naming its generation. Built by filtering FOR the one kind, never by
 * excluding kinds — a new artifact kind the worker writes tomorrow is dropped
 * by construction. */
export function pickDeckPath(
  artifacts: ReadonlyArray<{ kind?: unknown; storage_path?: unknown }> | null | undefined,
): string | null {
  const paths = (artifacts ?? [])
    .filter((a) => a.kind === "deck_pptx")
    .map((a) => a.storage_path)
    .filter((p): p is string => typeof p === "string" && !!p)
    .sort((a, b) => partNum(a) - partNum(b));
  return paths[0] ?? null;
}

/** PERMISSION DECISION. May this student have this generation's deck, and
 * which file is it?
 *
 * The share check is `isAssignedToStudent` — the quiz route's, unchanged and
 * not re-implemented: a DIRECT share carrying the student_id (parent portal /
 * homeschool) or a share to a CLASS the student is enrolled in, mirroring the
 * two live RLS read paths on generation_shares. The caller has already proved
 * WHO the student is from the session; the id is never taken from the request.
 *
 * The order matters. The id is validated before anything is read, and the
 * share before the artifacts, so a caller who merely knows a generation id
 * learns nothing about whether it exists: an unassigned generation and one
 * that was never built answer with the same 403/404 they would anyway, and no
 * storage path is looked up on a doomed request. */
export async function resolveDeckWith(store: DeckStore, studentId: string, generationId: string): Promise<DeckResult> {
  if (!UUID.test(generationId)) return { ok: false, status: 404, error: "No such deck." };
  if (!(await isAssignedToStudent(store, studentId, generationId)))
    return { ok: false, status: 403, error: "This deck isn't assigned to you." };

  const { data: arts } = await store.from("artifacts").select("kind, storage_path").eq("generation_id", generationId);
  const path = pickDeckPath(arts);
  if (!path) return { ok: false, status: 404, error: "No such deck." };
  return { ok: true, path, filename: DECK_FILENAME };
}
