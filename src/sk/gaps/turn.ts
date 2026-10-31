// SK gap tracker — one turn's misses, collected while the turn runs and
// written ONCE when it ends (the turn route's finish(), through after(), so
// the reply is never slowed). One row per signal per turn (0177's unique
// (turn_id, signal)): repeats of a signal within the turn become `items` of
// that one row's context. Signal D (the phrase net) is added at the end only
// when no other signal fired.
//
// PURE apart from the types: the route supplies the base fields.

import { cantPhrase } from "./phrases";
import type { SkGapInput, SkGapSignal } from "./store";

/** Items per signal, and characters per string inside an item. */
export const GAP_ITEMS_MAX = 10;
const STR_MAX = 300;
const LIST_MAX = 20;

/** Shallow-clean one context item: strings cut, arrays shortened, no functions. */
function cleanItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) continue;
    if (typeof v === "string") out[k] = v.slice(0, STR_MAX);
    else if (Array.isArray(v)) out[k] = v.slice(0, LIST_MAX).map((x) => (typeof x === "string" ? x.slice(0, STR_MAX) : x));
    else if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else {
      try {
        out[k] = JSON.parse(JSON.stringify(v).slice(0, 1000));
      } catch {
        out[k] = String(v).slice(0, STR_MAX);
      }
    }
  }
  return out;
}

export type TurnGapBase = Omit<SkGapInput, "signal" | "wanted" | "context">;

export class TurnGaps {
  private readonly bySignal = new Map<SkGapSignal, { wanted: string | null; items: Record<string, unknown>[] }>();

  /** Note one miss. `wanted` (sk.note_gap / 👎) is kept from the first note. */
  note(signal: SkGapSignal, item: Record<string, unknown>, wanted?: string | null): void {
    const cur = this.bySignal.get(signal) ?? { wanted: null, items: [] };
    if (!cur.wanted && wanted && wanted.trim()) cur.wanted = wanted.trim().slice(0, 500);
    if (cur.items.length < GAP_ITEMS_MAX) cur.items.push(cleanItem(item));
    this.bySignal.set(signal, cur);
  }

  get signals(): SkGapSignal[] {
    return [...this.bySignal.keys()];
  }

  /** The rows for this turn: every noted signal, plus `phrase` when nothing
   *  else fired and the reply reads as "I can't …". */
  rows(base: TurnGapBase): SkGapInput[] {
    const out: SkGapInput[] = [...this.bySignal.entries()].map(([signal, g]) => ({ ...base, signal, wanted: g.wanted, context: { items: g.items } }));
    if (!out.length) {
      const p = cantPhrase(base.reply);
      if (p) out.push({ ...base, signal: "phrase", wanted: null, context: { items: [{ lang: p.lang, match: p.match }] } });
    }
    return out;
  }
}
