import { describe, expect, it } from "vitest";
import { checkParams, runChapters, runnableStage, RUNNABLE_STAGES } from "../books/stages";

// The app's stage list must refuse what the runner refuses (worker publishing/runner/stages.py).
describe("book run stages", () => {
  const coverage = runnableStage("coverage")!;

  it("knows only the runner's stages", () => {
    expect(RUNNABLE_STAGES.map((s) => s.key)).toEqual(["check_files", "coverage"]);
    expect(runnableStage("drop_tables")).toBeNull();
  });

  it("fills defaults and keeps a valid range", () => {
    expect(checkParams(coverage, {})).toEqual({ params: { first: 1, last: 10 } });
    expect(checkParams(coverage, { first: "3", last: 4 })).toEqual({ params: { first: 3, last: 4 } });
  });

  it("refuses unknown keys, bad numbers and a reversed range", () => {
    expect(checkParams(coverage, { shell: "rm" })).toHaveProperty("error");
    expect(checkParams(coverage, { first: 0 })).toHaveProperty("error");
    expect(checkParams(coverage, { first: 2.5 })).toHaveProperty("error");
    expect(checkParams(coverage, { first: 5, last: 2 })).toHaveProperty("error");
    expect(checkParams(runnableStage("check_files")!, { first: 1 })).toHaveProperty("error");
  });

  it("lists the chapters a run covers", () => {
    expect(runChapters({ first: 2, last: 4 })).toEqual([2, 3, 4]);
    expect(runChapters({})).toEqual([]);
  });

  it("whole-book reports need only run_report", () => {
    for (const s of RUNNABLE_STAGES) expect(s.action).toBe("run_report");
  });
});
