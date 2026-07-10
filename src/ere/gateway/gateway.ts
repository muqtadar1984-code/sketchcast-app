// The AI Gateway (design §8). It sits BEFORE the TAL seam and makes ANY model
// emit valid TAL: it builds the tutor prompt (closed-book grounding + the KO
// catalog + the TAL grammar), calls a model-agnostic `complete`, extracts JSON,
// validates, and does ONE repair pass. It never executes a partially-valid
// program — the engine downstream is deterministic and trusts nothing.
//
// The engine has zero platform knowledge: the host injects the model via the
// `complete` function (Claude/Gemini/GPT/local — all the same to us).

import { validateTal, type ValidationResult } from "../tal/validate";
import { TAL_OPS, TAL_VERSION } from "../tal/types";
import type { Library } from "../ko/library";
import type { CatalogEntry } from "../ko/types";
import type { SceneReader } from "../tal/validate";

/** Model-agnostic completion. The host wires this to its LLM + tiering. */
export type CompleteFn = (args: {
  system: string;
  user: string;
  purpose: "tal" | "repair";
}) => Promise<string>;

export type Grounding = { chapterTitle: string; conceptText?: string; scriptText?: string };

export type GatewayResult =
  | { ok: true; program: unknown; repaired: boolean }
  | { ok: false; errors: ValidationResult["errors"]; raw: string; repaired: boolean };

/** Extract a balanced top-level JSON object from a model reply (tolerates prose
 * / ```json fences). Prefers a candidate that actually looks like a TAL program
 * (contains "tal") so an illustrative code fence before the real answer can't
 * hijack the parse. */
export function extractJson(text: string): string | null {
  const candidates: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) candidates.push(m[1]!);
  candidates.push(text); // also scan the whole reply (unfenced)

  const objects: string[] = [];
  for (const body of candidates) {
    let start = body.indexOf("{");
    while (start !== -1) {
      const obj = balancedFrom(body, start);
      if (obj) {
        objects.push(obj);
        start = body.indexOf("{", start + obj.length);
      } else break;
    }
  }
  if (objects.length === 0) return null;
  return objects.find((o) => /"tal"\s*:/.test(o)) ?? objects[0]!;
}

function balancedFrom(body: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return body.slice(start, i + 1);
  }
  return null;
}

const OP_HELP: Record<string, string> = {
  speak: "speak{id,text} — narration; its id is a sync anchor",
  place: "place{ref,as,at} — instantiate a catalog object/primitive (invisible until draw)",
  draw: "draw{target,sync?} — animate an object appearing",
  set_state: "set_state{target,state} — transition a KO to a named state",
  step: "step{target,step,args?} — advance a process one semantic step",
  highlight: "highlight{target,style?} — emphasise (target may be a part like h.right_atrium)",
  arrow: "arrow{from,to,label?} — directed relation between objects/parts",
  label: "label{text,target?|at} — text bound to an object or position",
  move: "move{target,to} — reposition",
  focus: "focus{target?,zoom?} — attend to something",
};

