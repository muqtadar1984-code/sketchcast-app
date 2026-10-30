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
