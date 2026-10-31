// SK gap tracker — signal A: SK says it itself. `sk.note_gap` is a model
// tool of the Shell's main model call (NOT a registry capability): the turn
// route intercepts it before the runner, so it never runs a handler, never
// writes an audit row, never sends a `tool` chip, never counts as a tool that
// answered (grounding) and never backs an action claim. It only notes the
// gap for the turn (TurnGaps) and tells the model "noted, say nothing more".
//
// PURE.

import type { ToolDef } from "@/utils/assistant/provider";

/** The dotted name (as the route and routing.ts compare it). */
export const NOTE_GAP_TOOL = "sk.note_gap";
/** The API-safe form the model sees (registry.ts toApiToolName). */
export const NOTE_GAP_API_NAME = "sk__note_gap";

export const NOTE_GAP_WANTED_MAX = 200;
export const NOTE_GAP_WHY_MAX = 300;

export const NOTE_GAP_TOOL_DEF: ToolDef = {
  name: NOTE_GAP_API_NAME,
  description:
    "Record, for the SketchCast team, that you could not help with this request: you must decline it, you could not find what was asked, or SketchCast has no such feature. The user sees nothing. Write your answer to the user first, then call this in the same response; after its result write nothing more. Never call it for a request you answered.",
  parameters: {
    type: "object",
    properties: {
      wanted: { type: "string", description: `What the user wanted, in one short line (at most ${NOTE_GAP_WANTED_MAX} characters), e.g. "email this worksheet to my class".` },
      why: { type: "string", description: "Why you could not help, in a few words (optional), e.g. \"no email feature\"." },
    },
    required: ["wanted"],
    additionalProperties: false,
  },
};

/** What the model reads back: data only, and nothing to narrate. */
export const NOTE_GAP_RESULT = `<tool_result data_only="true">${JSON.stringify({ ok: true, summary: "Noted for the SketchCast team. The user does not see this. Do not mention it; if you have already answered, write nothing more.", facts: [] })}</tool_result>`;

export function isNoteGapCall(name: string): boolean {
  return name === NOTE_GAP_API_NAME || name === NOTE_GAP_TOOL;
}

/** The model's arguments, cleaned. Null when `wanted` is missing. */
export function parseNoteGap(args: unknown): { wanted: string; why: string | null } | null {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const wanted = typeof a.wanted === "string" ? a.wanted.replace(/\s+/g, " ").trim().slice(0, NOTE_GAP_WANTED_MAX) : "";
  if (!wanted) return null;
  const why = typeof a.why === "string" ? a.why.replace(/\s+/g, " ").trim().slice(0, NOTE_GAP_WHY_MAX) : "";
  return { wanted, why: why || null };
}
