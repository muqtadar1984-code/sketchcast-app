/**
 * S4 slices A+B — the parent reads, as a two-child parent hears them:
 * child.status / diary / notices / risk / progress / week, one block per child
 * when none is named; the right child's facts when one is; the mastery admin
 * read is never reached for a child who is not a verified link of this parent.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/parent.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARENT_CAPABILITIES, childDiary, childNotices, childProgress, childRisk, childStatus, childWeek } from "../parent";
import { REGISTRY } from "..";
import { __setParentMasteryForTests, childMastery, readChildMasteryAdmin, type ChildMasteryRow } from "@/sk/parent-mastery";
import { allowedFor } from "@/sk/shell/registry";
import { computeLearnerHealth } from "@/utils/school-health";
import { makeCtx, fakeSession } from "@/sk/shell/__tests__/fixtures";
import { A1, A2, B1, MASTERY, NOW, PA, PB, X, leakySession, parentCtx } from "./parent-fixtures";

const reader = vi.fn(async (_admin: unknown, childId: string): Promise<ChildMasteryRow[]> => MASTERY[childId] ?? []);
const deps = () => ({ session: leakySession(), now: NOW, cache: new Map<string, Promise<unknown>>() });

beforeEach(() => {
  reader.mockClear();
  __setParentMasteryForTests({ admin: () => ({ from: () => ({}) }), reader });
  process.env.FEATURE_NOTICES = "true";
});
afterEach(() => {
  __setParentMasteryForTests(null);
  delete process.env.FEATURE_NOTICES;
});

describe("registry", () => {
  it("six child.* reads, parent role only, immediate tier", () => {
    expect(PARENT_CAPABILITIES.map((c) => c.meta.name)).toEqual(["child.status", "child.diary", "child.notices", "child.risk", "child.progress", "child.week"]);
    for (const c of PARENT_CAPABILITIES) {
      expect(REGISTRY).toContain(c);
      expect(c.meta).toMatchObject({ tier: "immediate", kind: "read", roles: ["parent"] });
    }
    const names = (role: string) => allowedFor(makeCtx({ role, hat: null })).map((c) => c.meta.name);
    expect(names("parent")).toEqual(expect.arrayContaining(["child.status", "child.week"]));
    for (const role of ["teacher", "student", "school_admin"]) expect(names(role).filter((n) => n.startsWith("child."))).toEqual([]);
  });
});

describe("child.status", () => {
  it('"how are my kids doing" (no child) → one block per child, each with ITS facts', async () => {
    const r = await childStatus.handler(parentCtx(PA), {}, deps());
    const [aisyah, adam] = r.summary.split("\n");
    expect(aisyah).toBe('Aisyah: shared work 3 — done 2, overdue 0, awaiting marking 1.');
    expect(adam).toMatch(/^Adam: shared work 1 — done 0, overdue 1, awaiting marking 0\. Overdue: Worksheet — Cells \(due Tue 27 Oct\)\.$/);
    expect(r.entities?.map((e) => e.id)).toEqual([A1, A2]);
    // A lesson plan is never the child's work; a classmate's completion is not Adam's.
    expect(r.facts?.map((f) => f.title)).toEqual(expect.not.arrayContaining(["Teacher plan"]));
    expect(r.facts?.filter((f) => f.child === "Adam").map((f) => [f.title, f.status, f.overdue])).toEqual([["Worksheet — Cells", "not started", true]]);
  });
  it("a pending quiz is awaiting marking, never a score; feedback is reported", async () => {
    const r = await childStatus.handler(parentCtx(PB), {}, deps());
    expect(r.summary).toBe('Zara: shared work 1 — done 1, overdue 0, awaiting marking 0. Latest score: Zara Lim private paper 9/10. Teacher\'s note on Zara Lim private paper: "Well done Zara"');
    const a = await childStatus.handler(parentCtx(PA), { child: "Aisyah" }, deps());
    expect(a.facts?.find((f) => f.title === "Fractions practice")).toMatchObject({ awaitingMarking: true, score: null });
  });
  it("a forged / other-family child id is refused", async () => {
    for (const forged of [B1, X]) {
      const r = await childStatus.handler(parentCtx(PA), { child: forged }, deps());
      expect(r).toMatchObject({ ok: false, error: "not_linked", facts: [] });
    }
  });
  it("speaks the parent's language", async () => {
    const r = await childStatus.handler(parentCtx(PA, "ms"), { child: "Aisyah" }, deps());
    expect(r.summary).toBe("Aisyah: kerja dikongsi 3 — siap 2, lewat 0, menunggu penandaan 1.");
  });
});

describe("child.diary", () => {
  it("the child's own notes + her classes' class-wide notes, never a classmate's or a sibling's", async () => {
    const r = await childDiary.handler(parentCtx(PA), {}, deps());
    const [aisyah, adam] = r.summary.split("\n");
    expect(aisyah).toBe('Aisyah: diary notes in the last 14 days: 1. Latest, Mon 26 Oct: "Aisyah read beautifully today."');
    expect(adam).toBe('Adam: diary notes in the last 14 days: 1. Latest, Tue 27 Oct: "Class trip on Friday — bring a hat."');
    expect(JSON.stringify(r)).not.toMatch(/Xavier|Zara/);
  });
});

describe("child.notices", () => {
  it("school child: her school's board only; home learner: the fixed line", async () => {
    const r = await childNotices.handler(parentCtx(PA), {}, deps());
    const [aisyah, adam] = r.summary.split("\n");
    expect(aisyah).toBe("Notices come from a school; Aisyah learns at home.");
    expect(adam).toMatch(/^Adam's school: Sports day \(.+\)\.$/);
    expect(r.summary).not.toContain("Other school fair");
  });
});

describe("child.risk (school-health rules, direct shares counted)", () => {
  it("home learner with only direct shares is judged; overdue school child flagged", async () => {
    const r = await childRisk.handler(parentCtx(PA), {}, deps());
    const [aisyah, adam] = r.summary.split("\n");
    // Her pending quiz (auto part 4/10) is handed in, not a score: no "average 40%".
    expect(aisyah).toBe("Aisyah is on track — nothing flagged.");
    expect(adam).toBe("Adam could use a hand: has not started yet.");
    expect(r.facts?.[0]).toMatchObject({ child: "Aisyah", verdict: "on_track", assigned: 3, done: 2 });
  });
  it("did well: no at-risk reason and a high score", async () => {
    const r = await childRisk.handler(parentCtx(PB), {}, deps());
    expect(r.summary).toBe("Zara did well: average score 90%.");
  });
  it("computeLearnerHealth counts DIRECT shares; the class analytics still skip them", () => {
    const rows = {
      enrollments: [],
      shares: [
        { generation_id: "d1", class_id: null, student_id: "kid", shared_by: "p", due_at: "2026-10-01T00:00:00Z" },
        { generation_id: "d2", class_id: null, student_id: "kid", shared_by: "p", due_at: "2026-10-02T00:00:00Z" },
        { generation_id: "d3", class_id: null, student_id: "other", shared_by: "p", due_at: "2026-10-02T00:00:00Z" },
      ],
      progress: [],
      submissions: [],
    };
    const h = computeLearnerHealth(rows, "kid", NOW.getTime());
    expect(h).toMatchObject({ assigned: 2, completed: 0, overdue: 2 });
    expect(h.reasons).toEqual(["0% completion", "never started", "2 overdue"]);
  });
});

describe("child.progress — the admin read, behind the verified-link gate", () => {
  it("groups mastered / getting there / needs work for that child only", async () => {
    const r = await childProgress.handler(parentCtx(PA), { child: "Aisyah" }, deps());
    expect(r.summary).toBe("Aisyah: mastered 1, getting there 1, needs work 1. Needs work: Explain diffusion. Getting there: Name the parts of a plant cell. Mastered: Describe the cell as the unit of life.");
    expect(reader.mock.calls.map((c) => c[1])).toEqual([A1]);
    const adam = await childProgress.handler(parentCtx(PA), { child: A2 }, deps());
    expect(adam.summary).toBe("Adam hasn't practised with SK yet, so there is no mastery to show.");
  });
  it("NEVER calls the admin reader for an unlinked, unverified or forged child, or a non-parent", async () => {
    const admin = vi.fn(() => ({ from: () => ({}) }));
    __setParentMasteryForTests({ admin, reader });
    for (const forged of [B1, X, "99999999-9999-4999-8999-999999999999"]) {
      expect(await childMastery(parentCtx(PA), forged)).toBeNull();
      const r = await childProgress.handler(parentCtx(PA), { child: forged }, deps());
      expect(r.ok).toBe(false);
    }
    const unverified = parentCtx(PA);
    unverified.children = unverified.children!.map((c) => ({ ...c, verified: false }));
    expect(await childMastery(unverified, A1)).toBeNull();
    await childProgress.handler(unverified, { child: "Aisyah" }, deps());
    const teacher = makeCtx({ role: "teacher" });
    teacher.children = parentCtx(PA).children;
    expect(await childMastery(teacher, A1)).toBeNull();
    expect(reader).not.toHaveBeenCalled();
    expect(admin).not.toHaveBeenCalled();
  });
  it("the admin read filters by that one student_id and re-filters the rows", async () => {
    const log: string[] = [];
    const db = fakeSession(
      {
        sk_objective_mastery: [
          { student_id: A1, objective_key: "11111111-1111-4111-8111-111111111111:o1", status: "mastered", updated_at: "2026-10-27T00:00:00Z" },
          { student_id: B1, objective_key: "11111111-1111-4111-8111-111111111111:o2", status: "needs_work", updated_at: "2026-10-27T00:00:00Z" },
        ],
        mastery_state: [{ student_id: B1, teaching_objective_id: "t1", status: "mastered", updated_at: null }],
        topic_articles: [{ id: "11111111-1111-4111-8111-111111111111", title: "Cells", objectives: [{ id: "o1", text: "Describe the cell" }, { id: "o2", text: "Zara thing" }] }],
        teaching_objectives: [{ id: "t1", text: "Zara objective" }],
      },
      { log },
    );
    const rows = await readChildMasteryAdmin(db, A1);
    expect(rows).toEqual([{ key: "11111111-1111-4111-8111-111111111111:o1", status: "mastered", updatedAt: "2026-10-27T00:00:00Z", label: "Describe the cell", kit: "Cells" }]);
    expect(log).toContain(`sk_objective_mastery.eq("student_id","${A1}")`);
    expect(log).toContain(`mastery_state.eq("student_id","${A1}")`);
  });
});

describe("child.week — the in-app digest + what to do about it", () => {
  it('"Aisyah\'s week"', async () => {
    const r = await childWeek.handler(parentCtx(PA), { child: "Aisyah" }, deps());
    expect(r.summary).toBe(
      'Aisyah — this week: done 2, overdue 0, awaiting marking 1; ideas mastered 1; new diary notes 1. What to do about it: revisit "Explain diffusion" in Cells; finish Quiz — Plants before Fri 30 Oct.',
    );
  });
  it("two children → one digest each; an overdue piece is the first step", async () => {
    const r = await childWeek.handler(parentCtx(PA), {}, deps());
    const [, adam] = r.summary.split("\n");
    expect(adam).toBe("Adam — this week: done 0, overdue 1 (Worksheet — Cells (due Tue 27 Oct)), awaiting marking 0; ideas mastered 0; new diary notes 1. What to do about it: finish Worksheet — Cells.");
  });
  it("Arabic", async () => {
    const r = await childWeek.handler(parentCtx(PB, "ar"), {}, deps());
    expect(r.summary.startsWith("Zara — هذا الأسبوع:")).toBe(true);
  });
});
