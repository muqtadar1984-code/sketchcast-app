/**
 * The Pinterest Pin Engine's console rules (utils/catalogue/pinterest.ts):
 * approval is per pin and only when the worker's prechecks are clean; an
 * edit sends a pin back for re-checking; boards are editable only while
 * planned; rounds and the topic gap match what the worker will do.
 */
import { describe, expect, it } from "vitest";
import {
  boardEditPatch,
  canApprove,
  canApproveBoard,
  canEdit,
  canReject,
  canRerender,
  canRetry,
  copyProblems,
  editPatch,
  feedTitle,
  isAgentAction,
  isPinAction,
  isDryRun,
  nextDailyRound,
  nextRoundPreview,
  pinUrl,
  runOnceAccepts,
  topicGapOk,
  PIN_ACTIONS,
} from "../catalogue/pinterest";

const ready = {
  status: "in_review" as const,
  precheck: { blocking: [], warnings: [], checked_at: "2026-10-23T00:00:00Z" },
  images: [{ path: "en/cells/explainer.png" }],
  board_id: "b1",
  link: "https://sketchcast.app/topics/cells?utm_source=pinterest",
  title: "Plant and animal cells: a labelled diagram",
  description: "Compare plant and animal cells with a clear labelled diagram.",
  alt_text: "Labelled diagram of a plant cell and an animal cell.",
};

describe("approval", () => {
  it("approves a checked, complete pin in review", () => {
    expect(canApprove(ready)).toEqual({ ok: true });
  });

  it("refuses until the worker has checked the pin", () => {
    const r = canApprove({ ...ready, precheck: { blocking: [] } });
    expect(r.ok).toBe(false);
  });

  it("refuses a blocking precheck and names it", () => {
    const r = canApprove({ ...ready, precheck: { ...ready.precheck, blocking: ["number 42 is not in the article"] } });
    expect(r).toEqual({ ok: false, why: expect.stringContaining("number 42") });
  });

  it("refuses a pin without image, board, link or alt text", () => {
    expect(canApprove({ ...ready, images: [] }).ok).toBe(false);
    expect(canApprove({ ...ready, board_id: null }).ok).toBe(false);
    expect(canApprove({ ...ready, link: "" }).ok).toBe(false);
    expect(canApprove({ ...ready, alt_text: " " }).ok).toBe(false);
  });

  it("refuses a pin that is not in review", () => {
    expect(canApprove({ ...ready, status: "approved" }).ok).toBe(false);
    expect(canApprove({ ...ready, status: "draft" }).ok).toBe(false);
  });

  it("offers no bulk action (decision D1)", () => {
    expect(PIN_ACTIONS).not.toContain("approve_all");
    expect(isPinAction("approve_all")).toBe(false);
    expect(isPinAction("approve")).toBe(true);
  });
});

describe("copy limits", () => {
  it("counts code points and names each problem", () => {
    expect(copyProblems(ready)).toEqual([]);
    const long = copyProblems({ ...ready, title: "x".repeat(101) });
    expect(long[0]).toMatch(/101 characters; Pinterest allows 100/);
    // an Arabic title of 100 letters is within the limit
    expect(copyProblems({ ...ready, title: "ب".repeat(100) })).toEqual([]);
  });

  it("splits the title where a feed truncates it", () => {
    const t = feedTitle("Plant and animal cells: a labelled diagram for revision");
    expect(t.shown).toHaveLength(40);
    expect(t.shown + t.hidden).toBe("Plant and animal cells: a labelled diagram for revision");
  });
});

