// The scene graph — the board's single source of truth (design §3). It is the
// FOLD of the event log: SceneGraph.fold(events) reproduces any board state,
// which is what makes replay/undo trivial and renderers pure.

import type { LogicalPos, SceneNode, Provenance } from "./types";
import type { BoardEvent } from "./events";
import type { SceneReader } from "../tal/validate";

/** Instantiates a library ref into a SceneNode (provided by ko/library — an
 * interface here so scene/ has no dependency on the library implementation). */
export interface Instantiator {
  instantiate(
    ref: string,
    as: string,
    at: LogicalPos,
    props: Record<string, unknown> | undefined,
    provenance: Provenance,
  ): SceneNode | null;
  /** Re-derive dynamic parts after a props change (e.g. array values after a swap). */
  refreshParts(node: SceneNode): void;
}

/** A JSON-safe snapshot of a board (for persistence + resume). */
export type SceneGraphSnapshot = {
  scene: string;
  nodes: SceneNode[];
  focus?: { target?: string; zoom?: number; region?: LogicalPos };
};

export class SceneGraph implements SceneReader {
  readonly nodes = new Map<string, SceneNode>();
  order: string[] = []; // insertion order (z within equal z-index)
  focus?: { target?: string; zoom?: number; region?: LogicalPos };

  constructor(
    readonly scene: string,
    private readonly lib: Instantiator,
  ) {}

