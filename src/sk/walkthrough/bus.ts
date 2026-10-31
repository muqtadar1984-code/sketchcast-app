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
// the tab bar's More sheet, a chapter's action sheet. When a stop's control is
// on the page but hidden, the tour asks for it to be revealed: each container
// that can open listens, and the one that holds the control opens (and says
// so). `null` asks every container the TOUR opened to close again; one the
// teacher opened herself stays as she left it. Opening only: nothing is
// pressed, nothing is written.

export const SK_REVEAL_EVENT = "sk:walkthrough-reveal";

/** `els`: the hidden copies of one control (null = close what the tour opened). */
export type SkRevealDetail = { els: Element[] | null; claimed: boolean };

/** Ask for the container holding one of `els` to open (or, with null, for the
 *  tour's to close). True when a container took it. */
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
