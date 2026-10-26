// SK B4 — the deterministic route planner (plan §3). The LLM only turns the
// student's words into one of these requests; everything below is code, and
// every decision carries its reasons so a reviewer (or the student) can read
// why SK went where it went.
//
// Rules pinned here:
//   * prerequisites WARN, never block ("U4 uses U2's idea; quick check first?");
//   * a skip counts as mastery only through a 2-item check; skipping without
//     the check records nothing;
//   * the next validated asset is preferred (alt_visual after a failed check);
//   * generation happens only when nothing fits, and then climbs the ladder:
//       1 approved demonstration from any accessible unit,
//       2 a simpler live drawing built only from validated parts,
//       3 a grounded spoken/text explanation with no new diagram.
//     A visual that would need unverified science or maths stops at rung 3.

import { cursorFor, mainAsset, unitOf } from "./graph";
import type { Bookmark, Cursor, ExplainStyle, GraphAsset, GraphUnit, MasteryMap, MasteryState, TeachingGraph } from "./types";

export const SKIP_CHECK_ITEMS = 2;
export const DEFAULT_PRACTISE_N = 3;

export type RouteRequest =
  | { name: "next" }
  | { name: "skip"; unitKey?: string; withCheck: boolean }
  | { name: "goto"; unitKey: string }
  | { name: "practise"; unitKey?: string; n?: number }
  | { name: "return" }
  | { name: "explain_again"; unitKey?: string; style?: ExplainStyle }
  | { name: "check_me"; unitKey?: string };

export type PlannerContext = {
  graph: TeachingGraph;
  cursor: Cursor;
  mastery: MasteryMap;
  bookmarks: Bookmark[];
  /** Units the student may access (entitlement); default = every unit. */
  accessibleUnitKeys?: string[];
  /** The student just failed a check on the current unit → prefer alt/visual. */
  lastCheckFailed?: boolean;
  /** Set by the caller when the request needs new scientific or mathematical
   * content that no validated part carries (stops the ladder at rung 3). */
  needsUnverifiedContent?: boolean;
};

export type LadderRung = 1 | 2 | 3;

export type SuggestedCheck = { unitKey: string; itemIds: string[]; purpose: "prereq" };

export type Decision =
  | { kind: "present"; unitKey: string; asset: GraphAsset; cursor: Cursor; bookmark: boolean; warning?: string; suggestedCheck?: SuggestedCheck; reasons: string[] }
  | { kind: "check"; unitKey: string; itemIds: string[]; purpose: "skip" | "unit" | "practise"; cursor: Cursor; bookmark: boolean; reasons: string[] }
  | { kind: "return"; cursor: Cursor; reasons: string[] }
  | { kind: "generate"; unitKey: string; rung: LadderRung; basis: { assetId?: string; figures?: string[] }; cursor: Cursor; bookmark: boolean; reasons: string[] }
  | { kind: "none"; reasons: string[] };

const mastered = (m: MasteryMap, key: string) => m[key]?.status === "mastered";

function accessible(ctx: PlannerContext): GraphUnit[] {
  const allow = ctx.accessibleUnitKeys ? new Set(ctx.accessibleUnitKeys) : null;
  return ctx.graph.units.filter((u) => !allow || allow.has(u.unit_key));
}

function currentUnit(ctx: PlannerContext): GraphUnit | undefined {
  return unitOf(ctx.graph, ctx.cursor.unitKey);
}

/** Prerequisites the student has not mastered, in graph order. */
export function unmetPrereqs(ctx: PlannerContext, unit: GraphUnit): GraphUnit[] {
  return unit.prereqs.map((k) => unitOf(ctx.graph, k)).filter((u): u is GraphUnit => !!u && !mastered(ctx.mastery, u.unit_key));
}

