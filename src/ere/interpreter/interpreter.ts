// The interpreter — right of the TAL seam, fully deterministic (design §1).
// Validates a TAL program, schedules it against narration, then applies it to
// the PERSISTENT scene graph by EMITTING EVENTS and folding them — the live
// graph and a replay of the log go through the exact same code path, so they
// can never disagree. Never executes a partially-valid program.

import { validateTal, type ValidationError } from "../tal/validate";
import type { TalAction, TalProgram } from "../tal/types";
import type { LogicalPos, SceneNode } from "../scene/types";
import { SceneGraph, type SceneGraphSnapshot } from "../scene/graph";
import { EventLog, type BoardEvent } from "../scene/events";
import { Library } from "../ko/library";
import { schedule, type Narrator, type ScheduledAction } from "./schedule";

export type TurnResult =
  | { ok: false; errors: ValidationError[] }
  | { ok: true; events: BoardEvent[]; schedule: ScheduledAction[]; readBack: Record<string, unknown> };

/** One persistent board session: graph + log + library, fed TAL turn by turn. */
export class BoardSession {
  readonly graph: SceneGraph;
  readonly log: EventLog;
  private relSeq = 0;

  constructor(
    readonly scene: string,
    readonly library: Library,
    readonly narrator: Narrator,
    opts?: { graph?: SceneGraph; baseSeq?: number },
  ) {
    this.graph = opts?.graph ?? new SceneGraph(scene, library);
    this.log = new EventLog(scene, opts?.baseSeq ?? 0);
  }

  /** Resume a persisted board: apply new turns onto a restored snapshot, with
   * the event log continuing from `baseSeq` (the count already stored). */
  static fromSnapshot(
    scene: string,
    library: Library,
    narrator: Narrator,
    snapshot: SceneGraphSnapshot,
    baseSeq: number,
  ): BoardSession {
    const graph = SceneGraph.fromJSON(snapshot, library);
    return new BoardSession(scene, library, narrator, { graph, baseSeq });
  }

  /** Rebuild the graph purely from the log — replay/undo. Identical semantics
   * to the live graph because both go through SceneGraph.apply. */
  foldAt(seq: number = this.log.seq): SceneGraph {
    return SceneGraph.fold(this.scene, this.log.upTo(seq), this.library);
  }

