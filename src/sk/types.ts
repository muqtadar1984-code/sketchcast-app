// SK B4 — shared types for the teacher loop. Pure; no imports from the app.
// Source of truth: docs/SK-CONTRACTS.md (§3 manifests, §4 routes, §5 events)
// and the plan's §3 (teaching graph) and §4 (state machine).

// ── Teaching graph (contracts §3.1; the POC manifest is a static JSON) ──────
export type AssetKind = "explain" | "alt" | "example" | "demo" | "misconception" | "practice" | "check";

export type GraphAsset = {
  asset_id: string;
  kind: AssetKind;
  /** explain: "main"; alt: "simpler" | "visual" | …; free text otherwise. */
  style?: string;
  /** Segment manifest URI (explain/alt/demo/misconception). */
  segment?: string;
  /** The manifest's segment_id, copied here so a cursor can be built without loading it. */
  segment_id?: string;
  /** Option S (S1 decision): the prepared clip and its hit map. */
  clip?: string;
  hitmap?: string;
  /** practice/check: item ids (the keys live server-side, never in the graph). */
  item_ids?: string[];
  origin?: "prepared" | "generated";
  validation?: "pass" | "fail" | "pending";
  misconception_ref?: string;
};

export type GraphUnit = {
  unit_key: string;
  teaching_objective_id: string;
  title: string;
  prereqs: string[];
  order: number;
  assets: GraphAsset[];
  /** Validated library figures (visual_asset ids) the unit may draw from — the
   * "validated parts" rung 2 of the safe-generation ladder builds on. */
  figures: string[];
};

export type TeachingGraph = {
  graph_id: string;
  product_id: string;
  chapter: number;
  version: number;
  language: string;
  status: "draft" | "validated" | "live" | "retired";
  units: GraphUnit[];
};

// ── Cursor and bookmarks (contracts §5.5, plan §4) ──────────────────────────
export type Cursor = { graphVersion: number; unitKey: string; assetId: string; segmentId: string; t: number };
export type Bookmark = Cursor & { boardSnapshotId: string | null };

// ── Mastery (derived evidence; plan §10) ────────────────────────────────────
/** `provisional` (founder, 2026-10-27): a check PASSED with help — a hint or a
 * second attempt. It unlocks the next unit like `mastered` but keeps the
 * prerequisite warning, and dashboards show it apart from an independent pass. */
export type MasteryStatus = "unknown" | "in_progress" | "mastered" | "provisional" | "needs_work";
export type MasteryState = {
  status: MasteryStatus;
  /** True only when the evidence came from an unassisted check (plan §3); never true on `provisional`. */
  independent: boolean;
  evidence: { correct: number; total: number };
};
export type MasteryMap = Record<string, MasteryState>;

// ── The closed command set (contracts §4 /api/sk/command) ───────────────────
export const COMMANDS = ["repeat", "slower", "erase", "continue", "skip", "goto", "practise", "return", "explain_again"] as const;
export type CommandName = (typeof COMMANDS)[number];
/** Commands that re-route (go through the planner) vs. ones applied in place. */
export const ROUTE_COMMANDS: readonly CommandName[] = ["skip", "goto", "practise", "return", "explain_again"];
export const EXPLAIN_STYLES = ["main", "simpler", "visual"] as const;
export type ExplainStyle = (typeof EXPLAIN_STYLES)[number];

export type CommandArgs = {
  unitKey?: string;
  n?: number;
  style?: ExplainStyle;
  /** skip: take the 2-item check so the skip counts (default true). */
  withCheck?: boolean;
  /** skip: a bare "skip" skips the SEGMENT (a command); "skip the unit" is a route. */
  scope?: "segment" | "unit";
};
export type Command = { name: CommandName; args: CommandArgs };

// ── Router output (contracts §4: the router may only PROPOSE) ───────────────
export type IntentKind = "command" | "route" | "question" | "answer";
export type Intent = {
  kind: IntentKind;
  command?: Command;
  needsGrounding: boolean;
  confidence: number;
  /** How the intent was decided — "regex" needs no model; "llm" is the Haiku proposal, validated. */
  source: "regex" | "llm" | "default";
};

// ── Utterances and SSE events (contracts §4) ────────────────────────────────
export type Utterance = { text: string; modality: "typed" | "spoken"; transcriptConfirmed?: boolean };
export type SseEvent = { event: "meta" | "text" | "tal" | "gesture" | "speech" | "done" | "error"; data: unknown };

// ── Graded attempts (contracts §5.2, §5.6) ──────────────────────────────────
export type GradeOutcome = "correct" | "partial" | "incorrect" | "needs_review";