function prereqWarning(ctx: PlannerContext, unit: GraphUnit): { warning: string; suggestedCheck?: SuggestedCheck } | null {
  const missing = unmetPrereqs(ctx, unit);
  if (!missing.length) return null;
  const first = missing[0]!;
  const check = checkAsset(first);
  const warning = `${unit.title} uses ${first.title}'s idea; quick check first?`;
  return check ? { warning, suggestedCheck: { unitKey: first.unit_key, itemIds: check.item_ids!.slice(0, SKIP_CHECK_ITEMS), purpose: "prereq" } } : { warning };
}

export const checkAsset = (u: GraphUnit): GraphAsset | undefined => u.assets.find((a) => a.kind === "check" && a.item_ids?.length);
export const practiceAsset = (u: GraphUnit): GraphAsset | undefined => u.assets.find((a) => a.kind === "practice" && a.item_ids?.length);

/** A prepared, validated teaching asset: the only kind the planner presents without the ladder. */
const isValidated = (a: GraphAsset) => !!a.segment && (a.origin ?? "prepared") === "prepared" && a.validation !== "fail" && a.validation !== "pending";

/** The unit after `unit` in graph order, within the accessible set. */
function nextUnit(ctx: PlannerContext, unit: GraphUnit): GraphUnit | undefined {
  const units = accessible(ctx);
  const i = units.findIndex((u) => u.unit_key === unit.unit_key);
  return i >= 0 ? units[i + 1] : units.find((u) => u.order > unit.order);
}

function present(ctx: PlannerContext, unit: GraphUnit, asset: GraphAsset, bookmark: boolean, reasons: string[]): Decision {
  const pre = prereqWarning(ctx, unit);
  if (pre) reasons.push(`prerequisite not mastered: ${unmetPrereqs(ctx, unit).map((u) => u.unit_key).join(", ")} (warn, not block)`);
  return { kind: "present", unitKey: unit.unit_key, asset, cursor: cursorFor(ctx.graph, unit, asset), bookmark, reasons, ...(pre ?? {}) };
}

/** Pick the best validated explanation for a unit given the wanted style. */
export function pickExplanation(unit: GraphUnit, want: ExplainStyle | undefined, exclude: string | undefined, afterFailedCheck: boolean): GraphAsset | undefined {
  const pool = unit.assets.filter((a) => (a.kind === "explain" || a.kind === "alt") && isValidated(a) && a.asset_id !== exclude);
  if (!pool.length) return undefined;
  const byStyle = (s: string) => pool.find((a) => (a.style ?? (a.kind === "explain" ? "main" : "")) === s);
  if (want) return byStyle(want);
  // After a failed check a visual alternative teaches better than the same words again (plan §3).
  if (afterFailedCheck) return byStyle("visual") ?? byStyle("simpler") ?? pool[0];
  return byStyle("simpler") ?? byStyle("visual") ?? pool[0];
}

/** The safe-generation ladder as an explicit decision (plan §3, R3). */
export function ladder(ctx: PlannerContext, unit: GraphUnit, exclude?: string): { rung: LadderRung; basis: { assetId?: string; figures?: string[] }; reasons: string[] } {
  const reasons: string[] = [];
  // Rung 1: an approved demonstration from any unit the student may access
  // that teaches the SAME objective (another unit's demo on a different
  // objective would not be a fit, however well made).
  const sameObjective = accessible(ctx).filter((u) => u.teaching_objective_id === unit.teaching_objective_id);
  for (const u of sameObjective) {
    const demo = u.assets.find((a) => a.asset_id !== exclude && (a.kind === "demo" || a.kind === "example") && isValidated(a));
    if (demo) {
      reasons.push(`rung 1: approved demonstration ${demo.asset_id} from ${u.unit_key} teaches the same objective`);
      return { rung: 1, basis: { assetId: demo.asset_id }, reasons };
    }
  }
  reasons.push("rung 1 unavailable: no approved demonstration for this objective");
  // Rung 2: a simpler live drawing from validated parts only.
  if (ctx.needsUnverifiedContent) {
    reasons.push("rung 2 refused: the request needs unverified scientific or mathematical content");
  } else if (unit.figures.length) {
    reasons.push(`rung 2: live drawing from ${unit.figures.length} validated figure(s)`);
    return { rung: 2, basis: { figures: [...unit.figures] }, reasons };
  } else {
    reasons.push("rung 2 unavailable: the unit has no validated figures to draw from");
  }
  reasons.push("rung 3: grounded spoken explanation, no new diagram");
  return { rung: 3, basis: {}, reasons };
}

