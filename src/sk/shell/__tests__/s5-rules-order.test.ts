/**
 * SK S5 integration (slice A's leader reads + slice D's school notice): the
 * rules ORDER after the merge. book code → (tutor / board) → parent → leader
 * read → act phrasings (remind → notice.school → diary.note …) → navigate.
 *  - "post a notice to the whole school" is still notice.school (any hat);
 *  - "post a notice to 7B" is still the class diary note;
 *  - the leader read phrasings go to school.health / the leader modes;
 *  - a book code still goes first, whatever the hat.
 */
import { describe, expect, it } from "vitest";
import { routeByRules } from "../rules";
import { makeCtx, NOW } from "./fixtures";
import { formatCode, generateEditionCode } from "@/sk/access";

const principal = () => makeCtx({ role: "school_admin", hat: "principal" });
const coordinator = () => makeCtx({ role: "teacher", hat: "coordinator", scope: [{ grade: "5", subject: null }] });
const teacher = () => makeCtx();
const CODE = generateEditionCode((n) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff)));

describe("S5 rules order after the notice merge", () => {
  it("a school-wide notice phrasing → notice.school, under every adult hat", () => {
    for (const ctx of [principal(), coordinator(), teacher()]) {
      for (const t of [
        "post a notice to the whole school: no school on Friday",
        "send an announcement to all staff about the meeting",
        "tell everyone the field trip is moved",
        "hantar notis kepada semua guru",
      ]) {
        expect(routeByRules(t, ctx, NOW), `${ctx.user.hat}: ${t}`).toEqual({ intent: "act", action: "notice.school" });
      }
    }
  });
  it('"post a notice to 7B" → the diary note, for the teacher AND under a leader hat', () => {
    for (const ctx of [teacher(), principal(), coordinator()]) {
      expect(routeByRules("post a notice to 7B: no school on Friday", ctx, NOW), String(ctx.user.hat)).toEqual({ intent: "act", action: "diary.note" });
    }
  });
  it("leader read phrasings → school.health / the leader modes (leader hats only)", () => {
    const cases: Array<[string, string, Record<string, string>]> = [
      ["how is the school doing", "school.health", { focus: "overview" }],
      ["which teachers have marking piling up", "school.health", { focus: "teachers" }],
      ["who's at risk in grade 5", "learners.risk", { grade: "grade 5" }],
      ["what's overdue", "assignments.status", {}],
      ["who is teaching now", "timetable.now_next", {}],
    ];
    for (const ctx of [principal(), coordinator()]) {
      for (const [t, capability, args] of cases) {
        expect(routeByRules(t, ctx, NOW), `${ctx.user.hat}: ${t}`).toEqual({ intent: "ask", leader: { capability, args } });
      }
    }
    // The teacher hat: never a leader route.
    for (const [t] of cases) expect(routeByRules(t, teacher(), NOW)).not.toHaveProperty("leader");
  });
  it("a leader read phrasing is never taken by the notice or diary rules", () => {
    expect(routeByRules("how is the school doing", principal(), NOW)).not.toMatchObject({ intent: "act" });
    expect(routeByRules("who's at risk", coordinator(), NOW)).not.toMatchObject({ intent: "act" });
  });
  it("a book code goes first, whatever the hat and the rest of the words", () => {
    const code = formatCode(CODE);
    for (const ctx of [principal(), coordinator(), teacher()]) {
      expect(routeByRules(`activate ${code}`, ctx, NOW)).toMatchObject({ intent: "act", action: "book.activate", book: { code: CODE } });
      expect(routeByRules(`post a notice to the whole school ${code}`, ctx, NOW)).toMatchObject({ intent: "act", action: "book.activate" });
      expect(routeByRules(`how is the school doing ${code}`, ctx, NOW)).toMatchObject({ intent: "act", action: "book.activate" });
    }
  });
});
