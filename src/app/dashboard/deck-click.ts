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
// So the click asks first, with `redirect: "manual"`.
//
// THE PROBE IS NOT THE GATEKEEPER — THE ROUTE IS. The two directions of this
// decision fail in OPPOSITE ways on purpose (adversarial pass 5, 2026-09-05):
//
//   NAVIGATION is fail-OPEN. Only a clear refusal — a readable same-origin
//   status of 400 or worse — stops the student. A thrown fetch (offline for a
//   moment, an extension, a blocked request) or a response shape this code
//   did not anticipate (a runtime where `redirect: "manual"` does not filter
//   the way the spec says, an opaque response from some proxy) is NOT taken
//   as a refusal: the student is let through to the route, which re-checks
//   the share and the session server-side and refuses for real if it must.
//   A probe that guessed wrong must never be the thing that withholds a
//   student's own deck.
//
//   RECORDING is fail-CLOSED. Only a clear success — the opaque redirect that
//   proves the 302 happened, or a readable 2xx/3xx — writes "Completed" or
//   counts a revision. Everything else records NOTHING, so an unreadable
//   probe can never manufacture a completion the student did not get.
//
// The middle ground therefore exists and is deliberate: navigate, record
// nothing, say nothing. The student gets whatever the route decides; the
// progress row simply does not claim to know what that was.
//
// Pure and in its own module (no "use client") so the decision is testable:
// vitest collects no .tsx, and this is the part that must not drift.

/** The parts of a fetch Response this decision reads. */
export type DeckProbe = { type?: string; status: number };

/**
 * Did /api/deck agree to hand the deck over? — the RECORDING gate.
 *
 * With `redirect: "manual"` the browser does NOT follow the route's 302 — it
 * hands back a filtered response whose type is "opaqueredirect" and whose
 * status is 0. That opacity is the whole signal: it is unreadable EXACTLY
 * BECAUSE the redirect happened.
 *
 * 2xx counts too — the route answers 302 today, but a future version that
 * streamed the file itself would be agreeing just as much — and so does any
 * other 3xx, in case a runtime ever surfaces the redirect unfiltered. Status 0
 * WITHOUT the opaqueredirect type (an "error"/"opaque" response) is not
 * agreement: nothing there says the route was reached. Nor is it a refusal —
 * see `deckRouteRefused`.
 */
export function deckRouteAgreed(res: DeckProbe): boolean {
  if (res.type === "opaqueredirect") return true;
  return res.status >= 200 && res.status < 400;
}

/**
 * Did /api/deck clearly say no? — the NAVIGATION gate.
 *
 * This is the ONLY thing that keeps the student off the route, so it answers
 * true only for a refusal the browser actually read: a same-origin response
 * carrying a 4xx or 5xx status, which is exactly the JSON body the route
 * writes when it refuses. Anything else — an opaque redirect, an opaque or
 * error response, a status this code cannot place — is not a refusal, and a
 * thrown fetch is not one either (the caller has no response to pass and must
 * navigate anyway).
 *
 * Note it is NOT the negation of `deckRouteAgreed`: the two leave a gap on
 * purpose, and that gap navigates without recording.
 */
export function deckRouteRefused(res: DeckProbe): boolean {
  return res.status >= 400;
}
