/**
 * Phase 4 — the recommended plan: its state machine, who may decide and read
 * it (the 0179 rules, RLS-shaped), edit-before-approve, SK's deterministic
 * items, the model's wording (mocked; a reply that changes the items is
 * refused), drafting end to end on the fake schema (school → teacher, home →
 * parent, one open plan per kit, the weekly plan supersedes), the decision
 * route's call, and approve → assign: the share the function writes puts the
 * next kit on her student Board.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/practice/__tests__/plan.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canApplyToClass,
  canDecide,
  canRead,
  checkEdit,
  fallbackSummary,
  nextStatus,
  parsePlanReply,
  planSkeleton,
  polishPlan,
  type PlanItem,
  type PlanRow,
  type PlanViewer,
} from "../plan";
import { draftPlan, resolveApprover, runWeeklyPlans, worksheetProgress } from "../plan-store";
import { parseDecision, decidePlan } from "../plan-decide";
import { afterPracticeAnswer } from "../after";
import type { ConceptMastery } from "../mastery";
import type { HelpModelCall } from "../help";
import type { RawQuiz } from "@/app/api/quiz/logic";
import { learnerKits, type LearnerGen } from "@/utils/present/learner";
import { CLASS, KIT, NEXT, PAPER, PARENT, planDb, SESSION, STU, STU2, TEACHER, WS } from "./practice-db";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const OTHER_TEACHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PLAN_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const viewer = (o: Partial<PlanViewer> & { id: string }): PlanViewer => ({ role: "teacher", teachesClasses: new Set(), children: new Set(), ...o });
const teacherPlan = { student_id: STU, approver_role: "teacher" as const, class_id: CLASS, status: "pending_approval" as const };
const homePlan = { student_id: STU2, approver_role: "parent" as const, class_id: null, status: "pending_approval" as const };

describe("the state machine", () => {
  it("pending_approval → approved / declined; edit stays pending; nothing else moves", () => {
    expect(nextStatus("pending_approval", "approve")).toBe("approved");
    expect(nextStatus("pending_approval", "decline")).toBe("declined");
    expect(nextStatus("pending_approval", "edit")).toBe("pending_approval");
    for (const s of ["draft", "approved", "declined", "superseded"] as const) for (const d of ["approve", "decline", "edit"] as const) expect(nextStatus(s, d)).toBeNull();
  });
});

describe("who decides (mirrors sk_learn_plan_decide) and who reads (0179 RLS)", () => {
  it("a school student's plan: ONLY the teacher of the plan's class", () => {
    expect(canDecide(teacherPlan, viewer({ id: TEACHER, teachesClasses: new Set([CLASS]) }))).toBe(true);
    expect(canDecide(teacherPlan, viewer({ id: OTHER_TEACHER, teachesClasses: new Set(["another-class"]) }))).toBe(false);
    expect(canDecide(teacherPlan, viewer({ id: PARENT, role: "parent", children: new Set([STU]) }))).toBe(false); // read-only copy
    expect(canDecide(teacherPlan, viewer({ id: STU, role: "student" }))).toBe(false);
    expect(canDecide({ ...teacherPlan, class_id: null }, viewer({ id: TEACHER, teachesClasses: new Set([CLASS]) }))).toBe(false);
  });
  it("a home student's plan: her linked parent; never a teacher, never herself", () => {
    expect(canDecide(homePlan, viewer({ id: PARENT, role: "parent", children: new Set([STU2]) }))).toBe(true);
    expect(canDecide(homePlan, viewer({ id: TEACHER, teachesClasses: new Set([CLASS]) }))).toBe(false);
    expect(canDecide(homePlan, viewer({ id: STU2, role: "student", children: new Set([STU2]) }))).toBe(false);
  });
  it("a decided plan cannot be decided again", () => {
    expect(canDecide({ ...teacherPlan, status: "approved" }, viewer({ id: TEACHER, teachesClasses: new Set([CLASS]) }))).toBe(false);
  });
  it("whole class: teacher plans only", () => {
    expect(canApplyToClass(teacherPlan)).toBe(true);
    expect(canApplyToClass(homePlan)).toBe(false);
  });
  it("reads: the student only her APPROVED plans; her teacher and parent all of hers; others nothing", () => {
    expect(canRead({ student_id: STU, status: "pending_approval" }, viewer({ id: STU, role: "student" }))).toBe(false);
    expect(canRead({ student_id: STU, status: "approved" }, viewer({ id: STU, role: "student" }))).toBe(true);
    expect(canRead({ student_id: STU, status: "pending_approval" }, { ...viewer({ id: TEACHER }), teachesStudent: true })).toBe(true);
    expect(canRead({ student_id: STU, status: "pending_approval" }, viewer({ id: PARENT, role: "parent", children: new Set([STU]) }))).toBe(true);
    expect(canRead({ student_id: STU, status: "approved" }, viewer({ id: OTHER_TEACHER }))).toBe(false);
  });
});

const ITEMS: PlanItem[] = [
  { kind: "reteach", title: "Pigments", reason: "Score 30/100", concept_key: "c1", concept_name: "Pigments", kit_id: KIT },
  { kind: "practice", title: "Practise again", reason: "1 idea", generation_id: WS, kit_id: KIT },
  { kind: "next", title: "Tissues", reason: "Next chapter", generation_id: NEXT },
];

describe("edit before approve", () => {
  it("rewords and drops items; never adds a kit or concept SK did not propose", () => {
    const ok = checkEdit(ITEMS, [{ ...ITEMS[0], title: "  Pigments again  " }, ITEMS[2]]);
    expect(ok?.map((i) => [i.kind, i.title])).toEqual([
      ["reteach", "Pigments again"],
      ["next", "Tissues"],
    ]);
    expect(checkEdit(ITEMS, [{ ...ITEMS[2], generation_id: KIT }])).toBeNull();
    expect(checkEdit(ITEMS, [{ ...ITEMS[0], concept_key: "c9" }])).toBeNull();
    expect(checkEdit(ITEMS, [{ ...ITEMS[0], kind: "next" }])).toBeNull();
    expect(checkEdit(ITEMS, [{ ...ITEMS[0], title: "" }])).toBeNull();
    expect(checkEdit(ITEMS, [])).toBeNull();
    expect(checkEdit(ITEMS, [{ ...ITEMS[0], evil: "x" }])?.[0]).not.toHaveProperty("evil");
  });
  it("the route's body parser: uuid plan, a known decision, shaped items", () => {
    expect(parseDecision({ planId: PLAN_ID, decision: "approve" })).toEqual({ planId: PLAN_ID, decision: "approve", items: null, wholeClass: false, note: null });
    expect(parseDecision({ planId: "x", decision: "approve" })).toEqual({ error: "Bad plan." });
    expect(parseDecision({ planId: PLAN_ID, decision: "publish" })).toEqual({ error: "Bad decision." });
    expect(parseDecision({ planId: PLAN_ID, decision: "edit" })).toEqual({ error: "Nothing to save." });
    expect(parseDecision({ planId: PLAN_ID, decision: "approve", items: [{ kind: "x" }] })).toEqual({ error: "Those plan items didn't look right." });
    expect(parseDecision({ planId: PLAN_ID, decision: "decline", note: "  busy week ", wholeClass: true })).toMatchObject({ note: "busy week", wholeClass: true });
  });
});

const M = (o: Partial<ConceptMastery>): ConceptMastery => ({ studentId: STU, kitId: KIT, key: "c1", name: "Pigments", score: 30, band: "learning", evidence: 3, firstTry: 0, lastAt: "", rule: "sk-learn.1", ...o });

describe("SK's items (deterministic) and the model's wording", () => {
  it("re-teach the weakest non-secure concepts, practise their worksheet, then the next topic", () => {
    const items = planSkeleton({
      mastery: [M({ key: "c3", name: "Secure one", score: 95, band: "secure" }), M({}), M({ key: "c2", name: "Membranes", score: 60, evidence: 1, band: "new" })],
      worksheets: new Map([[KIT, { id: WS, title: "Cells worksheet" }]]),
      kitNames: new Map([[KIT, "Cells"]]),
      next: { generationId: NEXT, title: "Tissues", assigned: false },
    });
    expect(items.map((i) => [i.kind, i.concept_key ?? i.generation_id])).toEqual([
      ["reteach", "c1"],
      ["reteach", "c2"],
      ["practice", WS],
      ["next", NEXT],
    ]);
    expect(items[0].reason).toContain("30/100");
    expect(fallbackSummary(items)).toContain("Pigments, Membranes");
  });
  it("all secure → only the next topic", () => {
    const items = planSkeleton({ mastery: [M({ score: 90, band: "secure" })], worksheets: new Map(), kitNames: new Map(), next: { generationId: NEXT, title: "Tissues", assigned: true } });
    expect(items).toEqual([{ kind: "next", title: "Tissues", reason: "Already assigned and not started yet.", generation_id: NEXT }]);
  });
  it("the model rewords the SAME items; a reply with another count is refused", async () => {
    expect(parsePlanReply(JSON.stringify({ summary: "Go over pigments.", items: ITEMS.map((i) => ({ title: `${i.title}!`, reason: "Because." })) }), ITEMS)?.items.map((i) => [i.kind, i.title, i.generation_id ?? i.concept_key])).toEqual([
      ["reteach", "Pigments!", "c1"],
      ["practice", "Practise again!", WS],
      ["next", "Tissues!", NEXT],
    ]);
    expect(parsePlanReply(JSON.stringify({ summary: "x", items: [{ title: "a", reason: "b" }] }), ITEMS)).toBeNull();
    const call = vi.fn<HelpModelCall>(async () => ({ text: "not json", usage: { input_tokens: 500, output_tokens: 100 } }));
    const p = await polishPlan(call, ITEMS, []);
    expect(p).toMatchObject({ items: ITEMS, model: null, summary: fallbackSummary(ITEMS) });
    expect(p.cost).toBeGreaterThan(0);
    expect(call.mock.calls[0][0].model).toBe("claude-haiku-5-5");
    expect(await polishPlan(null, ITEMS, [])).toMatchObject({ model: null, cost: 0 });
  });
});

// ── drafting on the fake schema ─────────────────────────────────────────────

const attempt = (o: Record<string, unknown>) => ({ session_id: SESSION, student_id: STU, generation_id: WS, question_type: "fill_blank", concept: null, kind: "answer", outcome: "correct", rung: "none", attempt_no: 1, created_at: "2026-10-31T09:00:00Z", ...o });
function seedPractice(db: ReturnType<typeof planDb>, student = STU) {
  db.seed("sk_practice_sessions", [{ id: SESSION, student_id: student, kit_id: KIT }]);
  db.seed("sk_practice_attempts", [
    attempt({ student_id: student, question_id: "q1", outcome: "incorrect", rung: "hint" }),
    attempt({ student_id: student, question_id: "q1", outcome: "incorrect", rung: "step", attempt_no: 2 }),
    attempt({ student_id: student, question_id: "q2" }),
  ]);
}
const wording = vi.fn<HelpModelCall>(async (req) => {
  const items = JSON.parse(req.user).items as unknown[];
  return { text: JSON.stringify({ summary: "Pigments need another look, then on to tissues.", items: items.map(() => ({ title: "Worded title", reason: "Worded reason." })) }), usage: { input_tokens: 600, output_tokens: 200 } };
});

describe("draftPlan — who approves, one open plan, the rows", () => {
  beforeEach(() => {
    wording.mockClear();
  });

  it("a school student → her class teacher; drafted, worded, pending approval", async () => {
    const db = planDb();
    seedPractice(db);
    expect(await resolveApprover(db, STU, KIT)).toEqual({ role: "teacher", approverId: TEACHER, classId: CLASS });
    const r = await draftPlan({ db, call: wording, now: () => NOW }, { studentId: STU, kitId: KIT, trigger: "kit_done" });
    expect(r.outcome).toBe("drafted");
    const [plan] = db.rows("sk_learn_plans") as unknown as PlanRow[];
    expect(plan).toMatchObject({ student_id: STU, kit_id: KIT, trigger: "kit_done", approver_role: "teacher", class_id: CLASS, approver_id: TEACHER, status: "pending_approval", summary: "Pigments need another look, then on to tissues.", model: "claude-haiku-5-5" });
    expect(plan.items.map((i) => i.kind)).toEqual(["reteach", "practice", "next"]);
    expect(plan.items[2]).toMatchObject({ generation_id: NEXT, title: "Worded title" }); // the approver's own next chapter
    expect(plan.mastery.length).toBeGreaterThan(0);
    expect(wording).toHaveBeenCalledTimes(1);
  });

  it("one open plan per student per kit: finishing again does not draft a second", async () => {
    const db = planDb();
    seedPractice(db);
    await draftPlan({ db, call: null, now: () => NOW }, { studentId: STU, kitId: KIT, trigger: "kit_done" });
    const again = await draftPlan({ db, call: null, now: () => NOW }, { studentId: STU, kitId: KIT, trigger: "kit_done" });
    expect(again.outcome).toBe("exists");
    expect(db.rows("sk_learn_plans")).toHaveLength(1);
  });

  it("a home student (no class) → her linked parent approves", async () => {
    const db = planDb();
    seedPractice(db, STU2);
    expect(await resolveApprover(db, STU2, KIT)).toEqual({ role: "parent", approverId: PARENT, classId: null });
    const r = await draftPlan({ db, call: null, now: () => NOW }, { studentId: STU2, kitId: KIT, trigger: "kit_done" });
    expect(r.outcome).toBe("drafted");
    expect(db.rows("sk_learn_plans")[0]).toMatchObject({ approver_role: "parent", approver_id: PARENT, class_id: null, status: "pending_approval", model: null });
  });

  it("nobody to approve → no plan; no practice → no plan", async () => {
    const db = planDb();
    const lonely = "12121212-1212-4121-8121-121212121212";
    db.seed("profiles", [{ id: lonely }]);
    expect(await draftPlan({ db, call: null }, { studentId: lonely, kitId: KIT, trigger: "kit_done" })).toEqual({ outcome: "no_approver" });
    expect((await draftPlan({ db, call: null }, { studentId: STU, kitId: KIT, trigger: "kit_done" })).outcome).toBe("no_evidence");
  });

  it("the weekly plan supersedes her open weekly plan", async () => {
    const db = planDb();
    seedPractice(db);
    const r1 = await runWeeklyPlans({ db, call: null, now: () => NOW }, [STU]);
    const r2 = await runWeeklyPlans({ db, call: null, now: () => NOW + 7 * 86_400_000 }, [STU, STU]);
    expect([r1.drafted, r2.drafted]).toEqual([1, 1]);
    const plans = db.rows("sk_learn_plans");
    expect(plans.map((p) => [p.trigger, p.kit_id, p.status])).toEqual([
      ["weekly", null, "superseded"],
      ["weekly", null, "pending_approval"],
    ]);
  });
});

describe("the after-work: tag on the first answer, plan when finished", () => {
  it("first answer → tags only; finished worksheet → a plan", async () => {
    const db = planDb();
    db.seed("sk_practice_sessions", [{ id: SESSION, student_id: STU, kit_id: KIT }]);
    const two = { ...PAPER, questions: PAPER.questions.slice(0, 2) } as unknown as RawQuiz;
    const base = { db, studentId: STU, sessionId: SESSION, kitId: KIT, generationId: WS, paper: two, kitTitle: async () => "Cells", loadManifest: async () => null, call: null };
    db.seed("sk_practice_attempts", [attempt({ question_id: "q1", outcome: "incorrect", rung: "hint" })]);
    expect(await worksheetProgress(db, SESSION, WS, ["q1", "q2"])).toEqual({ first: true, finished: false });
    expect(await afterPracticeAnswer(base)).toEqual({ tagged: true, plan: null });
    db.seed("sk_practice_attempts", [attempt({ question_id: "q1", attempt_no: 2 }), attempt({ question_id: "q2", outcome: "incorrect", rung: "hint" })]);
    expect(await afterPracticeAnswer(base)).toEqual({ tagged: false, plan: null }); // mid-worksheet: nothing
    db.seed("sk_practice_attempts", [attempt({ question_id: "q2", outcome: "incorrect", rung: "step", attempt_no: 2 }), attempt({ question_id: "q2", outcome: "incorrect", rung: "answer", attempt_no: 3 })]);
    const done = await afterPracticeAnswer(base);
    expect(done.plan?.outcome).toBe("drafted");
  });
});

// ── the decision: the route's one call, and approve → assign ────────────────

describe("decidePlan — sk_learn_plan_decide AS THE APPROVER", () => {
  it("passes the decision through and maps the function's answer", async () => {
    const rpc = vi.fn(async () => ({ data: { outcome: "done", status: "approved", applied: { shares: ["s1"], focus: 1 } }, error: null }));
    const r = await decidePlan({ rpc }, { planId: PLAN_ID, decision: "approve", items: null, wholeClass: true, note: null });
    expect(rpc).toHaveBeenCalledWith("sk_learn_plan_decide", { p_plan: PLAN_ID, p_decision: "approve", p_items: null, p_whole_class: true, p_note: null });
    expect(r).toEqual({ outcome: "done", status: "approved", applied: { shares: ["s1"], focus: 1 } });
  });
  it("a refusal is passed on; an error never throws", async () => {
    expect(await decidePlan({ rpc: async () => ({ data: { outcome: "refused", reason: "not_approver" }, error: null }) }, { planId: PLAN_ID, decision: "approve", items: null, wholeClass: false, note: null })).toEqual({ outcome: "refused", reason: "not_approver" });
    expect((await decidePlan({ rpc: async () => ({ data: null, error: { message: "x" } }) }, { planId: PLAN_ID, decision: "decline", items: null, wholeClass: false, note: null })).outcome).toBe("error");
    expect((await decidePlan({ rpc: () => { throw new Error("down"); } }, { planId: PLAN_ID, decision: "decline", items: null, wholeClass: false, note: null })).outcome).toBe("error");
  });
  it("approve → assign: the DIRECT share the function writes puts the next kit on her student Board", () => {
    const gen = (o: Partial<LearnerGen> & { id: string; kind: string }): LearnerGen => ({ title: "Cells · x", chapter_ref: null, book_id: null, params: null, artifacts: [], status: "done", withdrawn_at: null, created_at: "2026-10-20T00:00:00Z", ...o });
    const gens = [
      gen({ id: KIT, kind: "presentation", title: "Cells · Cells", book_id: "book-1", chapter_ref: "2", artifacts: [{ kind: "video_mp4", storage_path: "k/v.mp4" }] }),
      gen({ id: NEXT, kind: "presentation", title: "Tissues · Tissues", book_id: "book-1", chapter_ref: "3", artifacts: [{ kind: "video_mp4", storage_path: "n/v.mp4" }] }),
    ];
    const before = learnerKits(gens, [{ generation_id: KIT, due_at: null }]);
    expect(before.map((k) => k.id)).toEqual([KIT]);
    // sk_learn_plan_decide: insert into generation_shares (generation_id, student_id, shared_by) values (NEXT, STU, TEACHER)
    const after = learnerKits(gens, [{ generation_id: KIT, due_at: null }, { generation_id: NEXT, due_at: null, created_at: "2026-10-31T10:00:00Z" }]);
    expect(after.map((k) => k.id).sort()).toEqual([KIT, NEXT].sort());
  });
});
