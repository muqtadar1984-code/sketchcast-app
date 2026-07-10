// Narration-first scheduling (design §2.5). Deterministic three-step flow:
//   (1) synthesise every `speak` → real duration + word timings,
//   (2) resolve every `sync` to an ABSOLUTE time on the session clock,
//   (3) hand renderers a fixed timeline. TTS variability is absorbed in (1),
// so the board and the voice can never drift.

import type { SpeakOp, Sync, TalAction } from "../tal/types";

/** Anything that can voice a narration unit and report its timing. */
export interface Narrator {
  narrate(text: string, voice?: string): Promise<{ duration: number; wordTimings: number[] }>;
}

/** Deterministic no-audio narrator for headless tests and dry runs. */
export class StubNarrator implements Narrator {
  constructor(private readonly secPerWord = 0.32) {}
  async narrate(text: string): Promise<{ duration: number; wordTimings: number[] }> {
    const words = text.split(/\s+/).filter(Boolean);
    const wordTimings = words.map((_, i) => i * this.secPerWord);
    return { duration: Math.max(0.5, words.length * this.secPerWord), wordTimings };
  }
}

export type ScheduledAction = {
  action: TalAction;
  index: number;
  start: number; // absolute session-clock seconds
  end: number;
  narration?: { duration: number; wordTimings: number[] };
};

/** Per-action nominal durations (seconds). Draw duration scales with part count. */
export function nominalDuration(action: TalAction, drawParts = 1): number {
  switch (action.op) {
    case "pause":
      return action.seconds;
    case "draw":
      return Math.max(0.8, drawParts * 0.35);
    case "set_state":
    case "step":
    case "move":
      return 1.0;
    case "remove":
      return 0.6;
    case "arrow":
    case "connect":
    case "label":
    case "annotate":
      return 0.5;
    case "highlight":
    case "focus":
      return 0.4;
    default:
      return 0; // place/group/ask/expect/on_event/wait_for_student are instantaneous in Phase 1
  }
}

/**
 * Build the absolute timeline. Rules (deterministic):
 *  - the cursor starts at 0; actions without `sync` fire at the cursor;
 *  - `sync.with` binds to a speak unit's start/end/word:N;
 *  - `sync.after` binds to another action's end (+ delay);
 *  - every action advances the cursor to max(cursor, its end) — narration
 *    drives the clock, visuals ride alongside it.
 */
export async function schedule(
  actions: TalAction[],
  narrator: Narrator,
  drawPartsOf: (target: string) => number = () => 1,
): Promise<ScheduledAction[]> {
  // (1) synthesise all speak units first
  const narrations = new Map<string, { duration: number; wordTimings: number[] }>();
  for (const a of actions) {
    if (a.op === "speak") narrations.set(a.id, await narrator.narrate(a.text, (a as SpeakOp).voice));
  }

  // (2)+(3) resolve syncs and lay out the timeline
  const out: ScheduledAction[] = [];
  const speakSpans = new Map<string, { start: number; end: number; wordTimings: number[] }>();
  const byActionId = new Map<string, ScheduledAction>();
  let cursor = 0;

  const resolveSync = (sync: Sync): number => {
    if ("with" in sync) {
      const span = speakSpans.get(sync.with);
      if (!span) return cursor; // validator guarantees existence; guard anyway
      if (!sync.at || sync.at === "start") return span.start;
      if (sync.at === "end") return span.end;
      const word = Number(sync.at.slice(5));
      return span.start + (span.wordTimings[Math.max(0, word - 1)] ?? 0);
    }
    const anchor = byActionId.get(sync.after);
    return (anchor?.end ?? cursor) + (sync.delay ?? 0);
  };

  actions.forEach((action, index) => {
    const sync = (action as { sync?: Sync }).sync;
    const narration = action.op === "speak" ? narrations.get(action.id) : undefined;
    const duration =
      action.op === "speak"
        ? (narration?.duration ?? 0)
        : nominalDuration(action, "target" in action && typeof action.target === "string" ? drawPartsOf(action.target) : 1);
    const start = sync ? resolveSync(sync) : cursor;
    const end = start + duration;
    const scheduled: ScheduledAction = { action, index, start, end, narration };
    out.push(scheduled);
    if (action.op === "speak") speakSpans.set(action.id, { start, end, wordTimings: narration?.wordTimings ?? [] });
    const id = (action as { id?: string }).id;
    if (id) byActionId.set(id, scheduled);
    cursor = Math.max(cursor, end);
  });

  return out;
}