describe("edits", () => {
  it("sends an edited pin back to review with its approval and prechecks cleared", () => {
    const r = editPatch({ ...ready, status: "approved" }, { title: "Plant vs animal cells" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch).toMatchObject({ status: "in_review", edited: true, approved_by: null, approved_at: null });
    const after = { ...ready, ...(r.patch as object) } as typeof ready;
    expect(canApprove(after).ok).toBe(false); // waits for the worker's re-check
  });

  it("refuses an edit that breaks a limit or changes nothing", () => {
    expect(editPatch(ready, { alt_text: "" }).ok).toBe(false);
    expect(editPatch(ready, { title: ready.title }).ok).toBe(false);
  });

  it("refuses edits once a pin is scheduled or posted", () => {
    expect(canEdit({ status: "scheduled" }).ok).toBe(false);
    expect(canEdit({ status: "posted" }).ok).toBe(false);
  });
});

describe("reject, re-render, retry", () => {
  it("needs a reason to reject", () => {
    expect(canReject({ status: "in_review" }, "").ok).toBe(false);
    expect(canReject({ status: "in_review" }, "Label points at the wrong organelle").ok).toBe(true);
    expect(canReject({ status: "posted" }, "x").ok).toBe(false);
  });

  it("re-renders only pins not on their way out", () => {
    expect(canRerender({ status: "failed", pinterest_pin_id: null }).ok).toBe(true);
    expect(canRerender({ status: "scheduled", pinterest_pin_id: null }).ok).toBe(false);
    // already on Pinterest: a redraw would post it twice
    expect(canRerender({ status: "failed", pinterest_pin_id: "123" }).ok).toBe(false);
  });

  it("retries a failed pin that never reached Pinterest", () => {
    const approvedAt = "2026-10-22T00:00:00Z";
    expect(canRetry({ status: "failed", pinterest_pin_id: null, approved_at: approvedAt }).ok).toBe(true);
    expect(canRetry({ status: "failed", pinterest_pin_id: "123", approved_at: approvedAt }).ok).toBe(false);
    expect(canRetry({ status: "approved", pinterest_pin_id: null, approved_at: approvedAt }).ok).toBe(false);
    // failed while drafting: never reviewed, so no shortcut to approved
    expect(canRetry({ status: "failed", pinterest_pin_id: null, approved_at: null }).ok).toBe(false);
  });
});

describe("boards", () => {
  it("edits only planned boards and validates names", () => {
    expect(boardEditPatch({ status: "planned" }, { name: "Biology Diagrams" })).toEqual({ ok: true, patch: { name: "Biology Diagrams" } });
    expect(boardEditPatch({ status: "approved" }, { name: "x" }).ok).toBe(false);
    expect(boardEditPatch({ status: "planned" }, { name: " " }).ok).toBe(false);
  });

  it("approves a planned board once", () => {
    expect(canApproveBoard({ status: "planned", name: "Biology" }).ok).toBe(true);
    expect(canApproveBoard({ status: "created", name: "Biology" }).ok).toBe(false);
  });
});

describe("the agent", () => {
  const on = { enabled: true, paused: false, daily_at: "21:00" };

  it("runs once more only when on, unpaused, untripped, idle and with something approved", () => {
    expect(runOnceAccepts(null, 3, on)).toEqual({ ok: true });
    expect(runOnceAccepts(null, 3, { ...on, enabled: false }).ok).toBe(false);
    expect(runOnceAccepts(null, 3, { ...on, paused: true }).ok).toBe(false);
    expect(runOnceAccepts(null, 3, { ...on, breaker: { tripped: true } }).ok).toBe(false);
    expect(runOnceAccepts({ status: "running" }, 3, on).ok).toBe(false);
    expect(runOnceAccepts(null, 0, on).ok).toBe(false);
    expect(isAgentAction("run_once") && !isAgentAction("post_now")).toBe(true);
  });

  it("schedules the daily round at daily_at UTC", () => {
    const now = Date.parse("2026-10-23T10:00:00Z");
    expect(new Date(nextDailyRound(on, now, false)).toISOString()).toBe("2026-10-23T21:00:00.000Z");
    expect(new Date(nextDailyRound(on, now, true)).toISOString()).toBe("2026-10-24T21:00:00.000Z");
    const late = Date.parse("2026-10-23T22:00:00Z");
    expect(nextDailyRound(on, late, false)).toBe(late);
    expect(new Date(nextDailyRound({ daily_at: "nonsense" }, now, false)).toISOString()).toBe("2026-10-23T21:00:00.000Z");
  });

  it("holds a topic for the gap and picks the oldest approved per language", () => {
    const now = Date.parse("2026-10-23T21:00:00Z");
    expect(topicGapOk(null, now)).toBe(true);
    expect(topicGapOk("2026-10-20T21:00:00Z", now)).toBe(false);
    expect(topicGapOk("2026-10-16T20:00:00Z", now)).toBe(true);

    const approved = [
      { id: "p2", language: "en", topic_id: "cells", approved_at: "2026-10-22T02:00:00Z", title: "Cells 2" },
      { id: "p1", language: "en", topic_id: "cells", approved_at: "2026-10-22T01:00:00Z", title: "Cells 1" },
      { id: "p3", language: "en", topic_id: "atoms", approved_at: "2026-10-22T03:00:00Z", title: "Atoms" },
      { id: "p4", language: "fr", topic_id: "cells", approved_at: "2026-10-22T01:00:00Z", title: "Cellules" },
    ];
    const posted = { "atoms|en": "2026-10-21T21:00:00Z" };
    const [en] = nextRoundPreview(approved, posted, { languages: ["en"], per_language_per_day: 2 }, now);
    // p1 first; p2 is the same topic as p1 so it waits; atoms posted 2 days ago so it waits
    expect(en.pins.map((p) => p.id)).toEqual(["p1"]);
    expect(en.waiting).toBe(3);
    expect(en.heldByGap).toBe(2);
  });

  it("labels dry-run posts and links real ones", () => {
    expect(isDryRun("dryrun:abc")).toBe(true);
    expect(pinUrl("dryrun:abc")).toBeNull();
    expect(pinUrl("998877")).toBe("https://www.pinterest.com/pin/998877/");
  });
});
