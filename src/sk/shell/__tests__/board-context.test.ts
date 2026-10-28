/**
 * S1 additions to the Context, the prompt and the SSE parser: the collector's
 * Board state (segments/concepts) is sanitised and bounded; the prompt gains
 * the Board rule and the lesson map only while a Board is open; the parser
 * accepts `board` and `confirm` frames.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/board-context.test.ts
 */
import { describe, expect, it } from "vitest";
import { sanitizeBoard } from "../context";
import { buildShellPrompt, lessonMapLines } from "../prompt";
import { parseEventJson } from "../client/sse";
import { collect } from "../client/collector";
import { makeCtx, NOW, TEACHER_ID, SCHOOL_ID, ALL_FLAGS } from "./fixtures";
import { buildContext } from "../context";
import type { SkBoardState } from "../types";

describe("sanitizeBoard (S1 fields)", () => {
  it("keeps k, generationId, bounded segments and concepts", () => {
    const b = sanitizeBoard({
      sessionId: "s",
      manifestId: "m",
      k: 2,
      generationId: "g",
      segments: [
        { k: 0, heading: "A", id: "s1", points: ["p1", "", 7, "p2"] },
        { k: "x", heading: "dropped" },
        { k: 1, heading: 42 },
        null,
      ],
      concepts: [{ id: "c1", name: "Cell", segmentIds: ["s1", 3, "s2"] }, { id: "", name: "no id" }, { id: "c2", name: "No links" }],
    });
    expect(b).toEqual({
      sessionId: "s",
      manifestId: "m",
      move: undefined,
      segmentId: undefined,
      t: undefined,
      paused: undefined,
      rollPage: undefined,
      k: 2,
      generationId: "g",
      segments: [{ k: 0, heading: "A", id: "s1", points: ["p1", "p2"] }, { k: 1, heading: "" }],
      concepts: [
        { id: "c1", name: "Cell", segmentIds: ["s1", "s2"] },
        { id: "c2", name: "No links", segmentIds: [] },
      ],
    });
  });
  it("caps the lists and the strings", () => {
    const segments = Array.from({ length: 300 }, (_, k) => ({ k, heading: "h".repeat(400), points: Array.from({ length: 20 }, () => "p") }));
    const concepts = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, name: "n", segmentIds: Array.from({ length: 80 }, (_, j) => `s${j}`) }));
    const b = sanitizeBoard({ sessionId: "s", segments, concepts })!;
    expect(b.segments).toHaveLength(200);
    expect(b.segments![0].heading).toHaveLength(160);
    expect(b.segments![0].points).toHaveLength(8);
    expect(b.concepts).toHaveLength(60);
    expect(b.concepts![0].segmentIds).toHaveLength(40);
  });
  it("a negative or fractional k is dropped; no sessionId → no board", () => {
    expect(sanitizeBoard({ sessionId: "s", k: -1 })?.k).toBeUndefined();
    expect(sanitizeBoard({ sessionId: "s", k: 1.5 })?.k).toBeUndefined();
    expect(sanitizeBoard({ k: 1 })).toBeUndefined();
  });
});

describe("the prompt on the Board", () => {
  const board: SkBoardState = { sessionId: "s", manifestId: "m", k: 1, paused: true, segments: [{ k: 0, heading: "Intro" }, { k: 1, heading: "Cells" }] };
  const onBoard = buildContext({
    user: { id: TEACHER_ID, email: "t@x" },
    role: "teacher",
    schoolId: SCHOOL_ID,
    hat: "teacher",
    coordinatorScope: [],
    plan: "school",
    staff: false,
    flags: ALL_FLAGS,
    collector: { path: "/present", board },
    now: NOW,
  });
  it("adds rule 8, the board token and the lesson map", () => {
    const p = buildShellPrompt({ ctx: onBoard, capabilities: [] });
    expect(p).toContain("8. The Classroom Board is open");
    expect(p).toContain("board=open k=1 paused slides=2");
    expect(p).toContain("LESSON MAP (this Board's slides)");
    expect(p).toContain("- slide 1 (k=0): Intro");
    expect(p).toContain("- slide 2 (k=1): Cells");
  });
  it("says map=pending when the manifest is not there yet; nothing Board-related off the Board", () => {
    const pending = buildContext({ ...onBoard.user, user: { id: TEACHER_ID, email: null }, role: "teacher", schoolId: SCHOOL_ID, hat: "teacher", coordinatorScope: [], plan: "school", staff: false, flags: ALL_FLAGS, collector: { path: "/present", board: { sessionId: "s" } }, now: NOW });
    expect(buildShellPrompt({ ctx: pending, capabilities: [] })).toContain("board=open map=pending");
    const off = buildShellPrompt({ ctx: makeCtx(), capabilities: [] });
    expect(off).not.toContain("board=open");
    expect(off).not.toContain("LESSON MAP");
    expect(off).not.toContain("8. The Classroom Board");
  });
  it("lessonMapLines caps at 40 and names untitled slides", () => {
    const many: SkBoardState = { sessionId: "s", segments: Array.from({ length: 50 }, (_, k) => ({ k, heading: k === 0 ? "" : `H${k}` })) };
    const lines = lessonMapLines(many);
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe("- slide 1 (k=0): (untitled)");
    expect(lessonMapLines(undefined)).toEqual([]);
  });
});

describe("the collector carries the Board state; the SSE parser accepts the S1 events", () => {
  it("collect() passes `board` through untouched", () => {
    const board: SkBoardState = { sessionId: "s", k: 3, segments: [{ k: 0, heading: "A" }] };
    const c = collect({ location: { pathname: "/present", search: "" }, now: new Date(2026, 9, 28, 9, 0), lang: "en", board });
    expect(c.path).toBe("/present");
    expect(c.board).toBe(board);
    expect(collect({ location: { pathname: "/dashboard", search: "" }, now: new Date() }).board).toBeUndefined();
  });
  it("board and confirm frames parse; unknown types are still dropped", () => {
    expect(parseEventJson('{"type":"board","move":"slide","args":{"k":2},"say":"Slide 3."}')).toEqual({ type: "board", move: "slide", args: { k: 2 }, say: "Slide 3." });
    expect(parseEventJson('{"type":"confirm","token":"a.b","action":"assign","title":"t","params":{},"expiresAt":"2026-10-28T10:10:00Z"}')).toMatchObject({ type: "confirm", action: "assign" });
    expect(parseEventJson('{"type":"job","id":1}')).toBeNull();
  });
});
