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

/** What the driver.js provider does for this user (founder 2026-10-30,
 * decision 1): for an SK user the SK walkthrough REPLACES the role tour — it
 * never auto-starts, and the header's "Take a tour" starts SK's walkthrough
 * instead (so the button shows even with the driver.js flag off). Everyone
 * else keeps the driver.js tour exactly as before. */
export function driverTourMode(opts: { flagOn: boolean; hasTour: boolean; skWalkthrough: boolean }): {
  available: boolean;
  autoStart: boolean;
  replayVia: "driver" | "sk";
} {
  if (opts.skWalkthrough) return { available: true, autoStart: false, replayVia: "sk" };
  const available = opts.flagOn && opts.hasTour;
  return { available, autoStart: available, replayVia: "driver" };
}
