/**
 * S4 slice C — `diary.note`'s PARENT branch, resolver and execution, on the
 * two-family fixture (parent A: Aisyah at home + Adam at school in 5 Amanah;
 * parent B: Zara at home). The fake session is LEAKY (it ignores filters), so
 * the "who sees it" line proves its own cut to the one child.
 *
 *   - a parent's note to her own child: a card with student_id ONLY, the exact
 *     words, and the line saying who will see it (school child / home child /
 *     parents_only); executed, it inserts through the SESSION client as her;
 *   - a class target is refused (before anything is read);
 *   - an unlinked, unverified or forged child is refused — at resolve time no
 *     card is issued, and at execution BEFORE the token is consumed;
 *   - two children and none named → SK asks which;
 *   - a spoken yes confirms it (single child, confirm tier, not click-only).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/diary-parent.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diaryAudience, diaryNoteAction, isParentWriter, resolveDiaryNote, seenByLine } from "../diary";
import { ACT_NOT_ALLOWED_LINE, CLICK_ONLY, HANDLERS, executeAction, type ActInput } from "@/sk/shell/act";
import { MemoryAuditSink } from "@/sk/shell/audit";
import { freshMemory } from "@/sk/shell/memory";
import { routeByRules } from "@/sk/shell/rules";
import type { ActionParams } from "@/sk/shell/tokens";
import type { SkCapabilityResult, SkContext } from "@/sk/shell/types";
import { ACT_SECRET, diarySession, signedRow, statefulAdmin } from "@/sk/shell/__tests__/act-fakes";
import { makeCtx } from "@/sk/shell/__tests__/fixtures";
import { A1, A2, B1, NOW, PA, PB, X, leakySession, parentCtx } from "./parent-fixtures";

const run = (ctx: SkContext, args: Record<string, unknown>, log: string[] = []) => resolveDiaryNote(ctx, args, { session: leakySession(log), now: NOW });
const card = (r: SkCapabilityResult) => r.confirm!;

describe("diary.note — parent branch: the card", () => {
  it("a note to her school child: student_id only, her exact words, general, today, and who will see it", async () => {
    const r = await run(parentCtx(PA), { child: "Adam", body: "Adam was sick yesterday and could not finish his homework." });
    expect(r.ok).toBe(true);
    expect(card(r)).toEqual({
      action: "diary.note",
      title: "Write in Adam's diary",
      params: {
        student_id: A2,
        note_type: "general",
        body: "Adam was sick yesterday and could not finish his homework.",
        parents_only: false,
        entry_date: "2026-10-28",
        target_label: "Adam Rahman",
        seen_by: "Seen by Adam's teacher, the school's leaders and Adam.",
      },
    });
    expect("class_id" in card(r).params).toBe(false);
    expect(r.entities).toEqual([{ kind: "learner", id: A2, label: "Adam Rahman", via: "diary.note" }]);
  });

  it("a home learner: allowed, and the card says it is for the parent's own record and the child", async () => {
    const r = await run(parentCtx(PA), { child: "Aisyah", body: "Aisyah finished her reading log." });
    expect(card(r).params).toMatchObject({ student_id: A1, seen_by: "Aisyah learns at home — this note is for your own record and Aisyah." });
  });

  it("parents_only (\"just for the teacher, not Adam\") hides it from the CHILD only — the line says so truthfully", async () => {
    const school = await run(parentCtx(PA), { child: "Adam", body: "He is worried about the test.", parentsOnly: true, type: "concern" });
    expect(card(school).params).toMatchObject({ parents_only: true, note_type: "concern", seen_by: "Seen by Adam's teacher and the school's leaders — not by Adam." });
    const home = await run(parentCtx(PA), { child: "Aisyah", body: "Doctor's visit on Friday.", parentsOnly: true, type: "health" });
    expect(card(home).params).toMatchObject({ parents_only: true, note_type: "health", seen_by: "Aisyah learns at home — this note is for your own record only; Aisyah won't see it." });
  });

  it("the audience rule (0066 dn_read), pure: teacher + school / teacher only / school leaders only / home", () => {
    const child = { firstName: "Aisyah" };
    expect(diaryAudience({ schoolId: "s1" }, true)).toBe("school");
    expect(diaryAudience({ schoolId: null }, true)).toBe("teacher");
    expect(diaryAudience({ schoolId: "s1" }, false)).toBe("leaders");
    expect(diaryAudience({ schoolId: null }, false)).toBe("home");
    expect(seenByLine(child, "teacher", false, "en")).toBe("Seen by Aisyah's teacher and Aisyah.");
    expect(seenByLine(child, "teacher", true, "en")).toBe("Seen by Aisyah's teacher — not by Aisyah.");
    expect(seenByLine(child, "leaders", false, "en")).toBe("Aisyah has no class teacher yet — seen by the school's leaders and Aisyah.");
    expect(seenByLine(child, "school", false, "ms")).toBe("Dilihat oleh guru Aisyah, pimpinan sekolah dan Aisyah.");
    expect(seenByLine(child, "home", false, "ar")).toBe("Aisyah يتعلم في البيت — هذه الملاحظة لسجلك أنت ولـAisyah.");
  });

  it("note types: health / concern / reminder / praise / general as said; homework (the teacher's word) or nonsense → general", async () => {
    for (const type of ["health", "concern", "reminder", "praise", "general"]) {
      expect(card(await run(parentCtx(PB), { body: "x", type })).params.note_type).toBe(type);
    }
    expect(card(await run(parentCtx(PB), { body: "x", type: "homework" })).params.note_type).toBe("general");
    expect(card(await run(parentCtx(PB), { body: "x", type: "behaviour" })).params.note_type).toBe("general");
  });

  it("one child, none named → that child; the day is carried as said", async () => {
    const r = await run(parentCtx(PB), { body: "Zara will be late tomorrow.", entryDate: "tomorrow" });
    expect(card(r).params).toMatchObject({ student_id: B1, entry_date: "2026-10-29", target_label: "Zara Lim", seen_by: "Zara learns at home — this note is for your own record and Zara." });
  });

  it("two children, none named (or 'my kids') → SK asks which; no card", async () => {
    for (const args of [{ body: "She was sick yesterday." }, { child: "my kids", body: "x" }]) {
      const r = await run(parentCtx(PA), args);
      expect(r.ok).toBe(true);
      expect(r.confirm).toBeUndefined();
      expect(r.summary).toBe("Which child do you mean — Aisyah, Adam?");
      expect(r.entities?.map((e) => e.id)).toEqual([A1, A2]);
    }
  });

  it("the page names the child (/dashboard/reports/<id>) → that child, no question", async () => {
    const ctx = makeCtx({ role: "parent", userId: PA, hat: "parent", schoolId: null, selection: { learnerId: A1 } });
    ctx.children = parentCtx(PA).children;
    expect(card(await run(ctx, { body: "x" })).params.student_id).toBe(A1);
  });

  it("a class target is NEVER allowed for a parent — refused before anything is read", async () => {
    for (const args of [{ classQuery: "5 Amanah", body: "x" }, { classId: "cc000000-0000-4000-8000-0000000000c1", body: "x" }, { classQuery: "5 Amanah", child: "Adam", body: "x" }]) {
      const log: string[] = [];
      const r = await run(parentCtx(PA), args, log);
      expect(r).toMatchObject({ ok: false, error: "class_not_allowed", summary: "A note from you goes to one child's diary, not a class — which child is it for?" });
      expect(r.confirm).toBeUndefined();
      expect(log).toEqual([]);
    }
  });

  it("an unlinked child (another family's, a classmate, a forged id, an unknown name) → refused, no card, nothing read", async () => {
    for (const child of ["Zara", B1, X, "Xavier", "deadbeef-0000-4000-8000-000000000000"]) {
      const log: string[] = [];
      const r = await run(parentCtx(PA), { child, body: "x" }, log);
      expect(r, child).toMatchObject({ ok: false, error: "not_linked" });
      expect(r.confirm).toBeUndefined();
      expect(log).toEqual([]);
    }
    // learnerId / learnerQuery (the teacher's words) go through the same gate.
    expect(await run(parentCtx(PA), { learnerId: B1, body: "x" })).toMatchObject({ ok: false, error: "not_linked" });
    expect(await run(parentCtx(PA), { learnerQuery: "Zara", body: "x" })).toMatchObject({ ok: false, error: "not_linked" });
  });

  it("an unverified link → refused with its own line; a parent with no children → refused", async () => {
    const ctx = parentCtx(PA);
    ctx.children = ctx.children!.map((c) => (c.id === A2 ? { ...c, verified: false } : c));
    expect(await run(ctx, { child: "Adam", body: "x" })).toMatchObject({ ok: false, error: "unverified", summary: "Adam's link isn't verified yet, so I can't write in their diary." });
    const none = parentCtx(PA);
    none.children = [];
    expect(await run(none, { body: "x" })).toMatchObject({ ok: false, error: "no_children" });
  });

  it("an adult in the parent hat writes as a parent; in the teacher hat the teacher branch is unchanged", async () => {
    const parentHat = makeCtx({ hat: "parent" });
    parentHat.children = parentCtx(PA).children;
    expect(isParentWriter(parentHat)).toBe(true);
    expect(card(await run(parentHat, { child: "Adam", body: "x" })).params).toMatchObject({ student_id: A2 });
    expect(isParentWriter(makeCtx())).toBe(false);
    expect(isParentWriter(makeCtx({ hat: null }))).toBe(false);
  });

  it("the card's words in the parent's language (ms)", async () => {
    const r = await run(parentCtx(PA, "ms"), { child: "Adam", body: "Adam demam semalam." });
    expect(card(r).title).toBe("Tulis dalam diari Adam");
    expect(card(r).params.seen_by).toBe("Dilihat oleh guru Adam, pimpinan sekolah dan Adam.");
  });

  it("the resolver never writes", async () => {
    const log: string[] = [];
    await run(parentCtx(PA), { child: "Adam", body: "x" }, log);
    expect(log.some((l) => /insert|update|upsert|delete/.test(l))).toBe(false);
    expect(log.every((l) => l.startsWith("enrollments."))).toBe(true);
  });
});

describe("diary.note — parent phrasings → act (EN / MS / AR)", () => {
  const ctx = parentCtx(PA);
  it.each([
    "tell Aisyah's teacher she was sick yesterday",
    "tell Adam's teacher that he will be absent on Friday",
    "let Adam's teacher know he forgot his book",
    "please tell my son's teacher he has a fever",
    "write in Adam's diary that he did his reading",
    "add a note to Aisyah's diary: she finished chapter 2",
    "tulis dalam diari Aisyah: dia demam semalam",
    "beritahu cikgu Adam dia tidak sihat hari ini",
    "tolong beritahu guru kelas Adam bahawa dia akan lewat",
    "اكتب في مذكرة آدم أنه كان مريضا أمس",
    "أخبر معلمة عائشة أنها كانت مريضة",
  ])("%s", (text) => {
    expect(routeByRules(text, ctx, NOW)).toEqual({ intent: "act", action: "diary.note" });
  });
  it("questions are not actions (a parent's diary READ keeps its route)", () => {
    expect(routeByRules("did you tell Adam's teacher?", ctx, NOW)).not.toEqual({ intent: "act", action: "diary.note" });
    expect(routeByRules("what's in Adam's diary", ctx, NOW)).toMatchObject({ intent: "ask", parent: { capability: "child.diary" } });
  });
});

// ── Execution ────────────────────────────────────────────────────────────────

const ID = "66666666-6666-4666-8666-666666666666";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.SK_SHELL_SECRET = process.env.SK_SHELL_SECRET;
  process.env.SK_SHELL_SECRET = ACT_SECRET;
});
afterEach(() => {
  if (saved.SK_SHELL_SECRET === undefined) delete process.env.SK_SHELL_SECRET;
  else process.env.SK_SHELL_SECRET = saved.SK_SHELL_SECRET;
});

const NOTE: ActionParams = {
  student_id: A2,
  note_type: "health",
  body: "Adam was sick yesterday.",
  parents_only: false,
  entry_date: "2026-10-28",
  target_label: "Adam Rahman",
  seen_by: "Seen by Adam's teacher, the school's leaders and Adam.",
};

function setup(params: ActionParams, o: { ctx?: SkContext; via?: "click" | "voice" } = {}) {
  const ctx = o.ctx ?? parentCtx(PA);
  const { row, token } = signedRow({ id: ID, action: "diary.note", params, contextHash: ctx.contextHash, user_id: PA });
  const admin = statefulAdmin({ [ID]: row });
  const session = diarySession({});
  const sink = new MemoryAuditSink();
  const input: ActInput = { ctx, token, via: o.via ?? "click", turnId: "t-1", now: NOW, memory: freshMemory(ctx, NOW), admin, session, sink };
  const consumes = () => admin.calls.filter((c) => c.fn === "sk_consume_action_token");
  return { ctx, input, admin, session, sink, consumes };
}

describe("diary.note — parent branch: execution", () => {
  it("her note to her own child inserts ONE row through the SESSION client: author = her, student_id only, sk_action_id = token id", async () => {
    const w = setup(NOTE);
    const out = await executeAction(w.input);
    expect(out.response).toEqual({
      ok: true,
      outcome: "done",
      summary: "Posted to Adam Rahman's diary.",
      result: { note_id: "note-1", student_id: A2, entry_date: "2026-10-28", parents_only: false },
    });
    expect(w.session.notes).toEqual([
      { author_id: PA, class_id: null, student_id: A2, note_type: "health", body: "Adam was sick yesterday.", parents_only: false, entry_date: "2026-10-28", sk_action_id: ID, id: "note-1" },
    ]);
    expect(w.consumes()).toHaveLength(1);
    expect(w.sink.rows[0]).toMatchObject({ action: "diary.note", role: "parent", hat: "parent", ok: true, token_id: ID });
  });

  it("a spoken yes confirms it (one child; diary.note is not click-only)", async () => {
    expect(CLICK_ONLY.has("diary.note")).toBe(false);
    expect(HANDLERS["diary.note"].clickOnly ?? false).toBe(false);
    const w = setup(NOTE, { via: "voice" });
    expect((await executeAction(w.input)).response.outcome).toBe("done");
    expect(w.session.notes).toHaveLength(1);
  });

  const refusedBeforeConsume = async (w: ReturnType<typeof setup>) => {
    const out = await executeAction(w.input);
    expect(out.response).toEqual({ ok: false, outcome: "refused", summary: ACT_NOT_ALLOWED_LINE, result: { reason: "not_your_child" } });
    expect(w.consumes()).toEqual([]);
    expect(w.admin.rows[ID].used_at).toBeNull();
    expect(w.session.notes).toEqual([]);
    expect(w.sink.rows[0]).toMatchObject({ action: "diary.note", ok: false, error: "refused:not_your_child" });
  };

  it("a class target is refused for a parent BEFORE the consume (even on a validly signed row)", async () => {
    await refusedBeforeConsume(setup({ ...NOTE, student_id: null, class_id: "cc000000-0000-4000-8000-0000000000c1", target_label: "5 Amanah" }));
    await refusedBeforeConsume(setup({ ...NOTE, class_id: "cc000000-0000-4000-8000-0000000000c1" }));
  });

  it("another family's child, a classmate or a forged id is refused BEFORE the consume", async () => {
    for (const sid of [B1, X, "deadbeef-0000-4000-8000-000000000000"]) await refusedBeforeConsume(setup({ ...NOTE, student_id: sid }));
  });

  it("a link unverified — or removed — between the card and the click is refused BEFORE the consume", async () => {
    const unverified = parentCtx(PA);
    unverified.children = unverified.children!.map((c) => (c.id === A2 ? { ...c, verified: false } : c));
    await refusedBeforeConsume(setup(NOTE, { ctx: unverified }));
    const removed = parentCtx(PA);
    removed.children = removed.children!.filter((c) => c.id !== A2);
    await refusedBeforeConsume(setup(NOTE, { ctx: removed }));
  });

  it("the act meta re-check passes for a parent (metaAllows), and the executor is S2's unchanged", () => {
    expect(HANDLERS["diary.note"].meta).toBe(diaryNoteAction.meta);
    expect(diaryNoteAction.meta.roles).toContain("parent");
  });
});
