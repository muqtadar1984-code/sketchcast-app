/**
 * Tour engine invariants (the three load-bearing decisions): per-role selection
 * from config, version-aware seen-state gate, and graceful missing-target skip —
 * plus the swappable analytics emitter. All pure; no DOM, no library.
 * Run: npx vitest run src/tour/__tests__/tour.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOURS, tourForRole } from "@/tour/definitions";
import { resolveSteps, shouldAutoStart } from "@/tour/logic";
import { emitTourEvent } from "@/tour/analytics";
import type { TourStep } from "@/tour/types";

describe("per-role tour selection (config-driven)", () => {
  it("returns each role's own tour", () => {
    expect(tourForRole("teacher")?.key).toBe("teacher_onboarding");
    expect(tourForRole("student")?.key).toBe("student_onboarding");
    expect(tourForRole("parent")?.key).toBe("parent_onboarding");
    expect(tourForRole("school_admin")?.key).toBe("school_admin_onboarding");
    expect(tourForRole("coordinator")?.key).toBe("coordinator_onboarding");
  });
  it("unknown role → null (never a crash)", () => {
    expect(tourForRole("alien")).toBeNull();
    expect(tourForRole(null)).toBeNull();
    expect(tourForRole(undefined)).toBeNull();
  });
  it("all five roles are defined, versioned, non-empty, with a home path", () => {
    const keys = Object.values(TOURS).map((d) => d.key);
    expect(keys).toHaveLength(5);
    for (const def of Object.values(TOURS)) {
      expect(def.steps.length).toBeGreaterThan(0);
      expect(typeof def.version).toBe("number");
      expect(def.homePath.startsWith("/")).toBe(true);
    }
  });
  it("steps come out sorted by order regardless of authoring order", () => {
    const orders = tourForRole("teacher")!.steps.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});

describe("version-aware seen-state gate", () => {
  it("auto-starts when never seen", () => {
    expect(shouldAutoStart(null, 1)).toBe(true);
    expect(shouldAutoStart({ version: null, status: null }, 1)).toBe(true);
  });
  it("does NOT re-show the same version (no re-nag)", () => {
    expect(shouldAutoStart({ version: 1, status: "completed" }, 1)).toBe(false);
    expect(shouldAutoStart({ version: 1, status: "skipped" }, 1)).toBe(false);
  });
  it("re-shows to everyone when the definition version is bumped", () => {
    expect(shouldAutoStart({ version: 1, status: "completed" }, 2)).toBe(true);
  });
  it("does not re-show for an older-than-seen definition (defensive)", () => {
    expect(shouldAutoStart({ version: 3, status: "completed" }, 2)).toBe(false);
  });
});

describe("missing-target graceful degradation", () => {
  const steps: TourStep[] = [
    { id: "a", target: '[data-tour="a"]', title: "A", body: "", order: 1 },
    { id: "b", target: '[data-tour="b"]', title: "B", body: "", order: 2 },
    { id: "welcome", target: "", title: "W", body: "", order: 3 },
  ];
  it("skips absent targets, keeps present + centered (empty-target) steps", () => {
    const present = new Set(['[data-tour="a"]']);
    const { valid, missing } = resolveSteps(steps, (t) => present.has(t));
    expect(valid.map((s) => s.id)).toEqual(["a", "welcome"]);
    expect(missing.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("swappable analytics emitter", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("posts the event when sendBeacon is unavailable", () => {
    vi.stubGlobal("navigator", {});
    const fetchMock = vi.fn(() => Promise.resolve({} as Response));
    vi.stubGlobal("fetch", fetchMock);
    emitTourEvent({ event: "tour_completed", tourKey: "student_onboarding", role: "student", version: 2 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/tour/event");
    expect(JSON.parse(opts.body as string).event).toBe("tour_completed");
  });
  it("never throws even if the transport blows up", () => {
    vi.stubGlobal("navigator", {
      sendBeacon: () => {
        throw new Error("boom");
      },
    });
    expect(() =>
      emitTourEvent({ event: "tour_started", tourKey: "k", role: "teacher", version: 1 }),
    ).not.toThrow();
  });
});
