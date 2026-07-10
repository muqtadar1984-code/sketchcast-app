// TAL validation (design §2.6) — the safety fence. Two passes:
//   (a) STRUCTURAL: op names, required params, types (hand-rolled, zero-dep).
//   (b) SEMANTIC: referenced ids exist (in the scene OR introduced earlier in
//       this program), refs resolve in the library, states/steps are defined
//       by the target's knowledge object, sync anchors exist.
// Invalid programs are rejected whole — never executed partially.

import { TAL_OPS, TAL_VERSION, type TalAction, type TalProgram } from "./types";
import type { LogicalPos } from "../scene/types";

export type ValidationError = { path: string; message: string };
export type ValidationResult = { ok: boolean; errors: ValidationError[] };

/** What semantic validation needs to know about the current board. */
export interface SceneReader {
  hasNode(id: string): boolean;
  /** Resolve "h.right_atrium" / "arr[0]" → true if the node+part exists. */
  hasTarget(target: string): boolean;
  /** The library ref of a node, if any (for state/step checks on scene nodes). */
  refOf(id: string): string | undefined;
}

/** What semantic validation needs to know about the object library. */
export interface LibraryReader {
  has(ref: string): boolean;
  statesOf(ref: string): string[];
  stepsOf(ref: string): string[];
  partsOf(ref: string): string[];
  /** True when parts are data-driven (array cells, tree nodes) → part paths and
   * anchors can't be validated statically, so validation is lenient for them. */
  hasDynamicParts(ref: string): boolean;
  /** Valid anchor names for relative positioning: object anchors + part ids. */
  anchorsOf(ref: string): string[];
}

