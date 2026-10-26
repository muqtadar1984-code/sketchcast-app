// SK B4.1 — which of a unit's bank items a check asks, decided by code.
//
// The B3 packager's graph carries no check/practice ids yet (its
// `checks.item_indexes` point into the worker's draft), so when a unit's
// assets list none the loop asks the ItemBank for the unit's items and this
// module picks, deterministically, so a replayed event and a second server
// agree on the same ids:
//
//   * order: approved before draft (unknown status last), then ascending
//     difficulty (unknown last), then id — the same list in, the same list out;
//   * a CHECK (the 2-item skip check, the unit check) asks only items that are
//     deterministic to grade AND map to a teaching objective — an unmapped
//     item gives no mastery evidence (plan §14), so it is never the evidence;
//   * a check needs at least MIN_CHECK_ITEMS; with fewer the unit has no check
//     and the planner's existing path applies (skip "records no mastery");
//   * PRACTICE is every gradeable item the unit check did not take, mapped or
//     not — practice is assisted evidence, never mastery.
//
// Ids the graph carries stay authoritative; this runs only for a unit whose
// graph asset has none.

import type { BankItem } from "./items";

/** A unit check from the bank asks this many items unless the graph says
 * otherwise (the stand-in graph's unit checks carry 3; a unit with fewer
 * gradeable, mapped items asks what it has, down to MIN_CHECK_ITEMS). */
export const DEFAULT_UNIT_CHECK_ITEMS = 3;
/** Below this a check is not opened at all: an empty or one-item check is no
 * evidence. Equals the planner's SKIP_CHECK_ITEMS (the skip check is the
 * first two of the unit check). */
export const MIN_CHECK_ITEMS = 2;

/** The ids a unit's checks and practice would use, as the planner reads them. */
export type UnitItems = {
  /** The unit check; the skip check is its first SKIP_CHECK_ITEMS. Empty = no check. */
  check: string[];
  /** Practice: every gradeable item the unit check did not take. */
  practice: string[];
  reasons: string[];
};

/** Item types `gradeItem` marks deterministically (short/subjective need a reviewer). */
export const DETERMINISTIC_TYPES: ReadonlySet<BankItem["type"]> = new Set(["mcq", "true_false", "fill_blank", "match"]);
export const isDeterministic = (q: BankItem): boolean => DETERMINISTIC_TYPES.has(q.type);
export const isMapped = (q: BankItem): boolean => typeof q.teachingObjectiveId === "string" && q.teachingObjectiveId.length > 0;

const statusRank = (q: BankItem) => (q.status === "approved" ? 0 : q.status === "draft" ? 1 : 2);
const difficultyRank = (q: BankItem) => (typeof q.difficulty === "number" && Number.isFinite(q.difficulty) ? q.difficulty : Number.POSITIVE_INFINITY);

/** The stable order: approved → draft → unknown; easy → hard → unknown; then id. */
export function orderBankItems(items: readonly BankItem[]): BankItem[] {
  return [...items].sort((a, b) => statusRank(a) - statusRank(b) || difficultyRank(a) - difficultyRank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function selectUnitItems(items: readonly BankItem[], opts: { unitCheckSize?: number } = {}): UnitItems {
  const size = Math.max(MIN_CHECK_ITEMS, Math.floor(opts.unitCheckSize ?? DEFAULT_UNIT_CHECK_ITEMS));
  const ordered = orderBankItems(items);
  const gradeable = ordered.filter(isDeterministic);
  const checkable = gradeable.filter(isMapped);
  const reasons: string[] = [`bank: ${items.length} item(s), ${gradeable.length} deterministic, ${checkable.length} mapped to an objective`];
  if (checkable.length < MIN_CHECK_ITEMS) {
    reasons.push(`fewer than ${MIN_CHECK_ITEMS} checkable items: no check for this unit`);
    return { check: [], practice: gradeable.map((q) => q.id), reasons };
  }
  const check = checkable.slice(0, size).map((q) => q.id);
  const taken = new Set(check);
  const practice = gradeable.filter((q) => !taken.has(q.id)).map((q) => q.id);
  reasons.push(`unit check ${check.length} item(s) (size ${size}), practice ${practice.length}`);
  return { check, practice, reasons };
}
