import { describe, it, expect } from "vitest";
import {
  probeStatic,
  newObservations,
  observePointer,
  observeCoalesced,
  tierFor,
  profileFor,
  pressureVaries,
  sawPen,
  coalescedMean,
  percentile,
  mean,
  type StaticCaps,
  type Observations,
} from "../capabilities";

// A device that can do everything. Tests below take this and REMOVE one thing,
// so a capability that stops mattering fails loudly here rather than silently
// promoting a panel a tier.
const bestCase: StaticCaps = {
  pointerEvents: true,
  coalesced: true,
  predicted: true,
  desynchronized: true,
  maxTouchPoints: 10,
  coarsePointer: true,
  anyHover: false,
  devicePixelRatio: 2,
  screen: { width: 3840, height: 2160 },
  hardwareConcurrency: 8,
  deviceMemory: 8,
  offscreenCanvas: true,
  indexedDB: true,
  userAgent: "test",
  uaPlatform: "Android",
  uaMobile: false,
};

/** Draw with a real pressure-sensitive pen. */
function penStroke(obs: Observations, seen: { pressure: Set<number>; size: Set<number> }) {
  for (let i = 0; i < 20; i++) {
    observePointer(obs, { pointerType: "pen", pressure: 0.2 + i * 0.03, tiltX: 5 }, seen);
  }
  obs.strokes++;
}

/** Draw with a finger on a panel that reports a constant pressure — the norm. */
function fingerStroke(obs: Observations, seen: { pressure: Set<number>; size: Set<number> }) {
  for (let i = 0; i < 20; i++) {
    observePointer(obs, { pointerType: "touch", pressure: 0.5, width: 30, height: 30 }, seen);
  }
  obs.strokes++;
}

const fresh = () => ({
  obs: newObservations(),
  seen: { pressure: new Set<number>(), size: new Set<number>() },
});

describe("tier selection", () => {
  it("refuses Tier A until a stroke has proved pressure is real", () => {
    // THE CASE THIS MODULE EXISTS FOR. Every interactive panel advertises
    // pressure through the pointer API; most then report a constant 0.5 for
    // ever. A board that trusted the static capability would pick pressure-
    // varied width on a device that cannot vary it, and every line would come
    // out the same weight while the code believed otherwise.
    const { obs } = fresh();
    expect(tierFor(bestCase, obs)).toBe("B");
  });

  it("promotes to Tier A once a pen writes with genuinely varying pressure", () => {
    const { obs, seen } = fresh();
    penStroke(obs, seen);
    expect(sawPen(obs)).toBe(true);
    expect(pressureVaries(obs)).toBe(true);
    expect(tierFor(bestCase, obs)).toBe("A");
    expect(profileFor(bestCase, obs).widthFrom).toBe("pressure");
  });

  it("keeps a constant-pressure panel on Tier B however many strokes it sees", () => {
    const { obs, seen } = fresh();
    for (let i = 0; i < 5; i++) fingerStroke(obs, seen);
    expect(pressureVaries(obs)).toBe(false);
    expect(tierFor(bestCase, obs)).toBe("B");
    expect(profileFor(bestCase, obs).widthFrom).toBe("velocity");
  });

  it("drops to Tier C when coalesced events are missing, whatever else is true", () => {
    // No getCoalescedEvents means one point per frame no matter how good the pen
    // is, so this outranks every other signal — including a pen that HAS proved
    // its pressure.
    const { obs, seen } = fresh();
    penStroke(obs, seen);
    expect(tierFor({ ...bestCase, coalesced: false }, obs)).toBe("C");
    expect(profileFor({ ...bestCase, coalesced: false }, obs).smoothing).toBe("heavy");
  });

  it("holds a pen at Tier B when the canvas refused desynchronized", () => {
    const { obs, seen } = fresh();
    penStroke(obs, seen);
    expect(tierFor({ ...bestCase, desynchronized: false }, obs)).toBe("B");
  });
});