  // ── SceneReader (used by TAL semantic validation) ──
  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }
  hasTarget(target: string): boolean {
    return this.resolveTarget(target) !== null;
  }
  refOf(id: string): string | undefined {
    return this.nodes.get(id)?.ref;
  }

  /** Resolve "h", "h.right_atrium", "arr[0]", "h.valves.tricuspid" → node/part. */
  resolveTarget(target: string): { node: SceneNode; part?: SceneNode; partPath?: string } | null {
    const segments = target.replace(/\[(\w+)\]/g, ".$1").split(".");
    const rootId = segments[0]!;
    const node = this.nodes.get(rootId);
    if (!node) return null;
    if (segments.length === 1) return { node };
    let current: SceneNode = node;
    for (const seg of segments.slice(1)) {
      const next = (current.parts ?? []).find((p) => p.id === seg);
      if (!next) return null;
      current = next;
    }
    return { node, part: current, partPath: segments.slice(1).join(".") };
  }

  /** Apply one event to the graph. Unknown/transient events are no-ops by design. */
  apply(e: BoardEvent): void {
    switch (e.type) {
      case "object.placed": {
        const { ref, as, at, props, kind } = e.payload as {
          ref: string;
          as: string;
          at: LogicalPos;
          props?: Record<string, unknown>;
          kind?: SceneNode["kind"];
        };
        const prov: Provenance = { turn: (e.payload?.turn as number) ?? 0, actor: e.actor, actionId: e.cause };
        const node =
          this.lib.instantiate(ref, as, at, props, prov) ??
          // Unknown ref at fold time (shouldn't happen post-validation) → shell node.
          ({
            id: as,
            kind: kind ?? "object",
            ref,
            transform: { at },
            props,
            visible: false,
            meta: {},
            provenance: prov,
          } satisfies SceneNode);
        this.nodes.set(as, node);
        this.order.push(as);
        break;
      }
      case "object.drawn": {
        const hit = e.target ? this.resolveTarget(e.target) : null;
        if (hit) (hit.part ?? hit.node).visible = true;
        if (hit && !hit.part) hit.node.parts?.forEach(markVisibleDeep);
        break;
      }
      case "object.removed": {
        if (e.target && this.nodes.has(e.target)) {
          this.nodes.delete(e.target);
          this.order = this.order.filter((id) => id !== e.target);
        }
        break;
      }
      case "object.moved": {
        const hit = e.target ? this.resolveTarget(e.target) : null;
        if (hit && !hit.part) hit.node.transform.at = (e.payload as { to: LogicalPos }).to;
        break;
      }
      case "relation.added":
      case "label.added":
      case "annotation.added": {
        const node = e.payload?.node as SceneNode | undefined;
        if (node) {
          this.nodes.set(node.id, node);
          this.order.push(node.id);
        }
        break;
      }
      case "group.created": {
        const { as, members } = e.payload as { as: string; members: string[] };
        const prov: Provenance = { turn: (e.payload?.turn as number) ?? 0, actor: e.actor, actionId: e.cause };
        const parts = members
          .map((m) => this.nodes.get(m))
          .filter((n): n is SceneNode => !!n);
        // Group REFERENCES member ids; members stay top-level (a group is an
        // addressable alias, not a reparenting — keeps remove/move semantics simple).
        this.nodes.set(as, {
          id: as,
          kind: "group",
          transform: { at: { region: "center" } },
          props: { members },
          parts,
          visible: true,
          meta: {},
          provenance: prov,
        });
        break;
      }
      case "state.set": {
        const hit = e.target ? this.resolveTarget(e.target) : null;
        if (hit) hit.node.state = (e.payload as { state: string }).state;
        break;
      }
      case "step.applied": {
        const hit = e.target ? this.resolveTarget(e.target) : null;
        if (!hit) break;
        const patch = (e.payload as { props?: Record<string, unknown>; state?: string }) ?? {};
        if (patch.props) hit.node.props = { ...(hit.node.props ?? {}), ...patch.props };
        if (patch.state) hit.node.state = patch.state;
        this.lib.refreshParts(hit.node); // dynamic parts (array cells…) re-derive
        break;
      }
      case "focus": {
        this.focus = e.payload as { target?: string; zoom?: number };
        break;
      }
      default:
        break; // highlight / narration.spoken / student.* are transient or Phase 2+
    }
  }

  /** Rebuild a graph purely from events — replay, undo, time-travel. */
  static fold(scene: string, events: readonly BoardEvent[], lib: Instantiator): SceneGraph {
    const g = new SceneGraph(scene, lib);
    for (const e of events) g.apply(e);
    return g;
  }

  /** Serialise the current board for persistence. Nodes are plain data (no
   * functions), so this is a total, JSON-safe snapshot. */
  toJSON(): SceneGraphSnapshot {
    return {
      scene: this.scene,
      nodes: this.order.map((id) => this.nodes.get(id)).filter((n): n is SceneNode => !!n),
      focus: this.focus,
    };
  }

  /** Restore a board from a snapshot. The library is needed only for future
   * mutations (steps/instantiation), not to hold the restored state. */
  static fromJSON(json: SceneGraphSnapshot, lib: Instantiator): SceneGraph {
    const g = new SceneGraph(json.scene, lib);
    for (const n of json.nodes) g.nodes.set(n.id, n);
    g.order = json.nodes.map((n) => n.id);
    g.focus = json.focus;
    return g;
  }

  /** A stable content hash of the board STATE (order + each node's ref/state/
   * visibility/props). Used as a cache key so the same question against a
   * different board produces a context-appropriate turn. Deterministic (FNV-1a). */
  stateHash(): string {
    const canon = JSON.stringify(
      this.order.map((id) => {
        const n = this.nodes.get(id);
        return n ? { id: n.id, ref: n.ref, state: n.state ?? null, visible: n.visible, props: n.props ?? null } : null;
      }),
    );
    let h = 0x811c9dc5;
    for (let i = 0; i < canon.length; i++) {
      h ^= canon.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  /** The compact read-back the tutor perceives each turn (design §6.1). */
  readBack(turn: number, recentStudentEvents: BoardEvent[] = []): Record<string, unknown> {
    return {
      scene: this.scene,
      turn,
      focus: this.focus?.target,
      objects: [...this.nodes.values()]
        .filter((n) => n.kind !== "group")
        .map((n) => ({
          id: n.id,
          ref: n.ref,
          kind: n.kind,
          state: n.state,
          visible: n.visible,
          props: n.props,
          label: n.meta.label,
        })),
      recentStudentEvents: recentStudentEvents.map((e) => ({ type: e.type, target: e.target, payload: e.payload })),
    };
  }
}

function markVisibleDeep(n: SceneNode): void {
  n.visible = true;
  n.parts?.forEach(markVisibleDeep);
}
