/**
 * S2 acceptance (Final Plan §6 S2): "marking queue drains 20 items in a test".
 *
 * Twenty pending submissions on the teacher's own kit, in the act fakes. The
 * loop is the conversation's: `marking.next` brings up the oldest (its entity
 * goes into the signed memory), `marking.grade` "give it 7 out of 10" returns
 * a card, the card is confirmed through executeAction (token signed, consumed
 * once, GradeList's row written AS THE TEACHER with the pending guard), and
 * the memory the act returns carries on — until marking.next says "Nothing to
 * mark — you're all caught up." Every submission is graded exactly once and
 * the remaining count only ever goes down.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/marking-drain.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeAction } from "../act";
import { MARK_ALL_DONE, MARK_EMPTY } from "../act-lines";
import { lineFor } from "../lines";
import { MemoryAuditSink } from "../audit";
import { freshMemory, rememberTurn, type SkMemory } from "../memory";
import type { ActionParams } from "../tokens";
import { markingGrade, markingNext } from "@/sk/capabilities/marking";
import { NOW, TEACHER_ID, makeCtx } from "./fixtures";
import { ACT_SECRET, CLASS_7B, GEN, diarySession, signedRow, statefulAdmin } from "./act-fakes";

const N = 20;
const pad = (i: number, w = 12) => String(i).padStart(w, "0");
const subId = (i: number) => `5b000000-0000-4000-8000-${pad(100 + i)}`;
const learnerId = (i: number) => `a0000000-0000-4000-8000-${pad(500 + i)}`;
const tokenId = (i: number) => `70000000-0000-4000-8000-${pad(900 + i)}`;

const saved = process.env.SK_SHELL_SECRET;
beforeEach(() => {
  process.env.SK_SHELL_SECRET = ACT_SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env.SK_SHELL_SECRET;
  else process.env.SK_SHELL_SECRET = saved;
});

function world() {
  // Submitted one minute apart, inserted in REVERSE order: the queue's own
  // oldest-first sort is what decides the order, not the rows' order.
  const submissions = Array.from({ length: N }, (_, i) => ({
    id: subId(i),
    generation_id: GEN,
    student_id: learnerId(i),
    mode: "file",
    grade_status: "pending",
    auto_score: null,
    max_score: null,
    answers: null,
    submitted_at: new Date(Date.parse("2026-10-27T01:00:00.000Z") + i * 60_000).toISOString(),
  })).reverse();
  return diarySession({
    classes: [{ id: CLASS_7B, name: "7B", teacher_id: TEACHER_ID }],
    enrollments: Array.from({ length: N }, (_, i) => ({ class_id: CLASS_7B, student_id: learnerId(i), profiles: { full_name: `Learner ${String(i + 1).padStart(2, "0")}` } })),
    submissions,
    generations: [{ id: GEN, kind: "worksheet", title: "Plant and Animal Cells", chapter_ref: "1", book_id: null, owner_id: TEACHER_ID, params: null, status: "done" }],
    books: [],
  });
}

describe("marking queue drain — 20 items, next → grade → confirm until caught up", () => {
  it("grades all 20 exactly once, in order, the remaining count descending, then says it's all caught up", async () => {
    const ctx = makeCtx();
    const session = world();
    const admin = statefulAdmin({});
    const sink = new MemoryAuditSink();
    const deps = { session, now: NOW };
    let memory: SkMemory = freshMemory(ctx, NOW);

    const remaining: number[] = [];
    const brought: string[] = [];
    const confirmed: string[] = [];
    let last = "";

    for (let turn = 0; turn <= N; turn++) {
      // "next to mark"
      ctx.recent = { ...ctx.recent, entities: memory.entities };
      const next = await markingNext.handler(ctx, {}, deps);
      expect(next.ok).toBe(true);
      if (next.summary === lineFor(MARK_EMPTY, "en")) break;
      const fact = next.facts?.[0] as { id: string; remaining_after: number };
      remaining.push(fact.remaining_after);
      brought.push(fact.id);
      memory = rememberTurn(memory, { user: "next to mark", assistant: next.summary, entities: next.entities }, NOW);

      // "give it 7 out of 10, good work" → the card
      ctx.recent = { ...ctx.recent, entities: memory.entities };
      const card = await markingGrade.handler(ctx, { score: 7, outOf: 10, feedback: "Good work." }, deps);
      expect(card.ok).toBe(true);
      expect(card.confirm?.action).toBe("marking.grade");
      expect(card.confirm?.params.submission_id).toBe(fact.id);

      // Confirm (a click): the token is signed, consumed once, the grade written.
      const { row, token } = signedRow({ id: tokenId(turn), action: "marking.grade", params: card.confirm!.params as ActionParams, contextHash: ctx.contextHash });
      admin.rows[row.id] = row;
      const out = await executeAction({ ctx, token, via: "click", turnId: `t-${turn}`, now: NOW, memory, admin, session, sink });
      expect(out.response.outcome).toBe("done");
      confirmed.push(String((out.response.result as { submission_id?: string }).submission_id));
      last = out.response.summary;
      memory = out.memory;
    }

    // Twenty grades, each submission exactly once, oldest first.
    const written = session.updates.filter((u) => u.table === "submissions").flatMap((u) => u.ids as string[]);
    expect(written).toHaveLength(N);
    expect(new Set(written).size).toBe(N);
    expect(written).toEqual(Array.from({ length: N }, (_, i) => subId(i)));
    expect(confirmed).toEqual(written);
    expect(brought).toEqual(written);
    // The queue only ever shrank: 19, 18, …, 0.
    expect(remaining).toEqual(Array.from({ length: N }, (_, i) => N - 1 - i));
    for (let i = 1; i < remaining.length; i++) expect(remaining[i]).toBeLessThan(remaining[i - 1]);
    // Every token consumed exactly once; every row graded by her.
    expect(admin.calls.filter((c) => c.fn === "sk_consume_action_token")).toHaveLength(N);
    expect(Object.values(admin.rows).every((r) => !!r.used_at)).toBe(true);
    // The last grade says so; the next "next to mark" is the caught-up line.
    expect(last).toBe(`Graded Learner 20: 7/10. ${lineFor(MARK_ALL_DONE, "en")}`);
    ctx.recent = { ...ctx.recent, entities: memory.entities };
    expect((await markingNext.handler(ctx, {}, deps)).summary).toBe("Nothing to mark — you're all caught up.");
    expect(sink.rows.filter((r) => r.action === "marking.grade" && r.ok)).toHaveLength(N);
  });
});
