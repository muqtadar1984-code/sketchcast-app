// SK leads the student through her kit (learner mode, SK student Board plan
// 2026-10-31, phase 1): "Let's start with the video…", then the slides, then
// the worksheet. PURE — what the next step is and what SK says about it — so
// the order is tested without a Board; present-client performs the steps
// through the same paths the rail and SK's own moves use.
//
// A step the kit does not have is skipped (a kit with no video starts at the
// slides; one with no deck goes from the video to the worksheet). The student
// can always ask SK anything in between — the coach only says what comes next.

export type CoachStep = "video" | "slides" | "worksheet" | "done";
export type CoachAvail = { video: boolean; slides: boolean; worksheet: boolean };

const ORDER: CoachStep[] = ["video", "slides", "worksheet", "done"];

const has = (s: CoachStep, a: CoachAvail): boolean => s === "done" || a[s];

/** Where the lesson starts: the first step the kit has. */
export function firstStep(a: CoachAvail): CoachStep {
  return ORDER.find((s) => has(s, a)) ?? "done";
}

/** The step after `s` that the kit has ("done" at the end). */
export function nextStep(s: CoachStep, a: CoachAvail): CoachStep {
  const i = ORDER.indexOf(s);
  return ORDER.slice(i + 1).find((x) => has(x, a)) ?? "done";
}

/** The coach's words, as the dictionary carries them (present.learn.sk). */
export type CoachLines = {
  startVideo: string;
  startSlides: string;
  startWorksheet: string;
  toSlides: string;
  toWorksheet: string;
  slidesOpen: string;
  slidesMissing: string;
  worksheetOpen: string;
  worksheetFailed: string;
  done: string;
  empty: string;
};

/** What SK says when the lesson opens at `step`. */
export function openingLine(step: CoachStep, l: CoachLines): string {
  return step === "video" ? l.startVideo : step === "slides" ? l.startSlides : step === "worksheet" ? l.startWorksheet : l.empty;
}

/** What SK says on moving ON to `step` (after the previous one). */
export function nextLine(step: CoachStep, l: CoachLines): string {
  return step === "slides" ? l.toSlides : step === "worksheet" ? l.toWorksheet : step === "done" ? l.done : l.startVideo;
}
