/**
 * Phase 4 — SK's `plan.review` (confirm tier): the card shows ONLY a plan the
 * user may approve (the class teacher for a school student, the parent for a
 * home student — never the parent of a school student, never another
 * teacher), and /api/sk/act's handler consumes the token, then runs
 * sk_learn_plan_decide AS THE APPROVER; a refusal is SK's line, not a write.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/plan-review.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { makeCtx } from "@/sk/shell/__tests__/fixtures";
import type { SkCapabilityDeps } from "@/sk/shell/types";
import type { ActInput } from "@/sk/shell/act-core";
import type { ActionTokenRow } from "@/sk/shell/tokens";
import { MemoryAuditSink } from "@/sk/shell/audit";
import { planReviewAction, PLAN_LINES } from "../plan";
import { runPlanReview } from "@/sk/shell/act-plan";
import { CLASS, KIT, NEXT, PARENT, planDb, STU, STU2, TEACHER } from "@/sk/practice/__tests__/practice-db";

const NOW = new Date("2026-10-31T10:00:00Z");
const P1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const P2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const items = [
  { kind: "reteach", title: "Pigments", reason: "Score 30/100", concept_key: "c1", concept_name: "Pigments", kit_id: KIT },
  { kind: "next", title: "Tissues", reason: "Next chapter", generation_id: NEXT },
];

function session() {
  const db = planDb();
  db.seed("profiles", [{ id: STU, full_name: "Aisha" }, { id: STU2, full_name: "Ben" }]);
  db.seed("sk_learn_plans", [
    { id: P1, student_id: STU, kit_id: KIT, trigger: "kit_done", approver_role: "teacher", class_id: CLASS, approver_id: TEACHER, status: "pending_approval", summary: "Go over pigments.", items, created_at: "2026-10-31T08:00:00Z" },
    { id: P2, student_id: STU2, kit_id: KIT, trigger: "kit_done", approver_role: "parent", class_id: null, approver_id: PARENT, status: "pending_approval", summary: "Home plan.", items, created_at: "2026-10-31T09:00:00Z" },
  ]);
  // her parent is linked too (read-only for the school plan)
  db.seed("parent_links", [{ parent_id: PARENT, child_id: STU, verified_at: null }]);
  return db;
}
const deps = (s: unknown): SkCapabilityDeps => ({ session: s, now: NOW }) as unknown as SkCapabilityDeps;

describe("plan.review — the card (resolve only, never a write)", () => {
  it("the class teacher gets HER student's plan as a confirm card", async () => {
    const r = await planReviewAction.handler(makeCtx({ role: "teacher", hat: "teacher", userId: TEACHER }), {}, deps(session()));
    expect(r.confirm).toEqual({ action: "plan.review", title: "Approve the plan for Aisha?", params: { plan_id: P1, student_name: "Aisha", items: "Pigments; Tissues", summary: "Go over pigments." } });
    expect(r.summary).toBe("Approve the plan for Aisha? Pigments; Tissues. Go over pigments.");
  });
  it("the parent gets ONLY the home child's plan (the school child's is the teacher's)", async () => {
    const r = await planReviewAction.handler(makeCtx({ role: "parent", hat: "parent", userId: PARENT, schoolId: null }), {}, deps(session()));
    expect(r.confirm?.params.plan_id).toBe(P2);
    expect(r.summary).not.toContain("more waiting");
  });
  it("another teacher: nothing to approve; a named student narrows it", async () => {
    const other = await planReviewAction.handler(makeCtx({ role: "teacher", hat: "teacher", userId: "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd" }), {}, deps(session()));
    expect(other).toMatchObject({ ok: true, summary: "No plans are waiting for your approval." });
    expect(other.confirm).toBeUndefined();
    const named = await planReviewAction.handler(makeCtx({ role: "teacher", hat: "teacher", userId: TEACHER }), { student: "nobody" }, deps(session()));
    expect(named.confirm).toBeUndefined();
  });
  it("is a confirm-tier act for teacher + parent hats only; its lines exist in all 10 languages", () => {
    expect(planReviewAction.meta).toMatchObject({ tier: "confirm", kind: "act", roles: ["teacher", "parent"], hats: ["teacher", "parent"] });
    for (const [k, t] of Object.entries(PLAN_LINES)) {
      for (const l of ["en", "ms", "ms-arab", "ar", "fr", "es", "pt", "te", "mr", "hi"]) expect(t[l], `${k} ${l}`).toBeTruthy();
      for (const l of ["ms", "ms-arab", "ar", "fr", "es", "pt", "te", "mr", "hi"]) expect(t[l], `${k} ${l}`).not.toBe(t.en);
      expect(t["ms-arab"].replace(/\{\w+\}|SK/g, ""), k).not.toMatch(/[A-Za-z]/);
    }
  });
});

const row = (params: Record<string, unknown>): ActionTokenRow => ({ id: "tok-1", user_id: TEACHER, action: "plan.review", params: params as ActionTokenRow["params"], params_canonical: "", context_hash: "h", nonce: "n", hmac: "x", expires_at: "", used_at: null });

function actInput(sessionRpc: (fn: string, args?: Record<string, unknown>) => unknown, consume = "done") {
  const ctx = makeCtx({ role: "teacher", hat: "teacher", userId: TEACHER });
  const admin = { from: vi.fn(), rpc: vi.fn(async () => ({ data: consume, error: null })) };
  const session = { from: vi.fn(), rpc: vi.fn(sessionRpc) };
  const input = { ctx, token: "t", via: "click", turnId: "turn", now: NOW, memory: {} as ActInput["memory"], admin, session, sink: new MemoryAuditSink() } as unknown as ActInput;
  return { input, admin, session };
}

describe("act-plan — consume, then sk_learn_plan_decide AS THE APPROVER", () => {
  it("approve: the token is consumed, then the function runs with the session client", async () => {
    const { input, admin, session } = actInput(async () => ({ data: { outcome: "done", status: "approved", applied: { shares: ["s1"], focus: 1 } }, error: null }));
    const h = await runPlanReview(row({ plan_id: P1, student_name: "Aisha" }), input);
    expect(admin.rpc).toHaveBeenCalledWith("sk_consume_action_token", { p_token: "tok-1", p_context_hash: input.ctx.contextHash });
    expect(session.rpc).toHaveBeenCalledWith("sk_learn_plan_decide", { p_plan: P1, p_decision: "approve", p_items: null, p_whole_class: false, p_note: null });
    expect(h.response).toMatchObject({ ok: true, outcome: "done", summary: "Approved — Aisha's plan is now in their lessons.", result: { plan_id: P1, status: "approved", applied: { shares: ["s1"], focus: 1 } } });
  });
  it("not the approver: refused with SK's line (the database decided)", async () => {
    const { input } = actInput(async () => ({ data: { outcome: "refused", reason: "not_approver" }, error: null }));
    const h = await runPlanReview(row({ plan_id: P1, student_name: "Aisha" }), input);
    expect(h.response).toMatchObject({ ok: false, outcome: "refused", summary: "Only the plan's approver can approve it — nothing was changed." });
  });
  it("a bad plan id is refused BEFORE the consume (the card is not burned)", async () => {
    const { input, admin, session } = actInput(async () => ({ data: null, error: null }));
    const h = await runPlanReview(row({ plan_id: "nope" }), input);
    expect(h.response.outcome).toBe("refused");
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(session.rpc).not.toHaveBeenCalled();
  });
  it("a spent token: nothing is decided", async () => {
    const { input, session } = actInput(async () => ({ data: null, error: null }), "already_used");
    const h = await runPlanReview(row({ plan_id: P1 }), input);
    expect(h.response.outcome).toBe("already_used");
    expect(session.rpc).not.toHaveBeenCalled();
  });
});
