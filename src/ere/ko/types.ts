// Knowledge objects — structured, part-whole, STATEFUL teaching objects
// (design §4). Don't store Heart.svg; store a Heart: parts, states,
// transitions, semantic steps, and metadata, so one object can be drawn,
// labelled, transitioned and stepped on command by TAL.

import type { Anchor, PrimitiveGeometry, Style } from "../scene/types";

/** A named sub-object with its own logical geometry and draw order. */
export type Part = {
  id: string; // addressable as `${instance}.${id}`
  name?: string;
  geometry: PrimitiveGeometry;
  style?: Style;
  anchors?: Anchor[];
  /** Parts hidden by default appear only in states that list them. */
  hiddenByDefault?: boolean;
};

/**
 * A named configuration of the object. Renderer-agnostic: a state describes
 * WHICH parts are visible/emphasised and with what style patches — the
 * renderer interpolates the difference.
 */
export type KOState = {
  id: string; // "diastole", "flow.deox_enters_ra", "mitosis.prophase"
  description?: string;
  /** Style patches per part id while in this state. */
  partStyles?: Record<string, Style>;
  /** Parts visible in this state (defaults to all non-hidden parts). */
  visibleParts?: string[];
  /** Extra transient labels shown in this state: partId → text. */
  labels?: Record<string, string>;
};

export type Transition = {
  from: string; // state id or "*"
  to: string;
  durationSec?: number; // renderer hint; default 1s
  effect?: "interpolate" | "cut" | "flow"; // renderer-interpreted
};

/**
 * A semantic step (design: `step` op) — advance a process one meaningful unit
 * (compare, swap, mitose, advance_flow). Steps are CODE in the library (the
 * library ships as TS), operating on instance props; they return a patch plus
 * optional emphasis targets so the interpreter stays generic.
 */
export type StepDef = {
  op: string;
  description?: string;
  /** `state` is the target's CURRENT display state, so a step can advance from
   * where the board actually is (avoids set_state/step counter decoupling). */
  apply: (
    props: Record<string, unknown>,
    args: Record<string, unknown> | undefined,
    state: string | undefined,
  ) => {
    props?: Record<string, unknown>; // patch merged into instance props
    state?: string; // optional state transition triggered by the step
    emphasize?: string[]; // part ids to highlight as the step plays
  };
};

export type Relation = { from: string; to: string; kind: string; label?: string };

/** Phase-3 hook (declared now, unused in Phase 0): parameterised behaviours. */
export type Behaviour = { id: string; kind: "drag" | "simulate" | "react"; params?: Record<string, unknown> };

export type KnowledgeObject = {
  id: string; // "bio.heart"
  name: string;
  subjects: string[];
  tags: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** Provenance tier (design §4.1). Tier 3 (generated) is quarantined; the
   * schema slot exists but Phase 0 ships only curated Tier-1 objects and the
   * Tier-2 primitive kit. */
  tier: 1 | 2 | 3;
  parts: Part[];
  /** Instance-data-driven parts (e.g. algo.array cells from props.values). */
  dynamicParts?: (props: Record<string, unknown>) => Part[];
  states: KOState[];
  transitions: Transition[];
  relations?: Relation[];
  steps?: StepDef[];
  animation: { drawOrder: string[]; strokeSecPerPart?: number };
  behaviours?: Behaviour[];
  anchors?: Anchor[]; // object-level anchors (center, top, …) beyond per-part ones
  renderHints?: Record<string, unknown>;
  provenance: { source: "curated" | "composed" | "generated"; reviewedBy?: string };
  /** Visual Quality Standard sign-off (Phase 2). An object only reaches the live
   * board when `vqs.approved` is true — the gate mirrors the Tier-3 quarantine.
   * `golden` names the approved golden-snapshot file; `approvedBy` records the
   * human sign-off. Absent ⇒ treated as NOT approved (must be explicitly passed).
   * See VISUAL_QUALITY_STANDARD.md. */
  vqs?: { approved: boolean; approvedBy?: string; golden?: string };
};

/** The compact semantic-index entry fed into the tutor prompt (design §4.3). */
export type CatalogEntry = {
  id: string;
  name: string;
  subjects: string[];
  tags: string[];
  difficulty: number;
  parts: string[];
  states: string[];
  steps: string[];
  props?: string[]; // documented instance props, e.g. ["values"] for algo.array
};
