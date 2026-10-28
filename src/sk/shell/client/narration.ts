// SK-narrated onboarding (Final Plan 2026-10-28 §4.6): "SK introduces itself
// in one sentence, narrates the existing role tour steps (the same anchors
// data-tour=…), and offers the first task."
//
// Two pure pieces:
//   skIntroScript() — the ordered LINES: one intro sentence, each tour step's
//     body in the tour's own order (the words come from app.tour.<key>.<step>
//     so a Jawi teacher hears Jawi), then the first-task offer.
//   runNarration() — speaks the lines one at a time through an injected
//     speaker, reporting each line as it starts so the panel can write it to
//     the transcript, and stops at once when the signal aborts (Skip, Stop,
//     close). Returns how far it got, so the caller records completed vs
//     skipped exactly once.
//
// S0 deliberately narrates WITHOUT driving driver.js highlights: the lines
// land in the transcript and the voice, the spotlight stays with the existing
// TourProvider. Imports only the DATA side of the tour (definitions/logic),
// never TourProvider, so this stays importable from a node test.

import { tourForRole, type TourCopy } from "@/tour/definitions";

/** The copy the script needs from `sk.shell` — kept as a Pick so the panel can
 * hand over the whole slice and a test can pass two strings. */
export type IntroCopy = { introHello: string; introFirstTask: string };

export type IntroScriptInput = {
  copy: IntroCopy;
  tourCopy: TourCopy;
  /** The role tour's steps, already in order (tourForRole sorts them). Only
   *  `id` is read; the words come from `tourCopy`. */
  steps: ReadonlyArray<{ id: string }>;
  role: string | null | undefined;
};

export function skIntroScript(input: IntroScriptInput): string[] {
  const tourKey = tourForRole(input.role)?.key ?? "teacher_onboarding";
  const words = input.tourCopy[tourKey] ?? {};
  const lines: string[] = [];
  const hello = input.copy.introHello.trim();
  if (hello) lines.push(hello);
  for (const s of input.steps) {
    const body = words[s.id]?.body?.trim();
    if (body) lines.push(body); // a step the dictionary doesn't cover is silent, never "undefined"
  }
  const offer = input.copy.introFirstTask.trim();
  if (offer) lines.push(offer);
  return lines;
}

/** The slice of StreamSpeaker the narration uses (so a test passes a fake). */
export type NarrationSpeaker = {
  push: (text: string) => void;
  flush: () => void;
  stop: () => void;
};

export type NarrationResult = { completed: boolean; spoken: number };

export type RunNarrationOptions = {
  /** Fires as each line begins, with its index. */
  onLine?: (line: string, index: number) => void;
  signal?: AbortSignal;
  /** How long to hold a line before starting the next, so the transcript keeps
   *  pace with the voice. The default approximates speech at ~2.6 words/s;
   *  tests inject an immediate one. */
  pace?: (line: string) => Promise<void>;
};

/** ~160 wpm, with a floor so a short line is still readable, and abortable. */
export function defaultPace(signal?: AbortSignal): (line: string) => Promise<void> {
  return (line) =>
    new Promise<void>((resolve) => {
      const words = line.split(/\s+/).filter(Boolean).length;
      const ms = Math.max(1200, words * 380);
      const t = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener("abort", done);
        clearTimeout(t);
        resolve();
      }
      signal?.addEventListener("abort", done);
    });
}

export async function runNarration(
  lines: ReadonlyArray<string>,
  speaker: NarrationSpeaker,
  opts: RunNarrationOptions = {},
): Promise<NarrationResult> {
  const pace = opts.pace ?? defaultPace(opts.signal);
  let spoken = 0;
  for (let i = 0; i < lines.length; i++) {
    if (opts.signal?.aborted) break;
    const line = lines[i]!;
    opts.onLine?.(line, i);
    speaker.push(line.endsWith(".") || line.endsWith("!") || line.endsWith("?") ? `${line} ` : `${line}. `);
    speaker.flush();
    spoken++;
    await pace(line);
  }
  const completed = spoken === lines.length && !opts.signal?.aborted;
  if (!completed) speaker.stop();
  return { completed, spoken };
}
