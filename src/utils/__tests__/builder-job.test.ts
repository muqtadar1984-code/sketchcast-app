import { describe, expect, it } from "vitest";

import { builderJob, OBSERVER_JOB_TYPES } from "@/utils/builder-job";

// The rows PostgREST hands back for `jobs(*)`, in the order it happens to
// return them — which is no order at all. Each case is a shape the Library
// has actually shown, or would have.
const build = (over: Partial<Row> = {}): Row => ({
  id: "b1",
  type: "worksheet",
  status: "processing",
  progress: 40,
  stage: { part: 1, total: 1, phase: "docx", part_pct: 40 },
  created_at: "2026-09-03T11:50:06.000Z",
  ...over,
});

type Row = {
  id: string;
  type: string | null;
  status: string;
  progress: number | null;
  stage: unknown;
  created_at: string | null;
};

describe("builderJob", () => {
  it("returns null for nothing", () => {
    expect(builderJob(null)).toBeNull();
    expect(builderJob(undefined)).toBeNull();
    expect(builderJob([])).toBeNull();
  });

  it("is the single job when there is only one", () => {
    const b = build();
    expect(builderJob([b])).toBe(b);
  });

  it("skips the support agent's diagnosis job wherever it sits in the array", () => {
    const b = build({ status: "error", progress: 0 });
    const diag = build({
      id: "d1",
      type: "support_diagnose",
      status: "done",
      progress: 100,
      stage: null,
      created_at: "2026-09-03T11:50:13.000Z",
    });
    // The prod incident's shape: the diagnosis is NEWER and DONE, and
    // PostgREST put it first. jobs[0] read 100% for a failed worksheet.
    expect(builderJob([diag, b])).toBe(b);
    expect(builderJob([b, diag])).toBe(b);
  });

  it("returns null when every job is an observer", () => {
    const diag = build({ type: "support_diagnose" });
    expect(builderJob([diag])).toBeNull();
  });

  it("takes the NEWEST builder when a retry queued a second one", () => {
    const dead = build({ id: "b1", status: "error", progress: 0, created_at: "2026-09-03T11:50:06.000Z" });
    const live = build({ id: "b2", status: "processing", progress: 35, created_at: "2026-09-03T11:51:00.000Z" });
    const diag = build({ id: "d1", type: "support_diagnose", status: "done", progress: 100, created_at: "2026-09-03T11:50:13.000Z" });
    expect(builderJob([dead, diag, live])).toBe(live);
    expect(builderJob([live, diag, dead])).toBe(live);
    expect(builderJob([diag, live, dead])).toBe(live);
  });

  it("never lets an undated row displace a dated build, and treats a typeless row as a builder", () => {
    const dated = build({ id: "b1", created_at: "2026-09-03T11:50:06.000Z" });
    const undated = build({ id: "b0", created_at: null });
    expect(builderJob([undated, dated])).toBe(dated);
    expect(builderJob([dated, undated])).toBe(dated);
    const typeless = build({ id: "b9", type: null, created_at: "2026-09-03T12:00:00.000Z" });
    expect(builderJob([dated, typeless])).toBe(typeless);
  });

  it("keeps array order on a tie", () => {
    const a = build({ id: "a" });
    const b = build({ id: "b" });
    expect(builderJob([a, b])).toBe(a);
    expect(builderJob([b, a])).toBe(b);
  });

  it("names the same observer set as the worker", () => {
    // worker/client.py: OBSERVER_JOB_TYPES = frozenset({"support_diagnose"})
    expect([...OBSERVER_JOB_TYPES]).toEqual(["support_diagnose"]);
  });
});
