import { describe, it, expect } from "vitest";
import { jobStageLabel, etaLabel } from "../job-stage";
import en from "@/i18n/messages/en.json";

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

// Every assertion above reads the ENGLISH default — the fallback for a caller
// with no dictionary. These chips are the busiest text in the product, so the
// translated path gets its own check: an Arabic message set, which also moves
// the percent sign to the Arabic one and so proves the words come from the
// dictionary rather than from a template in the util.
const AR = {
  readingPart: "قراءة الجزء {n}/{total}",
  partProgress: "الجزء {n}/{total} · {pct}٪",
  percent: "{pct}٪",
  minutesLeft: "~{n} دقيقة متبقية",
};

describe("both labels render the reader's language when given one", () => {
  it("translates the stage chip, placeholders and all", () => {
    expect(jobStageLabel(58, { phase: "video", part: 2, total: 4, part_pct: 35 }, AR)).toBe(
      "الجزء 2/4 · 35٪",
    );
    expect(jobStageLabel(26, { phase: "analysis", part: 1, total: 4 }, AR)).toBe("قراءة الجزء 1/4");
    expect(jobStageLabel(45, null, AR)).toBe("45٪");
  });
  it("translates the ETA", () => {
    expect(etaLabel("presentation", 20, null, AR)).toBe("~5 دقيقة متبقية");
    expect(etaLabel("presentation", 98, { total: 4 }, AR)).toBe(""); // still silent when near done
  });
  // The English default is a COPY of the dictionary's own English, so an edit to
  // en.json that never reached this file would quietly ship two Englishes.
  it("the no-dictionary default says exactly what the English dictionary says", () => {
    const stage = { phase: "video", part: 2, total: 4, part_pct: 35 };
    expect(jobStageLabel(58, stage)).toBe(jobStageLabel(58, stage, en.utils.job));
    expect(jobStageLabel(26, { phase: "analysis", part: 1, total: 4 })).toBe(
      jobStageLabel(26, { phase: "analysis", part: 1, total: 4 }, en.utils.job),
    );
    expect(jobStageLabel(45)).toBe(jobStageLabel(45, null, en.utils.job));
    expect(etaLabel("presentation", 20, null)).toBe(etaLabel("presentation", 20, null, en.utils.job));
  });
});
