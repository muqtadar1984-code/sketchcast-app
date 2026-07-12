/**
 * The driver.js adapter: driving to the end reports complete; closing early
 * reports skip; each step is viewed. driver.js is mocked so we test OUR wiring,
 * not the library. Run: npx vitest run src/tour/__tests__/engine.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("driver.js/dist/driver.css", () => ({}));
vi.mock("driver.js", () => ({
  // A faithful-enough fake: destroy() runs onDestroyStarted then onDestroyed
  // exactly once (idempotent), matching the real callback protocol the adapter
  // relies on.
  driver: (cfg: Record<string, () => void> & { steps: unknown[] }) => {
    let idx = 0;
    let destroyed = false;
    const obj = {
      drive() {
        cfg.onHighlightStarted?.();
      },
      getActiveIndex() {
        return idx;
      },
      isLastStep() {
        return idx === (cfg.steps?.length ?? 0) - 1;
      },
      moveNext() {
        idx += 1;
        cfg.onHighlightStarted?.();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        cfg.onDestroyStarted?.();
        cfg.onDestroyed?.();
      },
    };
    (globalThis as unknown as { __cfg: unknown }).__cfg = cfg;
    return obj;
  },
}));

import { createDriverEngine } from "@/tour/engine";
import type { TourStep } from "@/tour/types";

const steps: TourStep[] = [
  { id: "a", target: "#a", title: "A", body: "b", order: 1 },
  { id: "b", target: "#b", title: "B", body: "b", order: 2 },
];

function cfg() {
  return (globalThis as unknown as { __cfg: Record<string, () => void> & { steps: unknown[] } }).__cfg;
}

describe("tour engine (driver.js adapter)", () => {
  beforeEach(() => {
    (globalThis as unknown as { __cfg: unknown }).__cfg = null;
  });

  it("views each step and completes when advanced to the end", () => {
    const views: number[] = [];
    let completed = false;
    let skippedAt: number | null = null;
    createDriverEngine().run(steps, {
      onStepView: (i) => views.push(i),
      onComplete: () => {
        completed = true;
      },
      onSkip: (i) => {
        skippedAt = i;
      },
    });
    expect(cfg().steps).toHaveLength(2);
    cfg().onNextClick(); // step 0 -> 1
    cfg().onNextClick(); // last -> complete
    expect(views).toEqual([0, 1]);
    expect(completed).toBe(true);
    expect(skippedAt).toBeNull();
  });

  it("reports a skip when closed before the end", () => {
    let completed = false;
    let skippedAt: number | null = null;
    createDriverEngine().run(steps, {
      onStepView: () => {},
      onComplete: () => {
        completed = true;
      },
      onSkip: (i) => {
        skippedAt = i;
      },
    });
    cfg().onCloseClick();
    expect(skippedAt).toBe(0);
    expect(completed).toBe(false);
  });
});