const REGIONS = new Set([
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function isLogicalPos(v: unknown): v is LogicalPos {
  if (!isObj(v)) return false;
  if ("relativeTo" in v) {
    const r = v.relativeTo;
    return isObj(r) && isStr(r.id);
  }
  if ("region" in v) return isStr(v.region);
  if ("coord" in v) return Array.isArray(v.coord) && v.coord.length === 2 && v.coord.every(isNum);
  if ("flow" in v) return isStr(v.flow) && /^(below|above|left|right):/.test(v.flow);
  return false;
}

function isSync(v: unknown): boolean {
  if (!isObj(v)) return false;
  if ("with" in v) {
    if (!isStr(v.with)) return false;
    if (v.at === undefined) return true;
    return v.at === "start" || v.at === "end" || (isStr(v.at) && /^word:\d+$/.test(v.at));
  }
  if ("after" in v) return isStr(v.after) && (v.delay === undefined || isNum(v.delay));
  return false;
}

// Per-op structural requirements: field → checker (undefined-allowed handled by `opt`).
type Check = (v: unknown) => boolean;
const opt = (c: Check): Check => (v) => v === undefined || c(v);
const REQUIRED: Record<string, Record<string, Check>> = {
  speak: { id: isStr, text: isStr, voice: opt(isStr) },
  pause: { seconds: isNum },
  wait_for_student: { prompt: opt(isStr) },
  place: { ref: isStr, as: isStr, at: isLogicalPos, props: opt(isObj) },
  draw: { target: isStr, sync: opt(isSync) },
  remove: { target: isStr, style: opt((v) => v === "erase" || v === "fade"), sync: opt(isSync) },
  move: { target: isStr, to: isLogicalPos, sync: opt(isSync) },
  arrow: { from: isStr, to: isStr, label: opt(isStr), as: opt(isStr), sync: opt(isSync) },
  connect: { from: isStr, to: isStr, kind: isStr, as: opt(isStr), sync: opt(isSync) },
  label: { text: isStr, target: opt(isStr), at: opt(isLogicalPos), as: opt(isStr), sync: opt(isSync) },
  group: { members: (v) => Array.isArray(v) && v.length > 0 && v.every(isStr), as: isStr },
  highlight: {
    target: (v) => isStr(v) || (Array.isArray(v) && v.length > 0 && v.every(isStr)),
    style: opt((v) => ["marker", "circle", "underline", "glow"].includes(v as string)),
    sync: opt(isSync),
  },
  focus: { target: opt(isStr), zoom: opt(isNum), region: opt(isLogicalPos), sync: opt(isSync) },
  set_state: { target: isStr, state: isStr, sync: opt(isSync) },
  step: { target: isStr, step: isStr, args: opt(isObj), sync: opt(isSync) },
  annotate: { text: isStr, target: opt(isStr), at: opt(isLogicalPos), sync: opt(isSync) },
  ask: { text: isStr, expect: opt(isStr) },
  expect: { action: isStr, target: opt(isStr), constraints: opt(isObj) },
  on_event: { when: isObj, do: (v) => Array.isArray(v) },
};

/** Strip a part path: "h.right_atrium" → "h"; "arr[0]" → "arr". */
export function baseId(target: string): string {
  const bracket = target.indexOf("[");
  const dot = target.indexOf(".");
  const cut = Math.min(bracket === -1 ? Infinity : bracket, dot === -1 ? Infinity : dot);
  return cut === Infinity ? target : target.slice(0, cut);
}

export function validateTal(
  program: unknown,
  ctx: { scene: SceneReader; library: LibraryReader },
): ValidationResult {
  const errors: ValidationError[] = [];
  const err = (path: string, message: string): void => {
    errors.push({ path, message });
  };

  // ── structural: envelope ──
  if (!isObj(program)) return { ok: false, errors: [{ path: "$", message: "program must be an object" }] };
  const p = program as Partial<TalProgram>;
  if (p.tal !== TAL_VERSION) err("$.tal", `unsupported TAL version (expected "${TAL_VERSION}")`);
  if (!isStr(p.scene)) err("$.scene", "scene id is required");
  if (!isNum(p.turn)) err("$.turn", "turn number is required");
  if (!Array.isArray(p.actions) || p.actions.length === 0) {
    err("$.actions", "actions must be a non-empty array");
    return { ok: false, errors };
  }

  // ── structural: per-action (recurses into on_event.do) ──
  const checkStructural = (a: unknown, path: string): void => {
    if (!isObj(a) || !isStr((a as { op?: unknown }).op)) return err(path, "action must have an op");
    const op = (a as { op: string }).op;
    if (!TAL_OPS.includes(op as (typeof TAL_OPS)[number])) return err(`${path}.op`, `unknown op "${op}"`);
    const spec = REQUIRED[op]!;
    for (const [field, check] of Object.entries(spec)) {
      const value = (a as Record<string, unknown>)[field];
      const required = check(undefined) === false; // opt() checkers accept undefined
      if (required && value === undefined) err(`${path}.${field}`, `"${op}" requires "${field}"`);
      else if (value !== undefined && !check(value)) err(`${path}.${field}`, `invalid "${field}" for "${op}"`);
    }
    if (op === "on_event" && Array.isArray((a as { do?: unknown[] }).do)) {
      (a as { do: unknown[] }).do.forEach((nested, k) => checkStructural(nested, `${path}.do[${k}]`));
    }
  };
  p.actions.forEach((a, i) => checkStructural(a, `$.actions[${i}]`));
  if (errors.length) return { ok: false, errors };

  // ── semantic: simulate the program against the scene ──
  const actions = p.actions as TalAction[];
  const introducedRefs = new Map<string, string | undefined>(); // id → ref (undefined for arrow/label/group)
  const speakIds = new Set<string>();
  const actionIds = new Set<string>();

  const exists = (id: string): boolean => introducedRefs.has(id) || ctx.scene.hasNode(id);
  const refOf = (id: string): string | undefined => introducedRefs.get(id) ?? ctx.scene.refOf(id);

  /** Validate a target that may be a bare id or a part-path ("h.right_atrium"). */
  const targetError = (t: string): string | null => {
    const base = baseId(t);
    const partPath = t.slice(base.length).replace(/^[.[]|\]$/g, "").replace(/\[/g, ".").replace(/\]/g, "");
    if (!exists(base)) return `unknown target "${t}"`;
    if (!partPath) return null;
    // Part-path: validate against the KO's static parts unless it's dynamic-part
    // (array cells / tree nodes can't be known statically → lenient), or a
    // ref-less node (arrow/label/group have no parts → part-path is invalid).
    const ref = refOf(base);
    if (ctx.scene.hasNode(base) && !introducedRefs.has(base)) {
      return ctx.scene.hasTarget(t) ? null : `unknown target "${t}"`;
    }
    if (!ref) return `"${base}" has no parts to address`;
    if (ctx.library.hasDynamicParts(ref)) return null;
    const first = partPath.split(".")[0]!;
    return ctx.library.partsOf(ref).includes(first) ? null : `"${ref}" has no part "${first}"`;
  };
  const checkTarget = (t: string, path: string): void => {
    const e = targetError(t);
    if (e) err(path, e);
  };

  /** Semantically validate a logical position (design §2.4 "never guess"). */
  const checkPos = (pos: LogicalPos | undefined, path: string): void => {
    if (!pos) return;
    if ("region" in pos) {
      if (!REGIONS.has(pos.region)) err(`${path}.region`, `unknown region "${pos.region}"`);
    } else if ("relativeTo" in pos) {
      const { id, anchor } = pos.relativeTo;
      if (!exists(id)) return err(`${path}.relativeTo.id`, `unknown object "${id}"`);
      if (anchor) {
        const ref = refOf(id);
        if (ref && !ctx.library.hasDynamicParts(ref) && !ctx.library.anchorsOf(ref).includes(anchor))
          err(`${path}.relativeTo.anchor`, `"${ref}" has no anchor/part "${anchor}"`);
      }
    } else if ("flow" in pos) {
      const id = pos.flow.split(":")[1];
      if (id && id !== "prev" && !exists(id)) err(`${path}.flow`, `unknown object "${id}"`);
    }
  };

  const introduce = (id: string, ref: string | undefined, path: string): void => {
    if (exists(id)) err(`${path}`, `id "${id}" already exists`);
    else introducedRefs.set(id, ref);
  };

  actions.forEach((a, i) => {
    const path = `$.actions[${i}]`;
    if (a.id) actionIds.add(a.id);
    switch (a.op) {
      case "speak":
        speakIds.add(a.id);
        break;
      case "place": {
        if (!ctx.library.has(a.ref)) err(`${path}.ref`, `unknown library ref "${a.ref}"`);
        checkPos(a.at, `${path}.at`);
        introduce(a.as, a.ref, `${path}.as`);
        break;
      }
      case "draw":
      case "remove":
        checkTarget(a.target, `${path}.target`);
        break;
      case "move":
        checkTarget(a.target, `${path}.target`);
        checkPos(a.to, `${path}.to`);
        break;
      case "annotate":
        if (a.target) checkTarget(a.target, `${path}.target`);
        checkPos(a.at, `${path}.at`);
        break;
      case "arrow":
      case "connect": {
        checkTarget(a.from, `${path}.from`);
        checkTarget(a.to, `${path}.to`);
        if (a.as) introduce(a.as, undefined, `${path}.as`);
        break;
      }
      case "label": {
        if (a.target) checkTarget(a.target, `${path}.target`);
        if (!a.target && !a.at) err(path, `"label" needs a target or a position`);
        checkPos(a.at, `${path}.at`);
        if (a.as) introduce(a.as, undefined, `${path}.as`);
        break;
      }
      case "group": {
        a.members.forEach((m, j) => checkTarget(m, `${path}.members[${j}]`));
        introduce(a.as, undefined, `${path}.as`);
        break;
      }
      case "highlight": {
        const targets = Array.isArray(a.target) ? a.target : [a.target];
        targets.forEach((t, j) => checkTarget(t, `${path}.target[${j}]`));
        break;
      }
      case "focus":
        if (a.target) checkTarget(a.target, `${path}.target`);
        checkPos(a.region, `${path}.region`);
        break;
      case "set_state": {
        checkTarget(a.target, `${path}.target`);
        const ref = refOf(baseId(a.target));
        if (!ref) err(`${path}.target`, `set_state needs a knowledge-object target, not "${a.target}"`);
        else if (!ctx.library.statesOf(ref).includes(a.state)) err(`${path}.state`, `"${ref}" has no state "${a.state}"`);
        break;
      }
      case "step": {
        checkTarget(a.target, `${path}.target`);
        const ref = refOf(baseId(a.target));
        if (!ref) err(`${path}.target`, `step needs a knowledge-object target, not "${a.target}"`);
        else if (!ctx.library.stepsOf(ref).includes(a.step)) err(`${path}.step`, `"${ref}" has no step "${a.step}"`);
        break;
      }
      default:
        break; // pause / wait_for_student / ask / expect / on_event: structural only in v0
    }

    // sync anchors must exist (speak ids or prior action ids in this program)
    const sync = (a as { sync?: unknown }).sync as { with?: string; after?: string } | undefined;
    if (sync?.with && !speakIds.has(sync.with)) err(`${path}.sync.with`, `unknown narration unit "${sync.with}"`);
    if (sync?.after && !actionIds.has(sync.after)) err(`${path}.sync.after`, `unknown action id "${sync.after}"`);
  });

  return { ok: errors.length === 0, errors };
}
