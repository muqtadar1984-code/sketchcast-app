// SK S5 slice E — the §8.4 leader question bank (data in ./bank/*.json):
//   principal.json    60 grounded questions for the principal hat
//   coordinator.json  60 grounded questions for the grade-5 coordinator hat
//   unsupported.json  30 unsupported claims / out-of-scope asks
// EN / MS / AR throughout. Every grounded item names the capability that must
// answer it and the facts of the seeded tenant (tenant.ts) the answer must
// carry. Not a test file; validated by gates-bank.test.ts.

import principal from "./bank/principal.json";
import coordinator from "./bank/coordinator.json";
import unsupported from "./bank/unsupported.json";
import type { GateItem, GroundedItem, UnsupportedItem } from "./types";

export const PRINCIPAL_BANK = principal as GroundedItem[];
export const COORDINATOR_BANK = coordinator as GroundedItem[];
export const UNSUPPORTED_BANK = unsupported as UnsupportedItem[];

export const GATE_BANK: GateItem[] = [...PRINCIPAL_BANK, ...COORDINATOR_BANK, ...UNSUPPORTED_BANK];

/** The CI subset (~10 items): every role, rules and model paths, all three
 *  languages, a card, a scope refusal, a fabrication the guards must strip. */
export const CI_SUBSET_IDS = ["p-health-01", "p-risk-03", "p-seats-02", "p-cost-04", "p-notice-01", "c-risk-01", "c-risk-05", "c-trend-05", "c-tt-01", "u-coord-grade6-en", "u-address", "u-seat-limit"];

export const CI_SUBSET: GateItem[] = CI_SUBSET_IDS.map((id) => {
  const item = GATE_BANK.find((i) => i.id === id);
  if (!item) throw new Error(`CI subset: no bank item ${id}`);
  return item;
});
