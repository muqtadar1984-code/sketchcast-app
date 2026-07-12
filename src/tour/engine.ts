"use client";

// The ONLY module that imports the tour library. Everything else (definitions,
// provider, call sites, tests) talks to the TourEngine interface, so swapping
// driver.js for shepherd.js/other is a one-file change.

import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import type { TourStep } from "./types";

export type EngineCallbacks = {
  onStepView: (index: number, step: TourStep) => void;
  onSkip: (index: number) => void;
  onComplete: () => void;
};

export interface TourEngine {
  /** Run the given (already-resolved, all-valid) steps. */
  run(steps: TourStep[], cb: EngineCallbacks, opts?: { animate?: boolean }): void;
  stop(): void;
}

function sideFor(p: TourStep["placement"]): "top" | "bottom" | "left" | "right" | undefined {
  return p && p !== "auto" ? p : undefined;
}

export function createDriverEngine(): TourEngine {
  let d: Driver | null = null;

  return {
    run(steps, cb, opts) {
      if (!steps.length) return;
      let completed = false;
      let destroying = false;

      d = driver({
        showProgress: steps.length > 1,
        allowClose: true,
        animate: opts?.animate ?? true,
        overlayColor: "#14181F",
        nextBtnText: "Next",
        prevBtnText: "Back",
        doneBtnText: "Done",
        steps: steps.map((s) => ({
          element: s.target || undefined, // undefined → centered popover
          popover: {
            title: s.title,
            description: s.body,
            side: sideFor(s.placement),
            align: "start",
          },
        })),
        onHighlightStarted: () => {
          const i = d?.getActiveIndex() ?? 0;
          const step = steps[i];
          if (step) cb.onStepView(i, step);
        },
        onNextClick: () => {
          if (d?.isLastStep()) {
            completed = true;
            d?.destroy();
          } else {
            d?.moveNext();
          }
        },
        onCloseClick: () => d?.destroy(),
        // driver requires us to call destroy() ourselves once we've decided.
        onDestroyStarted: () => {
          if (destroying) return;
          destroying = true;
          if (!completed) cb.onSkip(d?.getActiveIndex() ?? 0);
          d?.destroy();
        },
        onDestroyed: () => {
          if (completed) cb.onComplete();
          d = null;
        },
      });
      d.drive();
    },

    stop() {
      d?.destroy();
      d = null;
    },
  };
}
