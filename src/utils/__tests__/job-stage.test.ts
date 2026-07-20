import { describe, it, expect } from "vitest";
import { jobStageLabel, etaLabel } from "../job-stage";

describe("jobStageLabel", () => {
  it("renders the part-major narration for multi-part video stages", () => {
    expect(jobStageLabel(58, { phase: "video", part: 2, total: 4, part_pct: 35 })).toBe("part 2/4 · 35%");
    expect(jobStageLabel(96, { phase: "video", part: 4, total: 4, part_pct: 100 })).toBe("part 4/4 · 100%");
  });
  it("labels the analysis phase as reading", () => {
    expect(jobStageLabel(26, { phase: "analysis", part: 1, total: 4, part_pct: 100 })).toBe("reading part 1/4");
  });
  it("falls back to the overall percentage for single-part / missing / malformed stages", () => {
    expect(jobStageLabel(45)).toBe("45%");
    expect(jobStageLabel(45, null)).toBe("45%");
    expect(jobStageLabel(45, { part: 1, total: 1, part_pct: 50 })).toBe("45%"); // single part → plain %
    expect(jobStageLabel(45, {} )).toBe("45%");
  });
  it("clamps a garbage part_pct into 0..100", () => {
    expect(jobStageLabel(50, { part: 2, total: 3, part_pct: 250 })).toBe("part 2/3 · 100%");
    expect(jobStageLabel(50, { part: 2, total: 3, part_pct: -5 })).toBe("part 2/3 · 0%");
  });
});

describe("etaLabel — rough per-kind remaining estimate", () => {
  it("scales a video lesson by its part count and progress", () => {
    // 4 parts × 6 min = 24 min total; at 70% → 7.2 → ceil 8.
    expect(etaLabel("presentation", 70, { total: 4, part: 3 })).toBe("~8 min left");
  });
  it("uses a single part when the stage has no part count yet", () => {
    // 1 × 6 = 6 min; at 20% → 4.8 → ceil 5.
    expect(etaLabel("presentation", 20, null)).toBe("~5 min left");
  });
  it("documents are quick", () => {
    expect(etaLabel("exam_paper", 50, null)).toBe("~1 min left");
    expect(etaLabel("worksheet", 0, null)).toBe("~2 min left"); // 1.5 → ceil 2
  });
  it("says nothing once basically done", () => {
    expect(etaLabel("presentation", 98, { total: 4 })).toBe("");
    expect(etaLabel("exam_paper", 100, null)).toBe("");
  });
  it("defaults an unknown kind sensibly and never returns 0/negative", () => {
    expect(etaLabel(null, 95, null)).toBe("~1 min left");
  });
});
