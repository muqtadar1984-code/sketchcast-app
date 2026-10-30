/**
 * The walkthrough hook reports every stop to the function log (2026-10-30:
 * "the tour skipped the readymade kits section" — the reason only ever
 * reached the browser console). Source pins: vitest collects no .tsx and the
 * hook needs a real DOM; the event shape itself is tested in
 * src/sk/shell/client/__tests__/tour-log.test.ts.
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/sk-walk-log.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Code only: comments may name what the code must not do. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const walk = code(readFileSync(resolve(__dirname, "..", "sk-walkthrough.tsx"), "utf8"));

describe("useSkWalkthrough logs each stop", () => {
  it("keeps its own voice-log instance, flushed on pagehide and disposed on unmount", () => {
    expect(walk).toMatch(/const log = createVoiceLog\(\{ send: beaconVoiceEvents \}\);/);
    expect(walk).toMatch(/window\.addEventListener\("pagehide", onPageHide\);/);
    expect(walk).toMatch(/log\.dispose\(\);/);
    expect(walk).toMatch(/logRef\.current\?\.push\(tourEvent\(\{ stop, route, outcome, ms, page \}\)\);/);
  });

  it("a skipped stop: missing vs cap from the wait, the loading signal still visible, next to the debug line", () => {
    const skip = walk.slice(walk.indexOf("if (!hit) {"), walk.indexOf("missingStop(cur)"));
    expect(skip).toMatch(/const outcome = skipOutcome\(waited, SETTLE_CAP_MS\);/);
    expect(skip).toMatch(/tourPageState\(\{ pathOk: window\.location\.pathname === target, ready: document\.readyState === "complete", loading: loadingSignal\(\) \}, outcome\)/);
    expect(skip).toMatch(/debug\(/);
    expect(skip).toMatch(/logStop\(s\.id, s\.route, outcome, waited, page\);/);
  });

  it("a shown stop is logged with the time from the navigation to the highlight", () => {
    const t0 = walk.indexOf("const t0 = Date.now();");
    const push = walk.indexOf("router.push(s.route)");
    expect(t0).toBeGreaterThan(0);
    expect(t0).toBeLessThan(push);
    const shown = walk.slice(walk.indexOf("setMatch(m);"), walk.indexOf("const text = lineOfRef.current(w, m);"));
    expect(shown).toMatch(/logStop\(s\.id, s\.route, "shown", Date\.now\(\) - t0, /);
  });

  it("leaving the stop's page is logged as 'away' before the tour pauses", () => {
    const away = walk.slice(walk.indexOf("if (pathname && pathname !== routePath(s.route)) {"), walk.indexOf('pauseWalk(cur, "away")'));
    expect(away).toMatch(/logStop\(s\.id, s\.route, "away", /);
  });

  it("the settled-page probe still uses the same loading signals", () => {
    expect(walk).toMatch(/const loadingVisible = \(\): boolean => loadingSignal\(\) !== null;/);
    expect(walk).toMatch(/loading: loadingVisible,/);
  });
});
