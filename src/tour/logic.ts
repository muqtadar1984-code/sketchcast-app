// Pure tour logic — no DOM, no library, no React. Kept separate so the
// load-bearing decisions (version gate, missing-target handling) are unit-tested
// directly.

import type { TourSeen, TourStep } from "./types";

/** Version-aware auto-start gate (Section 8): auto-start only when the user has
 * never completed/skipped this tour, OR last saw an OLDER version — so bumping a
 * definition's `version` re-shows the improved tour to everyone. */
export function shouldAutoStart(seen: TourSeen | null | undefined, currentVersion: number): boolean {
  if (!seen || seen.version == null) return true;
  return seen.version < currentVersion;
}

/** Split steps into those whose target exists right now vs. those missing
 * (Section 5 graceful degradation). An empty target is an intentional centered
 * step and is always valid. `exists` is injected so this stays pure + testable
 * without a DOM. */
export function resolveSteps(
  steps: TourStep[],
  exists: (target: string) => boolean,
): { valid: TourStep[]; missing: TourStep[] } {
  const valid: TourStep[] = [];
  const missing: TourStep[] = [];
  for (const s of steps) {
    if (!s.target || exists(s.target)) valid.push(s);
    else missing.push(s);
  }
  return { valid, missing };
}
