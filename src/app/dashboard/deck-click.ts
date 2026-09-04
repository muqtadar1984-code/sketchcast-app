// The student's deck click, decided before anything is recorded.
//
// WHY THERE IS A PROBE AT ALL. The row's href is /api/deck/{genId} (a route,
// not a signed URL — see ../api/deck/logic.ts for why), and that route can
// refuse: 401 when the session went away, 403 when the teacher unassigned the
// deck between the render and the click, 404 when the generation carries no
// deck file, 500/502 when the service role or the signing is unavailable. All
// of those are JSON. Followed by a plain anchor, a refusal reached the student
// as a DOWNLOADED FILE full of `{"error":…}` with nothing on the screen to
// say so — and the row had already written "Completed", because the click was
// the only thing it waited for. A second try then counted as a REVISION.
//
// So the click asks first, with `redirect: "manual"`, and only a route that
// agreed lets the row record anything.
//
// Pure and in its own module (no "use client") so the decision is testable:
// vitest collects no .tsx, and this is the part that must not drift.

/** The parts of a fetch Response this decision reads. */
export type DeckProbe = { type?: string; status: number };

/**
 * Did /api/deck agree to hand the deck over?
 *
 * With `redirect: "manual"` the browser does NOT follow the route's 302 — it
 * hands back a filtered response whose type is "opaqueredirect" and whose
 * status is 0. That opacity is the whole signal: it is unreadable EXACTLY
 * BECAUSE the redirect happened. A refusal, by contrast, is an ordinary
 * same-origin JSON response with a readable status, and a network failure is
 * a thrown TypeError the caller catches.
 *
 * 2xx counts too — the route answers 302 today, but a future version that
 * streamed the file itself would be agreeing just as much — and so does any
 * other 3xx, in case a runtime ever surfaces the redirect unfiltered. Status 0
 * WITHOUT the opaqueredirect type (a "error"/"opaque" response) is not
 * agreement: nothing there says the route was reached.
 */
export function deckRouteAgreed(res: DeckProbe): boolean {
  if (res.type === "opaqueredirect") return true;
  return res.status >= 200 && res.status < 400;
}
