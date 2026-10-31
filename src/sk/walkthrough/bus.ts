// "Take the tour" from anywhere (founder 2026-10-30): the header's 🧭 button
// (TourProvider, for SK users), the hero's and the panel's links, and SK's
// "Show me around" rule all ask the ONE place that runs the walkthrough — the
// SK launcher — through this window event. No import of the launcher, so the
// driver.js provider and the header stay independent of SK's client code.
// Importing this module touches no DOM; the functions do, and only when called.

export const SK_WALKTHROUGH_EVENT = "sk:walkthrough-start";

/** Ask the launcher to (re)start the walkthrough from stop 1. A replay: it
 *  never writes the seen row by itself. */
export function requestSkWalkthrough(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SK_WALKTHROUGH_EVENT));
}

/** Subscribe (the launcher); returns the unsubscribe. */
export function onSkWalkthroughRequest(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SK_WALKTHROUGH_EVENT, cb);
  return () => window.removeEventListener(SK_WALKTHROUGH_EVENT, cb);
}

// ── reveal: the tour opens what hides its control (phone layout, 2026-10-31) ──
// On a teacher's phone some controls live inside things that start closed —
// the tab bar's More sheet, a chapter's action sheet. At every stop the tour
// names the controls it is about (visible or not); each container that can
// open listens. The one holding a named control opens (or, already open,
// stays open) and says so; every other container the TOUR opened closes. So
// the sheet follows the tour stop by stop, with no close-then-reopen between
// two stops in the same sheet. `null` (the tour paused, ended or went away)
// closes everything the tour opened. A container the teacher opened herself
// is never shut by the tour. Opening only: nothing is pressed or written.

export const SK_REVEAL_EVENT = "sk:walkthrough-reveal";

/** `els`: the stop's controls (null = close what the tour opened). */
export type SkRevealDetail = { els: Element[] | null; claimed: boolean };

/** Name the stop's controls (or, with null, close what the tour opened).
 *  True when a container holds one of them. */
export function requestSkReveal(els: Element[] | null): boolean {
  if (typeof window === "undefined") return false;
  const detail: SkRevealDetail = { els, claimed: false };
  window.dispatchEvent(new CustomEvent<SkRevealDetail>(SK_REVEAL_EVENT, { detail }));
  return detail.claimed;
}

/** Subscribe (a container that can open); returns the unsubscribe. */
export function onSkReveal(cb: (detail: SkRevealDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => cb((e as CustomEvent<SkRevealDetail>).detail);
  window.addEventListener(SK_REVEAL_EVENT, h);
  return () => window.removeEventListener(SK_REVEAL_EVENT, h);
}
