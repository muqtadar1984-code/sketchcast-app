/**
 * The per-turn read memo (shared.ts): two capabilities in one turn read the
 * teacher's classes ONCE; no cache → every read runs as before; a failed read
 * is not remembered. Over a counting fake session, with the real handlers.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/shared.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkCapabilityDeps } from "../../shell/types";
import { classEnrollments, memo, schoolHealthRows, teacherClasses } from "../shared";
import { assignmentsStatus } from "../assignments";
import { resolveEntities } from "../resolve";
import { learnersRisk } from "../risk";
import { makeCtx, TEACHER_ID } from "@/sk/shell/__tests__/fixtures";

type Row = Record<string, unknown>;

/** Honours eq / in / is; counts every query per table. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function countingSession(tables: Record<string, Row[]>, failing: Set<string> = new Set()) {
  const counts: Record<string, number> = {};
  const from = (table: string) => {
    counts[table] = (counts[table] ?? 0) + 1;
    const filters: Array<(r: Row) => boolean> = [];
    let single = false;
    const b: any = {};
    for (const m of ["select", "order", "limit", "ilike", "neq", "not", "gte", "lte"]) b[m] = () => b;
    b.eq = (c: string, v: unknown) => {
      filters.push((r) => r[c] === v);
      return b;
    };
    b.in = (c: string, list: unknown[]) => {
      filters.push((r) => list.includes(r[c]));
      return b;
    };
    b.is = (c: string, v: unknown) => {
      filters.push((r) => (v === null ? r[c] == null : r[c] === v));
      return b;
    };
    b.maybeSingle = () => {
      single = true;
      return b;
    };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (failing.has(table)) return Promise.resolve({ data: null, error: { message: `${table} down` } }).then(res, rej);
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(res, rej);
    };
    return b;
  };
  return { counts, from, rpc: () => Promise.resolve({ data: null, error: null }) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const NOW = new Date("2026-10-28T04:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600000).toISOString();
const enrol = (cls: string, id: string, name: string) => ({ class_id: cls, student_id: id, profiles: { full_name: name, username: null, parent_email: null } });
const seed = (): Record<string, Row[]> => ({
  classes: [
    { id: "c7b", name: "7B", grade: "Form 1", teacher_id: TEACHER_ID, school_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", created_at: ago(1000) },
    { id: "c8a", name: "8A", grade: "Form 2", teacher_id: "other", school_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", created_at: ago(900) },
  ],
  enrollments: [enrol("c7b", "s1", "Aisha"), enrol("c7b", "s2", "Emir"), enrol("c8a", "s9", "Emir")],
  generation_shares: [{ id: "sh1", generation_id: "quiz", class_id: "c7b", shared_by: TEACHER_ID, due_at: ago(24), created_at: ago(72), generations: { kind: "quiz", chapter_ref: "1", title: "Cells quiz" } }],
  student_progress: [{ generation_id: "quiz", student_id: "s1", status: "completed", updated_at: ago(48) }],
  submissions: [],
  generations: [{ id: "quiz", owner_id: TEACHER_ID }],
  profiles: [{ id: TEACHER_ID, full_name: "Nurul", username: null }],
});

const deps = (session: ReturnType<typeof countingSession>, cache?: Map<string, Promise<unknown>>): SkCapabilityDeps => ({ session, now: NOW, cache });

describe("memo", () => {
  it("without a cache every read runs; with one, the same key is read once and the promise is shared while in flight", async () => {
    let n = 0;
    const read = async () => ++n;
    expect(await memo({}, "k", read)).toBe(1);
    expect(await memo({}, "k", read)).toBe(2);
    const cache = new Map<string, Promise<unknown>>();
    const [a, b] = await Promise.all([memo({ cache }, "k", read), memo({ cache }, "k", read)]);
    expect([a, b]).toEqual([3, 3]);
    expect(await memo({ cache }, "k", read)).toBe(3);
    expect(await memo({ cache }, "other", read)).toBe(4);
  });
  it("a rejected read is forgotten, so the next caller retries exactly as without the memo", async () => {
    const cache = new Map<string, Promise<unknown>>();
    let n = 0;
    const flaky = async () => {
      if (++n === 1) throw new Error("down");
      return n;
    };
    await expect(memo({ cache }, "k", flaky)).rejects.toThrow("down");
    expect(cache.has("k")).toBe(false);
    expect(await memo({ cache }, "k", flaky)).toBe(2);
  });
  it("keys carry the user id: two users never share a read", async () => {
    const cache = new Map<string, Promise<unknown>>();
    const s = countingSession(seed());
    await teacherClasses(deps(s, cache), TEACHER_ID);
    await teacherClasses(deps(s, cache), "other");
    expect(s.counts.classes).toBe(2);
    await classEnrollments(deps(s, cache), TEACHER_ID, ["c7b"]);
    await classEnrollments(deps(s, cache), TEACHER_ID, ["c7b"]);
    await classEnrollments(deps(s, cache), TEACHER_ID, ["c7b", "c8a"]);
    expect(s.counts.enrollments).toBe(2);
  });
});

describe("one turn, several tools: the shared rows are read once", () => {
  it("assignments.status + context.resolve(class) + context.resolve(learner) → classes once, enrollments once; same answers as unshared", async () => {
    const ctx = makeCtx();
    const run = async (cache?: Map<string, Promise<unknown>>) => {
      const s = countingSession(seed());
      const d = deps(s, cache);
      const results = await Promise.all([
        assignmentsStatus.handler(ctx, {}, d),
        resolveEntities(ctx, { query: "7B", kind: "class" }, d),
        resolveEntities(ctx, { query: "emir", kind: "learner" }, d),
      ]);
      return { counts: s.counts, results };
    };
    const unshared = await run();
    const shared = await run(new Map());
    expect(unshared.counts.classes).toBe(3);
    expect(unshared.counts.enrollments).toBe(2); // resolve(class) reads no roster
    expect(shared.counts.classes).toBe(1);
    expect(shared.counts.enrollments).toBe(1);
    // Byte-identical answers.
    expect(shared.results).toEqual(unshared.results);
    expect(shared.results[0]).toMatchObject({ ok: true, summary: "Cells quiz (7B): 1 of 2 done, 1 not done (1 overdue). Not done: Emir." });
    expect(shared.results[1].entities).toEqual([{ kind: "class", id: "c7b", label: "7B", via: "context.resolve" }]);
    // 8A's Emir is the other teacher's: the shared enrollment read is the OWN classes' only.
    expect(shared.results[2].entities).toEqual([{ kind: "learner", id: "s2", label: "Emir", via: "context.resolve" }]);
  });

  it("learners.risk twice in one turn (all classes, then one class) → school-health's six reads once", async () => {
    const ctx = makeCtx();
    const s = countingSession(seed());
    const d = deps(s, new Map());
    const [all, one] = await Promise.all([learnersRisk.handler(ctx, {}, d), learnersRisk.handler(ctx, { classId: "c7b" }, d)]);
    expect(s.counts.classes).toBe(1);
    expect(s.counts.generation_shares).toBe(1);
    expect(s.counts.submissions).toBe(1);
    expect(all.summary).toBe("1 at risk in 1 class: Emir (7B) — never started.");
    expect(one.summary).toBe("1 at risk in 7B: Emir — never started.");
    expect(await schoolHealthRows(d, TEACHER_ID)).toBe(await schoolHealthRows(d, TEACHER_ID));
  });

  it("a failed shared read fails the tool that asked, and the next tool retries it", async () => {
    const ctx = makeCtx();
    const failing = new Set(["classes"]);
    const s = countingSession(seed(), failing);
    const d = deps(s, new Map());
    const r1 = await assignmentsStatus.handler(ctx, {}, d);
    expect(r1).toMatchObject({ ok: false, error: "classes: classes down" });
    failing.clear();
    const r2 = await assignmentsStatus.handler(ctx, {}, d);
    expect(r2.ok).toBe(true);
    expect(s.counts.classes).toBe(2);
  });
});