describe("capture profile", () => {
  it("makes finger drawing the default when no pen has ever been seen", () => {
    // The consequence of "runs on any device": with no pen to prefer, palm
    // rejection loses its best signal, so touch MUST draw by default and the
    // tool rail owes the teacher an explicit toggle.
    const { obs, seen } = fresh();
    fingerStroke(obs, seen);
    const p = profileFor(bestCase, obs);
    expect(p.touchDrawsDefault).toBe(true);
    expect(p.penOnly).toBe(false);
  });

  it("switches to pen-only the moment a pen appears", () => {
    const { obs, seen } = fresh();
    fingerStroke(obs, seen);
    penStroke(obs, seen);
    const p = profileFor(bestCase, obs);
    expect(p.penOnly).toBe(true);
    expect(p.touchDrawsDefault).toBe(false);
  });

  it("leaves prediction off until Phase 0 has measured it", () => {
    // The capability is RECORDED; the decision is not made here. Turning this on
    // by default would ship smearing to a classroom on the strength of a feature
    // detect.
    const { obs, seen } = fresh();
    penStroke(obs, seen);
    expect(bestCase.predicted).toBe(true);
    expect(profileFor(bestCase, obs).usePrediction).toBe(false);
  });
});

describe("observation", () => {
  it("ignores pressure 0 so a mouse never looks pressure-sensitive", () => {
    // A mouse reports 0 while up and 0.5 while down; many touch panels report a
    // bare 0. Counting zeros would let one stray sample fake a spread.
    const { obs, seen } = fresh();
    for (let i = 0; i < 10; i++) observePointer(obs, { pointerType: "mouse", pressure: 0 }, seen);
    expect(obs.pressureDistinct).toBe(0);
    expect(pressureVaries(obs)).toBe(false);
  });

  it("only calls contact size varying when it actually moves", () => {
    const { obs, seen } = fresh();
    for (let i = 0; i < 10; i++)
      observePointer(obs, { pointerType: "touch", width: 30, height: 30 }, seen);
    expect(obs.contactSizeVaries).toBe(false);
    observePointer(obs, { pointerType: "touch", width: 55, height: 60 }, seen);
    expect(obs.contactSizeVaries).toBe(true);
  });

  it("records how much input a single pointermove was hiding", () => {
    const obs = newObservations();
    for (const n of [1, 4, 9, 2]) observeCoalesced(obs, n);
    expect(obs.coalescedMax).toBe(9);
    expect(coalescedMean(obs)).toBe(4);
  });

  it("counts each distinct pointer type once", () => {
    const { obs, seen } = fresh();
    fingerStroke(obs, seen);
    penStroke(obs, seen);
    fingerStroke(obs, seen);
    expect(obs.pointerTypes.sort()).toEqual(["pen", "touch"]);
  });
});

describe("static probe", () => {
  it("survives a host with nothing on it", () => {
    // A headless render, an old WebView missing matchMedia — the probe must
    // return a pessimistic record, never throw. A crash here would take the
    // whole board down before a stroke was drawn.
    const caps = probeStatic({});
    expect(caps.pointerEvents).toBe(false);
    expect(caps.coalesced).toBe(false);
    expect(caps.desynchronized).toBe(false);
    expect(caps.devicePixelRatio).toBe(1);
    expect(tierFor(caps, newObservations())).toBe("C");
  });

  it("treats a canvas with no getContextAttributes as NOT desynchronized", () => {
    // Old WebViews accept the attribute and ignore it. Believing the request
    // was honoured is how a panel gets promoted a tier it cannot sustain.
    const host = {
      document: {
        createElement: () => ({ getContext: () => ({}) }),
      },
    };
    expect(probeStatic(host).desynchronized).toBe(false);
  });

  it("reads desynchronized back off the context rather than trusting the ask", () => {
    const host = {
      document: {
        createElement: () => ({
          getContext: () => ({ getContextAttributes: () => ({ desynchronized: true }) }),
        }),
      },
    };
    expect(probeStatic(host).desynchronized).toBe(true);
  });
});

describe("stats", () => {
  it("returns null for an empty sample rather than 0", () => {
    // 0 ms would read as "instant" on a latency chart — the one wrong answer
    // that looks like a good result.
    expect(percentile([], 95)).toBeNull();
    expect(mean([])).toBeNull();
  });

  it("computes p50 and p95 off an unsorted sample", () => {
    const v = [10, 1, 5, 3, 8, 2, 9, 4, 7, 6];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile(v, 100)).toBe(10);
  });

  it("does not mutate the caller's array", () => {
    const v = [3, 1, 2];
    percentile(v, 50);
    expect(v).toEqual([3, 1, 2]);
  });
});
