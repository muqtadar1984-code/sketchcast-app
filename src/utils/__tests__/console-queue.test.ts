import { describe, expect, it } from "vitest";
import { bookGrid, byOwner, summarise, type GenRow, type LiveJob } from "../console-queue";

const job = (o: Partial<LiveJob>): LiveJob => ({
  id: Math.random().toString(36),
  type: "worksheet",
  status: "queued",
  created_at: "2026-10-22T06:49:00Z",
  owner_id: "sara",
  book_id: "sci7",
  ...o,
});

describe("queue strip", () => {
  it("counts lanes, waiting owners and the oldest queued", () => {
    const s = summarise([
      job({ created_at: "2026-10-22T06:49:00Z" }),
      job({ type: "presentation", status: "processing" }),
      job({ owner_id: null, type: "kit_translate", created_at: "2026-10-22T06:46:11Z" }),
    ]);
    expect(s).toMatchObject({ queued: 2, processing: 1, ownersWaiting: 2, oldestQueuedAt: "2026-10-22T06:46:11Z" });
    expect(s.byLane.map((l) => l.type)).toContain("presentation");
  });
});

describe("per owner", () => {
  it("sorts the biggest queue first and estimates its drain at the measured rate", () => {
    const jobs = [
      ...Array.from({ length: 200 }, () => job({})),
      job({ owner_id: "other", book_id: "b2" }),
    ];
    const rows = byOwner(jobs, new Map([["sara", 13]]), 1.7);
    expect(rows[0]).toMatchObject({ ownerId: "sara", queued: 200, errors2h: 13, drainMin: 118, books: ["sci7"] });
    expect(rows[1].ownerId).toBe("other");
  });

  it("keeps an owner whose burst just finished failing", () => {
    const rows = byOwner([], new Map([["sara", 6]]), 1.7);
    expect(rows).toEqual([expect.objectContaining({ ownerId: "sara", queued: 0, errors2h: 6 })]);
  });
});

describe("book grid", () => {
  const g = (o: Partial<GenRow>): GenRow => ({
    id: Math.random().toString(36),
    kind: "worksheet",
    status: "done",
    chapter_ref: "2",
    part: 1,
    created_at: "2026-10-22T06:48:57Z",
    ...o,
  });

  it("flags re-clicked kits as duplicates, ignoring failed attempts", () => {
    const grid = bookGrid(
      [g({}), g({ status: "queued" }), g({ kind: "deck" }), g({ kind: "deck", status: "error" })],
      new Map([["2", 6]]),
    );
    const cells = grid[0].cells;
    expect(cells.find((c) => c.kind === "worksheet")!.duplicate).toBe(true);
    expect(cells.find((c) => c.kind === "deck")!.duplicate).toBe(false);
  });

  it("flags parts the chapter no longer has (the 0152 rule)", () => {
    const grid = bookGrid([g({ part: 7 }), g({ part: 6 }), g({ chapter_ref: "9", part: 3 })], new Map([["2", 6]]));
    expect(grid.map((u) => [u.chapterRef, u.part, u.orphan])).toEqual([
      ["2", 6, false],
      ["2", 7, true],
      ["9", 3, false], // no stored map → nothing to judge against
    ]);
  });
});
