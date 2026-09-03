// The per-kind option specs and the defaults they imply — in a module with NO
// "use client" directive. They were inside options-modal.tsx (a Client
// Component) until 2026-09-03, which meant `defaultParams` reached every
// importer as a client reference. That was survivable only because every
// importer happened to be a Client Component too; the first API route or
// server page to build a kit row would have thrown "Attempted to call
// defaultParams() from the server" — the exact failure that took the dashboard
// down the same day via statusLabel (see ./labels.ts). Pure data and a pure
// function belong in a pure module; src/__tests__/server-client-boundary.test.ts
// now refuses the old arrangement.

import type { LibraryMessages } from "./labels";

// A field's `label` is a KEY into t.options.fields, never a word: two kinds can
// share a param key with different wording (case_study's num_questions reads
// "Discussion questions"), so the display name is looked up separately from the
// param the worker receives. Select choices work the same way — the option
// VALUES stay the English tokens the worker expects; only their labels are
// translated. The modal's heading is looked up by kind (t.options.titles).
export type FieldLabel = keyof LibraryMessages["options"]["fields"];
export type ChoiceSet = keyof LibraryMessages["options"]["choices"];

export type Field =
  | { type: "number"; key: string; label: FieldLabel; min: number; max: number; def: number }
  | { type: "select"; key: string; label: FieldLabel; choices: ChoiceSet; options: string[]; def: string }
  | { type: "checkbox"; key: string; label: FieldLabel; def: boolean };

export type Spec = { fields: Field[]; build: (v: Record<string, unknown>) => Record<string, unknown> };

// Per-kind customization. `build` shapes the flat field values into the params
// the worker expects (exam nests its objective counts).
export const SPECS: Record<string, Spec> = {
  lesson_plan: {
    fields: [
      { type: "number", key: "duration_minutes", label: "duration_minutes", min: 10, max: 180, def: 45 },
      { type: "checkbox", key: "include_homework", label: "include_homework", def: true },
      { type: "checkbox", key: "include_differentiation", label: "include_differentiation", def: true },
    ],
    build: (v) => v,
  },
  activity: {
    fields: [{ type: "number", key: "num_activities", label: "num_activities", min: 1, max: 8, def: 4 }],
    build: (v) => v,
  },
  worksheet: {
    fields: [
      { type: "number", key: "num_questions", label: "num_questions", min: 1, max: 40, def: 10 },
      { type: "select", key: "difficulty", label: "difficulty", choices: "difficulty", options: ["easy", "medium", "hard"], def: "medium" },
      { type: "checkbox", key: "include_answer_key", label: "include_answer_key", def: true },
    ],
    build: (v) => v,
  },
  case_study: {
    fields: [
      { type: "select", key: "length", label: "length", choices: "length", options: ["short", "medium", "long"], def: "medium" },
      { type: "number", key: "num_questions", label: "discussion_questions", min: 1, max: 15, def: 4 },
    ],
    build: (v) => v,
  },
  exam_paper: {
    fields: [
      { type: "number", key: "fill_blank", label: "fill_blank", min: 0, max: 20, def: 5 },
      { type: "number", key: "true_false", label: "true_false", min: 0, max: 20, def: 5 },
      { type: "number", key: "match_column", label: "match_column", min: 0, max: 20, def: 4 },
      { type: "number", key: "subjective", label: "subjective", min: 0, max: 20, def: 3 },
      { type: "checkbox", key: "include_answer_key", label: "include_answer_key", def: true },
    ],
    build: (v) => ({
      objective: { fill_blank: v.fill_blank, true_false: v.true_false, match_column: v.match_column },
      subjective: v.subjective,
      include_answer_key: v.include_answer_key,
    }),
  },
};

// The params OptionsModal would submit with nothing changed — lets a batch
// "Generate" queue document kinds without opening each modal. Unknown kinds
// carry no params (null); presentation defaults live in utils/narration.ts.
export function defaultParams(kind: string): Record<string, unknown> | null {
  const spec = SPECS[kind];
  if (!spec) return null;
  const vals = Object.fromEntries(spec.fields.map((f) => [f.key, f.def]));
  return spec.build(vals);
}