  async runTurn(programIn: unknown): Promise<TurnResult> {
    const validation = validateTal(programIn, { scene: this.graph, library: this.library });
    if (!validation.ok) return { ok: false, errors: validation.errors };
    // Work on a deep copy — the flow-prev rewrite below must never mutate the
    // caller's program object (TAL is JSON, so this clone is total).
    const src = programIn as TalProgram;
    const program: TalProgram = { ...src, actions: JSON.parse(JSON.stringify(src.actions)) as TalAction[] };
    if (program.scene !== this.scene) {
      return { ok: false, errors: [{ path: "$.scene", message: `program targets scene "${program.scene}", session is "${this.scene}"` }] };
    }

    // Rewrite flow:"below:prev" to the concrete previous instance id — for
    // labels/annotations too, else every "below:prev" label anchors to the same
    // node and they stack on one point.
    let prevPlaced: string | null = lastPlacedId(this.graph);
    for (const a of program.actions) {
      if (a.op === "place") {
        rewriteFlowPrev(a.at, prevPlaced);
        prevPlaced = a.as;
      } else if (a.op === "move") rewriteFlowPrev(a.to, prevPlaced);
      else if ((a.op === "label" || a.op === "annotate") && a.at) rewriteFlowPrev(a.at, prevPlaced);
    }

    // Narration-first timeline (design §2.5).
    const timeline = await schedule(program.actions, this.narrator, (target) => {
      const hit = this.graph.resolveTarget(target);
      return hit?.node.parts?.length || 1;
    });

    // Apply, action by action, by emitting events and folding them into the
    // live graph. `place` must apply before later actions in the same program
    // reference the new instance — which walking in order guarantees.
    const emitted: BoardEvent[] = [];
    const emit = (e: Omit<BoardEvent, "id" | "seq" | "scene">): BoardEvent => {
      const event = this.log.append(e);
      this.graph.apply(event);
      emitted.push(event);
      return event;
    };
    // Labels that resolve to the same anchor (same target, or the same explicit
    // position) are auto-staggered vertically so they never render on top of
    // each other — the model routinely emits several facts about one object.
    const labelAnchorCount = new Map<string, number>();

    for (const s of timeline) {
      const a = s.action;
      const cause = (a as { id?: string }).id;
      const base = { ts: s.start, actor: "tutor" as const, cause };
      switch (a.op) {
        case "speak":
          emit({ ...base, actor: "system", type: "narration.spoken", payload: { text: a.text, ...s.narration } });
          break;
        case "place":
          emit({ ...base, type: "object.placed", payload: { ref: a.ref, as: a.as, at: a.at, props: a.props, turn: program.turn } });
          break;
        case "draw":
          emit({ ...base, type: "object.drawn", target: a.target, payload: { style: a.style, duration: s.end - s.start } });
          break;
        case "remove":
          emit({ ...base, type: "object.removed", target: a.target, payload: { style: a.style } });
          break;
        case "move":
          emit({ ...base, type: "object.moved", target: a.target, payload: { to: a.to } });
          break;
        case "arrow":
        case "connect": {
          const id = a.as ?? `rel_${this.relSeq++}`;
          const node: SceneNode = {
            id,
            kind: a.op === "arrow" ? "arrow" : "connection",
            transform: { at: { region: "center" } },
            props: { from: a.from, to: a.to, kind: a.op === "connect" ? a.kind : "arrow", label: a.op === "arrow" ? a.label : undefined },
            visible: true,
            meta: { label: a.op === "arrow" ? a.label : undefined },
            provenance: { turn: program.turn, actor: "tutor", actionId: cause },
          };
          emit({ ...base, type: "relation.added", target: id, payload: { node } });
          break;
        }
        case "label":
        case "annotate": {
          const id = (a as { as?: string }).as ?? `lbl_${this.relSeq++}`;
          // k-th label on the same anchor is pushed a step further out.
          const anchorKey = a.target ?? JSON.stringify(a.at ?? { region: "top" });
          const k = labelAnchorCount.get(anchorKey) ?? 0;
          labelAnchorCount.set(anchorKey, k + 1);
          let at: LogicalPos = a.at ?? (a.target ? { relativeTo: { id: a.target, offset: [0, -6] } } : { region: "top" });
          if (k > 0) {
            if ("relativeTo" in at) {
              const [ox, oy] = at.relativeTo.offset ?? [0, -6];
              at = { relativeTo: { ...at.relativeTo, offset: [ox, oy - k * 4.5] } };
            } else if ("coord" in at) {
              at = { coord: [at.coord[0], Math.min(97, at.coord[1] + k * 4.5)] };
            } else {
              // region/flow duplicates: nudge via a relative coord fallback
              at = { relativeTo: { id: anchorKey, offset: [0, -6 - k * 4.5] } };
              if (!this.graph.nodes.has(anchorKey)) at = { coord: [50, Math.min(97, 8 + k * 4.5)] };
            }
          }
          const node: SceneNode = {
            id,
            kind: "label",
            transform: { at },
            geometry: { kind: "text", at: [50, 50], text: a.text },
            props: { target: a.target, annotation: a.op === "annotate" },
            style: a.op === "annotate" ? { fontSize: 3.2, opacity: 0.85 } : { fontSize: 4 },
            visible: true,
            meta: { label: a.text },
            provenance: { turn: program.turn, actor: "tutor", actionId: cause },
          };
          emit({ ...base, type: a.op === "annotate" ? "annotation.added" : "label.added", target: id, payload: { node } });
          break;
        }
        case "group":
          emit({ ...base, type: "group.created", payload: { as: a.as, members: a.members, turn: program.turn } });
          break;
        case "highlight":
          emit({
            ...base,
            type: "highlight",
            payload: { targets: Array.isArray(a.target) ? a.target : [a.target], style: a.style ?? "marker", until: s.start + 2.5 },
          });
          break;
        case "focus":
          emit({ ...base, type: "focus", payload: { target: a.target, zoom: a.zoom, region: a.region } });
          break;
        case "set_state":
          emit({ ...base, type: "state.set", target: a.target, payload: { state: a.state } });
          break;
        case "step": {
          const hit = this.graph.resolveTarget(a.target);
          const ref = hit?.node.ref;
          const patch = ref ? this.library.computeStep(ref, hit!.node.props ?? {}, a.step, a.args, hit!.node.state) : null;
          emit({
            ...base,
            type: "step.applied",
            target: a.target,
            payload: { step: a.step, args: a.args, ...(patch ?? {}) },
          });
          break;
        }
        case "pause":
        case "wait_for_student": // Phase 1: auto-continue (design §2.3)
        case "ask":
        case "expect":
        case "on_event":
          break; // schedule-only or Phase 2+ — no board mutation in Phase 0
      }
    }

    return { ok: true, events: emitted, schedule: timeline, readBack: this.graph.readBack(program.turn) };
  }
}

function lastPlacedId(graph: SceneGraph): string | null {
  for (let i = graph.order.length - 1; i >= 0; i--) {
    const n = graph.nodes.get(graph.order[i]!);
    if (n && (n.kind === "object" || n.kind === "primitive")) return n.id;
  }
  return null;
}

function rewriteFlowPrev(pos: LogicalPos, prev: string | null): void {
  if ("flow" in pos && prev) {
    const [dir, ref] = pos.flow.split(":");
    if (ref === "prev") (pos as { flow: string }).flow = `${dir}:${prev}`;
  }
}