function generate(ctx: PlannerContext, unit: GraphUnit, bookmark: boolean, reasons: string[], exclude?: string): Decision {
  const l = ladder(ctx, unit, exclude);
  const anchor = mainAsset(unit) ?? unit.assets[0];
  const cursor = anchor ? cursorFor(ctx.graph, unit, anchor, ctx.cursor.unitKey === unit.unit_key ? ctx.cursor.t : 0) : ctx.cursor;
  return { kind: "generate", unitKey: unit.unit_key, rung: l.rung, basis: l.basis, cursor, bookmark, reasons: [...reasons, ...l.reasons] };
}

export function plan(ctx: PlannerContext, req: RouteRequest): Decision {
  const g = ctx.graph;
  const here = currentUnit(ctx);
  const reasons: string[] = [];
  const target = (key: string | undefined): GraphUnit | undefined => (key ? unitOf(g, key) : here);

  switch (req.name) {
    case "next": {
      if (!here) return { kind: "none", reasons: ["cursor names no unit"] };
      // Within the unit: a check after the main explanation, before moving on.
      const check = checkAsset(here);
      const onCheck = ctx.cursor.assetId === check?.asset_id;
      if (check && !onCheck && !mastered(ctx.mastery, here.unit_key) && !ctx.lastCheckFailed) {
        reasons.push(`unit ${here.unit_key} not yet mastered: run its check before moving on`);
        return { kind: "check", unitKey: here.unit_key, itemIds: [...check.item_ids!], purpose: "unit", cursor: cursorFor(g, here, check), bookmark: false, reasons };
      }
      const nxt = nextUnit(ctx, here);
      if (!nxt) return { kind: "none", reasons: ["end of chapter: no next unit"] };
      const asset = mainAsset(nxt);
      if (!asset) return generate(ctx, nxt, false, [`unit ${nxt.unit_key} has no validated explanation`]);
      reasons.push(`default guided path: ${here.unit_key} → ${nxt.unit_key}`);
      return present(ctx, nxt, asset, false, reasons);
    }

    case "goto": {
      const unit = unitOf(g, req.unitKey);
      if (!unit) return { kind: "none", reasons: [`unknown unit ${req.unitKey}`] };
      if (!accessible(ctx).includes(unit)) return { kind: "none", reasons: [`unit ${unit.unit_key} is outside the student's access`] };
      const asset = mainAsset(unit);
      reasons.push(`student asked for ${unit.unit_key}; bookmark pushed so "return" comes back here`);
      if (!asset) return generate(ctx, unit, true, [...reasons, `unit ${unit.unit_key} has no validated explanation`]);
      return present(ctx, unit, asset, true, reasons);
    }

    case "skip": {
      const unit = target(req.unitKey);
      if (!unit) return { kind: "none", reasons: ["nothing to skip"] };
      const nxt = nextUnit(ctx, unit);
      const check = checkAsset(unit);
      if (req.withCheck && check) {
        reasons.push(`skip counts only with a ${SKIP_CHECK_ITEMS}-item check on ${unit.unit_key}; passing records independent evidence`);
        return { kind: "check", unitKey: unit.unit_key, itemIds: check.item_ids!.slice(0, SKIP_CHECK_ITEMS), purpose: "skip", cursor: cursorFor(g, unit, check), bookmark: true, reasons };
      }
      reasons.push(req.withCheck ? `unit ${unit.unit_key} has no check items; skipping records NO mastery` : `skip without check: records no mastery for ${unit.unit_key}`);
      if (!nxt) return { kind: "none", reasons: [...reasons, "end of chapter: no next unit"] };
      const asset = mainAsset(nxt);
      if (!asset) return generate(ctx, nxt, true, [...reasons, `unit ${nxt.unit_key} has no validated explanation`]);
      return present(ctx, nxt, asset, true, reasons);
    }

    case "practise": {
      const unit = target(req.unitKey);
      if (!unit) return { kind: "none", reasons: ["no unit to practise"] };
      const n = Math.max(1, Math.min(10, req.n ?? DEFAULT_PRACTISE_N));
      const practice = practiceAsset(unit);
      if (practice) {
        reasons.push(`practice items for ${unit.unit_key} (${Math.min(n, practice.item_ids!.length)} of ${practice.item_ids!.length}); practice evidence is assisted, never mastery`);
        return { kind: "check", unitKey: unit.unit_key, itemIds: practice.item_ids!.slice(0, n), purpose: "practise", cursor: cursorFor(g, unit, practice), bookmark: true, reasons };
      }
      return generate(ctx, unit, true, [`unit ${unit.unit_key} has no practice items`]);
    }

    case "check_me": {
      const unit = target(req.unitKey);
      if (!unit) return { kind: "none", reasons: ["no unit to check"] };
      const check = checkAsset(unit);
      if (!check) return { kind: "none", reasons: [`unit ${unit.unit_key} has no check items`] };
      reasons.push(`mastery check for ${unit.unit_key}: ${check.item_ids!.length} deterministic items`);
      return { kind: "check", unitKey: unit.unit_key, itemIds: [...check.item_ids!], purpose: "unit", cursor: cursorFor(g, unit, check), bookmark: true, reasons };
    }

    case "return": {
      const bm = ctx.bookmarks.at(-1);
      if (!bm) return { kind: "none", reasons: ["no bookmark to return to"] };
      const { boardSnapshotId: _snap, ...cursor } = bm;
      void _snap;
      reasons.push(`popping bookmark → ${bm.unitKey}/${bm.assetId} @ ${bm.t} ms (board snapshot ${bm.boardSnapshotId ?? "none"})`);
      return { kind: "return", cursor, reasons };
    }

    case "explain_again": {
      const unit = target(req.unitKey);
      if (!unit) return { kind: "none", reasons: ["no unit to explain"] };
      const exclude = unit.unit_key === ctx.cursor.unitKey ? ctx.cursor.assetId : undefined;
      const asset = pickExplanation(unit, req.style, exclude, !!ctx.lastCheckFailed);
      if (asset) {
        reasons.push(`validated ${asset.kind}/${asset.style ?? "main"} fits ${req.style ? `the requested style "${req.style}"` : ctx.lastCheckFailed ? "a failed check (visual first)" : "a re-explanation"}`);
        return present(ctx, unit, asset, true, reasons);
      }
      return generate(ctx, unit, true, [`no validated asset of style "${req.style ?? "any"}" for ${unit.unit_key} besides the current one`], exclude);
    }
  }
  return { kind: "none", reasons: ["unknown request"] };
}

/** Fold a closed check into mastery. Practice never changes mastery (assisted
 * evidence only); a skip/unit check marks mastered only when passed, and
 * `independent` is carried exactly as the check recorded it. */
export function applyCheckToMastery(m: MasteryMap, unitKey: string, purpose: "skip" | "prereq" | "unit" | "practise", results: boolean[], independent: boolean): MasteryMap {
  const prev: MasteryState = m[unitKey] ?? { status: "unknown", independent: false, evidence: { correct: 0, total: 0 } };
  const correct = results.filter(Boolean).length;
  const evidence = { correct: prev.evidence.correct + correct, total: prev.evidence.total + results.length };
  if (purpose === "practise") return { ...m, [unitKey]: { ...prev, status: prev.status === "unknown" ? "in_progress" : prev.status, evidence } };
  const passed = results.length > 0 && results.every(Boolean);
  return { ...m, [unitKey]: { status: passed ? "mastered" : "needs_work", independent: passed ? independent : prev.independent, evidence } };
}
