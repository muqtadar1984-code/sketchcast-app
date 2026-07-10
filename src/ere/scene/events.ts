// The event model (design §6): an ordered, APPEND-ONLY log. The scene graph is
// the fold of this log — replay, undo and deterministic reproduction of any
// board state come for free, and student mastery is later DERIVED from the
// stream. Student events only fire in Phase 2+, but the channel is defined now.

export type BoardActor = "tutor" | "student" | "system";

export type BoardEventType =
  | "object.placed"
  | "object.drawn"
  | "object.removed"
  | "object.moved"
  | "relation.added" // arrow / connect
  | "label.added"
  | "group.created"
  | "state.set"
  | "step.applied"
  | "highlight" // transient emphasis — recorded, not persisted in the graph
  | "focus"
  | "annotation.added"
  | "narration.spoken" // system event carrying timing
  // Student deixis + annotation channel (Phase 2). The student REFERS TO and marks
  // up objects; they never mutate tutor objects (that stays with TAL). These feed
  // the tutor's perception via readBack; student.annotate additionally persists a
  // student-owned note in a separate layer.
  | "student.select" // tap/click an object or part → "tell me about this"
  | "student.point" // deictic hover-hold focus for the next question
  | "student.circle" // lasso a region → "explain what I've circled"
  | "student.annotate" // student's own sticky note / mark anchored to a target
  | "student.answer" // student's reply to a tutor `ask`
  | "student.drag"; // reserved for Phase 3 manipulation (declared, not used)

export type BoardEvent = {
  id: string;
  seq: number;
  ts: number; // session-clock seconds (deterministic, from the schedule)
  scene: string;
  actor: BoardActor;
  type: BoardEventType;
  target?: string;
  payload?: Record<string, unknown>;
  cause?: string; // the TAL action id or a prior event id
};

/** Append-only log with a monotonic sequence. `base` lets a RESUMED session keep
 * numbering after the events already persisted in the DB — this in-memory log
 * then holds only the NEW events of the current session. */
export class EventLog {
  private events: BoardEvent[] = [];
  constructor(
    readonly scene: string,
    private readonly base = 0,
  ) {}

  /** The next absolute sequence number. */
  get seq(): number {
    return this.base + this.events.length;
  }

  append(e: Omit<BoardEvent, "id" | "seq" | "scene">): BoardEvent {
    const seq = this.base + this.events.length;
    const event: BoardEvent = { ...e, id: `ev_${seq}`, seq, scene: this.scene };
    this.events.push(event);
    return event;
  }

  all(): readonly BoardEvent[] {
    return this.events;
  }

  /** Events with absolute seq < `seq` — the substrate for undo/replay. */
  upTo(seq: number): readonly BoardEvent[] {
    return this.events.filter((e) => e.seq < seq);
  }

  since(seq: number): readonly BoardEvent[] {
    return this.events.filter((e) => e.seq >= seq);
  }
}
