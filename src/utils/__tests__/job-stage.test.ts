import { describe, it, expect } from "vitest";
import { jobStageLabel } from "../job-stage";

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