export function buildTalPrompt(opts: {
  grounding: Grounding;
  catalog: CatalogEntry[];
  scene: string;
  turn: number;
  studentMessage: string;
  readBack?: Record<string, unknown>;
}): { system: string; user: string } {
  const { grounding, catalog, scene, turn, studentMessage, readBack } = opts;
  const cat = catalog
    .map((c) => {
      const bits = [`parts:[${c.parts.join(",")}]`];
      if (c.states.length) bits.push(`states:[${c.states.join(",")}]`);
      if (c.steps.length) bits.push(`steps:[${c.steps.join(",")}]`);
      if (c.props?.length) bits.push(`props:[${c.props.join(",")}]`);
      return `- ${c.id} (${c.name}) ${bits.join(" ")}`;
    })
    .join("\n");

  const system =
    `You are "Coach", teaching at a persistent whiteboard. You do NOT draw pixels — you emit a ` +
    `TAL v${TAL_VERSION} program (JSON) and a deterministic engine renders it.\n\n` +
    `RULES:\n` +
    `1. Ground every teaching action ONLY in the chapter context. If it isn't in the chapter, say so ` +
    `(a "speak" that steers back) and stop — never invent facts, never do the student's graded work.\n` +
    `2. Reference ONLY objects that appear in the CATALOG below (place them by their id) or compose from ` +
    `prim.* primitives. Never invent a ref. Use a KO's listed states/steps only.\n` +
    `3. The board PERSISTS across turns. To build on what's there, mutate existing instances (set_state/` +
    `highlight/step/remove) — do NOT re-place them. New instances need a place before a draw.\n` +
    `4. Narration drives pacing: emit "speak" units and bind visuals to them with "sync":{"with":"<speakId>","at":"end"}.\n` +
    `5. Positions are logical: {"region":"center"}, {"relativeTo":{"id":"h","anchor":"right_atrium"}}, ` +
    `{"coord":[x,y]} on a 0–100 grid, or {"flow":"below:prev"}. Never pixels.\n\n` +
    `OPERATIONS: ${TAL_OPS.filter((o) => OP_HELP[o]).map((o) => OP_HELP[o]).join("; ")}.\n\n` +
    `OUTPUT: a single JSON object {"tal":"${TAL_VERSION}","scene":"${scene}","turn":${turn},"actions":[...]} and NOTHING else.`;

  const context =
    `CHAPTER: ${grounding.chapterTitle}\n` +
    (grounding.conceptText ? `CONCEPTS:\n${grounding.conceptText.slice(0, 6000)}\n` : "") +
    (grounding.scriptText ? `LESSON NARRATION:\n${grounding.scriptText.slice(0, 6000)}\n` : "");

  const board = readBack
    ? `\n\nCURRENT BOARD (read-back — build on this, don't redraw it):\n${JSON.stringify(readBack)}`
    : `\n\nThe board is currently empty.`;

  const user = `${context}\nCATALOG:\n${cat}${board}\n\nSTUDENT: ${studentMessage}\n\nEmit the TAL program for your teaching turn.`;
  return { system, user };
}

/** Ask a model for a TAL program, validate, and repair once on failure. */
export async function generateTal(opts: {
  complete: CompleteFn;
  library: Library;
  scene: SceneReader;
  turn: number;
  grounding: Grounding;
  studentMessage: string;
  subjects?: string[];
  readBack?: Record<string, unknown>;
}): Promise<GatewayResult> {
  const { complete, library, scene, turn, grounding, studentMessage, subjects, readBack } = opts;
  const catalog = library.catalog({ subjects });
  const { system, user } = buildTalPrompt({
    grounding,
    catalog,
    scene: (scene as unknown as { scene?: string }).scene ?? "sess",
    turn,
    studentMessage,
    readBack,
  });

  const first = await complete({ system, user, purpose: "tal" });
  const firstJson = extractJson(first);
  let parsed: unknown = null;
  try {
    if (firstJson) parsed = JSON.parse(firstJson);
  } catch {
    parsed = null;
  }
  let result = parsed ? validateTal(parsed, { scene, library }) : { ok: false, errors: [{ path: "$", message: "no JSON object found" }] };
  if (result.ok) return { ok: true, program: parsed, repaired: false };

  // One repair pass: hand back the exact validation errors.
  const repairUser =
    `${user}\n\nYour previous reply was INVALID:\n${first}\n\nErrors:\n` +
    result.errors.map((e) => `- ${e.path}: ${e.message}`).join("\n") +
    `\n\nReturn a corrected JSON program only.`;
  const second = await complete({ system, user: repairUser, purpose: "repair" });
  const secondJson = extractJson(second);
  let reparsed: unknown = null;
  try {
    if (secondJson) reparsed = JSON.parse(secondJson);
  } catch {
    reparsed = null;
  }
  result = reparsed ? validateTal(reparsed, { scene, library }) : result;
  if (result.ok) return { ok: true, program: reparsed, repaired: true };
  return { ok: false, errors: result.errors, raw: second, repaired: true };
}
