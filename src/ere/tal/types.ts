// TAL v0 — the Teaching Action Language (design §2). The seam between the
// probabilistic tutor and the deterministic engine. Renderer-agnostic,
// declarative, addressable, small enough to validate exhaustively.
// Canonical form is JSON; these types ARE the grammar.

import type { LogicalPos, Style } from "../scene/types";

export const TAL_VERSION = "0.1";

/** Binding an action to the narration clock (design §2.5). */
export type Sync =
  | { with: string; at?: "start" | "end" | `word:${number}` }
  | { after: string; delay?: number };

export type HighlightStyle = "marker" | "circle" | "underline" | "glow";
export type RemoveStyle = "erase" | "fade";

// ── Narration & pacing ────────────────────────────────────────────────────────
export type SpeakOp = { op: "speak"; id: string; text: string; voice?: string };
export type PauseOp = { op: "pause"; id?: string; seconds: number };
/** Declared in v0; Phase-1 interpreter auto-continues (design §2.3). */
export type WaitForStudentOp = { op: "wait_for_student"; id?: string; prompt?: string };

// ── Object lifecycle ──────────────────────────────────────────────────────────
export type PlaceOp = {
  op: "place";
  id?: string;
  ref: string; // library id ("bio.heart", "prim.arrow")
  as: string; // instance id
  at: LogicalPos;
  props?: Record<string, unknown>;
};
export type DrawOp = { op: "draw"; id?: string; target: string; style?: Style; sync?: Sync };
export type RemoveOp = { op: "remove"; id?: string; target: string; style?: RemoveStyle; sync?: Sync };
export type MoveOp = { op: "move"; id?: string; target: string; to: LogicalPos; sync?: Sync };

// ── Structure & relations ─────────────────────────────────────────────────────
export type ArrowOp = { op: "arrow"; id?: string; from: string; to: string; label?: string; as?: string; sync?: Sync };
export type ConnectOp = { op: "connect"; id?: string; from: string; to: string; kind: string; as?: string; sync?: Sync };
export type LabelOp = { op: "label"; id?: string; text: string; target?: string; at?: LogicalPos; as?: string; sync?: Sync };
export type GroupOp = { op: "group"; id?: string; members: string[]; as: string };

// ── Emphasis, focus, state ────────────────────────────────────────────────────
export type HighlightOp = { op: "highlight"; id?: string; target: string | string[]; style?: HighlightStyle; sync?: Sync };
export type FocusOp = { op: "focus"; id?: string; target?: string; zoom?: number; region?: LogicalPos; sync?: Sync };
export type SetStateOp = { op: "set_state"; id?: string; target: string; state: string; sync?: Sync };
export type StepOp = { op: "step"; id?: string; target: string; step: string; args?: Record<string, unknown>; sync?: Sync };
export type AnnotateOp = { op: "annotate"; id?: string; text: string; target?: string; at?: LogicalPos; sync?: Sync };

// ── Interaction (declared in v0; enabled Phase 2/3 — design §2.3) ────────────
export type AskOp = { op: "ask"; id?: string; text: string; expect?: string };
export type ExpectOp = { op: "expect"; id?: string; action: string; target?: string; constraints?: Record<string, unknown> };
export type OnEventOp = { op: "on_event"; id?: string; when: { type: string; target?: string }; do: TalAction[] };

export type TalAction =
  | SpeakOp
  | PauseOp
  | WaitForStudentOp
  | PlaceOp
  | DrawOp
  | RemoveOp
  | MoveOp
  | ArrowOp
  | ConnectOp
  | LabelOp
  | GroupOp
  | HighlightOp
  | FocusOp
  | SetStateOp
  | StepOp
  | AnnotateOp
  | AskOp
  | ExpectOp
  | OnEventOp;

export type TalOpName = TalAction["op"];

/** One tutor turn: a program of actions against a PERSISTENT scene. */
export type TalProgram = {
  tal: string; // version, e.g. "0.1"
  scene: string; // persistent board id — same across the whole session
  turn: number;
  actions: TalAction[];
};

export const TAL_OPS: readonly TalOpName[] = [
  "speak",
  "pause",
  "wait_for_student",
  "place",
  "draw",
  "remove",
  "move",
  "arrow",
  "connect",
  "label",
  "group",
  "highlight",
  "focus",
  "set_state",
  "step",
  "annotate",
  "ask",
  "expect",
  "on_event",
] as const;
