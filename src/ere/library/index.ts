// The Phase-0 starter library — enough curated Tier-1 objects to teach one real
// chapter per anchor subject (design §9 deliverable 5). Growth is curated:
// Tier-2 composes from primitives; Tier-3 (generated) is quarantined elsewhere.

import { BIOLOGY } from "./biology";
import { PHYSICS } from "./physics";
import { ALGORITHMS } from "./algorithms";
import { Library } from "../ko/library";
import type { KnowledgeObject } from "../ko/types";

export { BIOLOGY, PHYSICS, ALGORITHMS };
export const STARTER_OBJECTS: KnowledgeObject[] = [...BIOLOGY, ...PHYSICS, ...ALGORITHMS];

/** A ready Library with the primitive kit + the three-subject starter set. */
export function starterLibrary(): Library {
  return new Library(STARTER_OBJECTS);
}
