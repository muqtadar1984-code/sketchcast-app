/**
 * SK on the STUDENT Board (learner mode, SK student Board plan 2026-10-31,
 * phase 1): which Board tools a student gets, how her questions are routed
 * (the Board's own explain / knowledge path, never the dormant tutor), the
 * student rules in the prompt, and the hidden fair-use cap.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/learner-board.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { buildContext } from "../context";
import { allowedFor } from "../registry";
import { escalationTools, handoffBefore, studentOnBoard } from "../routing";
import { routeByRules, selectionAsk } from "../rules";
import { buildShellPrompt } from "../prompt";
import { STUDENT_BOARD_MOVES, SK_STUDENT_BOARD_RULES, SK_STUDENT_CAP_LINE } from "../learner";
import { BOARD_CAPABILITIES } from "@/sk/capabilities/board";
import { capPeriod, meterStudentTurn, SK_STUDENT_CAP_PRODUCT, SK_STUDENT_DAILY_TURNS_DEFAULT, studentDailyCap } from "@/sk/student-cap";
import { TEACH_AUDIENCE_STUDENT, teachingQuestion } from "../teach";
import type { SkBoardState, SkContext } from "../types";
import { ALL_FLAGS, NOW } from "./fixtures";

const STUDENT_ID = "33333333-3333-4333-8333-333333333333";
const BOARD: SkBoardState = { sessionId: "44444444-4444-4444-8444-444444444444", generationId: "55555555-5555-4555-8555-555555555555", manifestId: "m", k: 1, segments: [{ k: 0, heading: "Cells" }, { k: 1, heading: "Osmosis" }] };

function student(board?: SkBoardState, flags: Record<string, boolean> = {}): SkContext {
  return buildContext({
    user: { id: STUDENT_ID, email: null },
    role: "student",
    schoolId: null,
    hat: null,
    coordinatorScope: [],
    plan: "school",
    staff: false,
    flags: { ...ALL_FLAGS, ...flags },
    collector: { path: board ? "/present" : "/dashboard", ...(board ? { board } : {}) },
    now: NOW,
  });
}
const onBoard = student(BOARD);
const offBoard = student(undefined);
const clock = { day: 3, minutes: 510, iso: "2026-10-28T16:30:00+08:00" };

describe("the Board tools a student gets", () => {
  it("exactly the student moves; recap and practise stay the teacher's", () => {
    const names = allowedFor(onBoard, BOARD_CAPABILITIES).map((c) => c.meta.name).sort();
    expect(names).toEqual([...STUDENT_BOARD_MOVES].map((m) => `board.${m}`).sort());
    expect(names).toContain("board.page");
    expect(names).toContain("board.load_deck");
    expect(names).toContain("board.explain");
    expect(names).toContain("board.explain_selection");
    expect(names).toContain("board.intro");
    expect(names).toContain("board.pause");
    expect(names).not.toContain("board.recap");
    expect(names).not.toContain("board.practise");
  });

  it("none at all without her own Board open (her `board` flag is that, whatever else says)", () => {
    expect(offBoard.flags.board).toBe(false);
    expect(allowedFor(offBoard, BOARD_CAPABILITIES)).toEqual([]);
    expect(student(BOARD, { board: false }).flags.board).toBe(true);
  });

  it("a teacher keeps every Board tool", () => {
    const teacher = buildContext({ user: { id: "t", email: "t@x" }, role: "teacher", schoolId: null, hat: "teacher", coordinatorScope: [], plan: "school", staff: false, flags: ALL_FLAGS, collector: { path: "/present", board: BOARD }, now: NOW });
    expect(allowedFor(teacher, BOARD_CAPABILITIES)).toHaveLength(BOARD_CAPABILITIES.length);
  });
});

describe("a student's questions on her Board go to the Board's own path", () => {
  it("knowledge.search runs as a tool on her Board (no tutor hand-off); off the Board it is still hers", () => {
    expect(studentOnBoard(onBoard)).toBe(true);
    expect(studentOnBoard(offBoard)).toBe(false);
    expect(handoffBefore("knowledge__search", { query: "osmosis" }, onBoard)).toBeNull();
    expect(handoffBefore("knowledge__search", { query: "osmosis" }, offBoard)).toBe("student_knowledge");
    expect(handoffBefore("board__explain_selection", {}, onBoard)).toBe("selection");
  });

  it("on her Board, knowledge.search escalates like a teacher's", () => {
    expect(escalationTools(onBoard).has("knowledge.search")).toBe(true);
    expect(escalationTools(offBoard).has("knowledge.search")).toBe(false);
  });

  it("rules: her Board phrasings are Board moves, never the tutor's", () => {
    const pause = routeByRules("pause", onBoard, NOW, clock);
    expect(pause).toMatchObject({ intent: "teach", move: "pause" });
    const page = routeByRules("next page", onBoard, NOW, clock);
    expect(page).toMatchObject({ intent: "teach", move: "page" });
    const explain = routeByRules("explain osmosis", onBoard, NOW, clock);
    expect(explain).toMatchObject({ intent: "teach", move: "explain" });
  });

  it("rules: a teacher-only move is not decided for her (it goes to the model with her tools)", () => {
    const d = routeByRules("end the lesson", onBoard, NOW, clock);
    expect(d.intent === "teach" && d.move === "recap").toBe(false);
  });

  it("a live highlight + 'explain this' takes the grounded selection path on her Board", () => {
    const sel: SkBoardState = { ...BOARD, selection: { generationId: "66666666-6666-4666-8666-666666666666", n: 2, text: "the cell membrane" } };
    expect(selectionAsk("explain this", student(sel))).toBe(true);
    expect(selectionAsk("explain this", offBoard)).toBe(false);
  });
});

describe("the student prompt on her Board", () => {
  it("carries the student Board rules (never an answer, simple and warm), not the tutor's", () => {
    const caps = allowedFor(onBoard).map((c) => c.meta);
    const p = buildShellPrompt({ ctx: onBoard, capabilities: caps, routing: "model" });
    expect(p).toContain(SK_STUDENT_BOARD_RULES);
    expect(p).toContain("The student's own Board is open");
    expect(p).toContain("M8. For this student on her own Board");
    expect(p).not.toContain("→ tutor.*");
    const off = buildShellPrompt({ ctx: offBoard, capabilities: allowedFor(offBoard).map((c) => c.meta) });
    expect(off).not.toContain(SK_STUDENT_BOARD_RULES);
  });

  it("an approved plan's focus line reaches her Board prompt only (phase 4)", () => {
    const line = "S6. FOCUS (her teacher or parent approved this plan): when it fits — Osmosis";
    const caps = allowedFor(onBoard).map((c) => c.meta);
    expect(buildShellPrompt({ ctx: { ...onBoard, learnFocus: line }, capabilities: caps })).toContain(line);
    expect(buildShellPrompt({ ctx: onBoard, capabilities: caps })).not.toContain("S6. FOCUS");
    const off = { ...offBoard, learnFocus: line };
    expect(buildShellPrompt({ ctx: off, capabilities: allowedFor(off).map((c) => c.meta) })).not.toContain(line);
  });

  it("the teaching call speaks to one student, simply", () => {
    const sup = { status: "ready", language: "en", segments: [{ id: "s1", heading: "Osmosis", narration: "n", points: [] }], items: [] } as never;
    expect(teachingQuestion("explain", sup, "English", TEACH_AUDIENCE_STUDENT)).toContain("to the student");
    expect(teachingQuestion("explain", sup, "English")).toContain("to the class");
  });
});

// ── the hidden fair-use cap ─────────────────────────────────────────────────

type Row = { live_turns: number; generated_segments: number; interactive_ms: number };
function fakeUsage(start: Row | null, fail?: "read" | "write") {
  const rows = new Map<string, Row & { user_id: string; product_id: string; period: string }>();
  if (start) rows.set(`${STUDENT_ID}|${SK_STUDENT_CAP_PRODUCT}|${capPeriod(NOW)}`, { ...start, user_id: STUDENT_ID, product_id: SK_STUDENT_CAP_PRODUCT, period: capPeriod(NOW) });
  const upserts: unknown[] = [];
  const db = {
    from: (table: string) => {
      expect(table).toBe("sk_usage");
      const f: Record<string, string> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: string) => {
          f[k] = v;
          return q;
        },
        maybeSingle: async () => (fail === "read" ? { data: null, error: { message: "boom" } } : { data: rows.get(`${f.user_id}|${f.product_id}|${f.period}`) ?? null, error: null }),
        upsert: async (row: Row & { user_id: string; product_id: string; period: string }) => {
          if (fail === "write") return { error: { message: "nope" } };
          upserts.push(row);
          rows.set(`${row.user_id}|${row.product_id}|${row.period}`, row);
          return { error: null };
        },
      };
      return q;
    },
  };
  return { db, rows, upserts };
}

describe("the student fair-use cap (SK_STUDENT_DAILY_TURNS)", () => {
  it("defaults to 300 and reads a positive integer from the env", () => {
    expect(studentDailyCap({})).toBe(SK_STUDENT_DAILY_TURNS_DEFAULT);
    expect(SK_STUDENT_DAILY_TURNS_DEFAULT).toBe(300);
    expect(studentDailyCap({ SK_STUDENT_DAILY_TURNS: "50" })).toBe(50);
    expect(studentDailyCap({ SK_STUDENT_DAILY_TURNS: "0" })).toBe(300);
    expect(studentDailyCap({ SK_STUDENT_DAILY_TURNS: "lots" })).toBe(300);
  });

  it("counts one turn a day in sk_usage under the sentinel product and a day period", async () => {
    const f = fakeUsage(null);
    expect(capPeriod(NOW)).toBe("day:2026-10-28");
    const r = await meterStudentTurn(f.db, STUDENT_ID, NOW, 3);
    expect(r).toEqual({ ok: true, count: 1, metered: true });
    expect(f.upserts[0]).toMatchObject({ user_id: STUDENT_ID, product_id: SK_STUDENT_CAP_PRODUCT, period: "day:2026-10-28", live_turns: 1 });
    await meterStudentTurn(f.db, STUDENT_ID, NOW, 3);
    expect(await meterStudentTurn(f.db, STUDENT_ID, NOW, 3)).toEqual({ ok: true, count: 3, metered: true });
  });

  it("refuses over the cap and does not count the refused turn", async () => {
    const f = fakeUsage({ live_turns: 3, generated_segments: 0, interactive_ms: 0 });
    expect(await meterStudentTurn(f.db, STUDENT_ID, NOW, 3)).toEqual({ ok: false, count: 3, cap: 3 });
    expect(f.upserts).toEqual([]);
  });

  it("fails OPEN (no client, a read or a write error): a blip never stops a child learning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await meterStudentTurn(null, STUDENT_ID, NOW, 3)).toEqual({ ok: true, count: 0, metered: false });
    expect((await meterStudentTurn(fakeUsage(null, "read").db, STUDENT_ID, NOW, 3)).ok).toBe(true);
    expect((await meterStudentTurn(fakeUsage(null, "write").db, STUDENT_ID, NOW, 3)).ok).toBe(true);
    warn.mockRestore();
  });

  it("the break line exists in all ten locales and shows no number", () => {
    for (const loc of ["en", "ms", "ms-arab", "ar", "fr", "es", "pt", "te", "mr", "hi"]) {
      expect(SK_STUDENT_CAP_LINE[loc]?.trim()).toBeTruthy();
      expect(SK_STUDENT_CAP_LINE[loc]).not.toMatch(/\d/);
    }
  });
});
