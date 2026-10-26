// SK board — event-ID idempotency at the BOARD command level (plan §7,
// contracts §5). B4's `store.ts` applies the rule server-side (an event is
// unique on (sessionId, eventId) with a claim protocol, so a retried turn
// never runs the model twice). The board needs the same rule on the client,
// for the commands that reach the runtime directly: a double-clicked Pause,
// a replayed SSE `tal` event after a reconnect, a retried "ask". A repeated
// id returns the stored outcome and performs NOTHING a second time — no
// second pause, no second interrupt, no second drawing.

import { isEventId } from "../ids";

export type BoardCommandKind = "play" | "pause" | "seek" | "interrupt" | "aside" | "resume" | "erase" | "rate";
export type BoardCommand = { eventId: string; kind: BoardCommandKind; args?: Record<string, unknown> };
export type Outcome<R> = { eventId: string; kind: BoardCommandKind; duplicate: boolean; result: R };

/** Applies a command at most once per event id. `handle` runs the effect;
 * its return value (a promise included) is stored and handed back verbatim to
 * every repeat, so an awaiting caller of a replayed async command gets the
 * SAME in-flight promise, not a second effect. Memory is bounded: the oldest
 * ids fall out after `capacity`. */
export class CommandLog<R = unknown> {
  private readonly seen = new Map<string, Outcome<R>>();
  /** How many repeats were ignored — the replay measure. */
  duplicates = 0;

  constructor(private readonly capacity = 4096) {}

  apply(cmd: BoardCommand, handle: (cmd: BoardCommand) => R): Outcome<R> {
    if (!isEventId(cmd.eventId)) throw new Error(`bad eventId ${JSON.stringify(cmd.eventId)}`);
    const prior = this.seen.get(cmd.eventId);
    if (prior) {
      this.duplicates++;
      return { ...prior, duplicate: true };
    }
    const result = handle(cmd);
    const out: Outcome<R> = { eventId: cmd.eventId, kind: cmd.kind, duplicate: false, result };
    this.seen.set(cmd.eventId, out);
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.keys().next().value!);
    return out;
  }

  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  get size(): number {
    return this.seen.size;
  }
}
