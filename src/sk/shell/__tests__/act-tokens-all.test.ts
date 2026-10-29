/**
 * The token suite across EVERY confirm-tier action /api/sk/act can execute
 * (assign, diary.note, parents.remind; S2 slice B: marking.grade, lesson.prepare;
 * S4 slice C: diary.note's PARENT branch, as parent A to her own child;
 * S4 slice D: book.activate — its "write" is the redeem RPC; S5 slice D:
 * notice.school — the principal's click-only school notice), against a stateful admin with 0163's
 * real consume semantics: single use, expired refused, altered params refused
 * (the HMAC is re-derived from the STORED row), a context change refused, and
 * a duplicate click — two at once — producing exactly ONE write.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/act-tokens-all.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACT_LINES, HANDLERS, executeAction, type ActInput } from "../act";
import { MemoryAuditSink } from "../audit";
import { freshMemory } from "../memory";
import { canonicalParams, type ActionParams } from "../tokens";
import type { SkContext } from "../types";
import { NOW, SCHOOL_ID, TEACHER_ID, makeCtx } from "./fixtures";
import { ACT_SECRET, AISYAH, ALI, BOOK, CLASS_7B, GEN, PRODUCT, SHARE, SITI, SUB, diarySession, signedRow, statefulAdmin, type RedeemWorld } from "./act-fakes";
import { childrenFromLinks } from "../context";
import { A2, LINKS, PA } from "@/sk/capabilities/__tests__/parent-fixtures";
import { generateEditionCode, hmacCode, hmacOrderNumber } from "@/sk/access";
import { maskCode, maskOrderNumber } from "@/sk/book-activate";

const ID = "88888888-8888-4888-8888-888888888888";
// S4 slice D: book.activate needs BOOK_CODE_SECRET at execution.
const BOOK_SECRET = "book-code-secret-of-adequate-length";
const EDITION = generateEditionCode((n) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 53 + 7) & 0xff)));
const ORDER = "123-1234567-1234567";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.SK_SHELL_SECRET = process.env.SK_SHELL_SECRET;
  saved.BOOK_CODE_SECRET = process.env.BOOK_CODE_SECRET;
  saved.FEATURE_NOTICES = process.env.FEATURE_NOTICES;
  process.env.SK_SHELL_SECRET = ACT_SECRET;
  process.env.BOOK_CODE_SECRET = BOOK_SECRET;
  // S5 slice D: notice.school needs the notices migration gate on.
  process.env.FEATURE_NOTICES = "true";
});
afterEach(() => {
  for (const k of ["SK_SHELL_SECRET", "BOOK_CODE_SECRET", "FEATURE_NOTICES"] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ACTIONS: Record<string, ActionParams> = {
  assign: { generation_id: GEN, class_id: CLASS_7B, due_at: "2026-10-30T09:00:00.000Z", class_name: "7B", kit_title: "Cells worksheet" },
  "diary.note": { class_id: CLASS_7B, note_type: "general", body: "No school on Friday.", parents_only: false, entry_date: "2026-10-28", target_label: "7B" },
  "parents.remind": {
    share_id: SHARE,
    generation_id: GEN,
    class_id: CLASS_7B,
    student_ids: `${ALI},${SITI}`,
    count: 2,
    body: 'Reminder: "Cells worksheet" is not done yet. Please encourage your child to finish it.',
    class_name: "7B",
    kit_title: "Cells worksheet",
  },
  "marking.grade": { submission_id: SUB, score: 7, out_of: 10, feedback: "Good work on part 2.", learner_label: "Ali Hassan", kit_title: "Cells worksheet" },
  "lesson.prepare": { book_id: BOOK, chapter_ref: "2", chapter_title: "Specialised Cells", book_title: "Biology", credits: 6, click_only: true },
};

/** S4 slices C+D: each case = an action, its stored params, whose Context
 *  (and token) it runs under, and (book.activate) a FRESH redeem RPC world per
 *  test (the fake marks codes used in place). The parent case is diary.note's
 *  parent branch. */
type Case = { action: string; params: ActionParams; ctx: (o?: { plan?: string }) => SkContext; user: string; redeem?: () => RedeemWorld };
const parentOf = (o: { plan?: string } = {}): SkContext => {
  const c = makeCtx({ role: "parent", userId: PA, hat: "parent", schoolId: null, plan: o.plan });
  c.children = childrenFromLinks(PA, LINKS);
  return c;
};
const CASES: Record<string, Case> = {
  ...Object.fromEntries(Object.entries(ACTIONS).map(([action, params]) => [action, { action, params, ctx: (o: { plan?: string } = {}) => makeCtx({ plan: o.plan }), user: TEACHER_ID }])),
  "diary.note (parent)": {
    action: "diary.note",
    params: { student_id: A2, note_type: "health", body: "Adam was sick yesterday.", parents_only: false, entry_date: "2026-10-28", target_label: "Adam Rahman", seen_by: "Seen by Adam's teacher, the school's leaders and Adam." },
    ctx: parentOf,
    user: PA,
  },
  /** S4 slice D: book.activate is the parent's (or a student's), not the teacher's. */
  "book.activate": {
    action: "book.activate",
    params: {
      code_kind: "Edition code (in the book)",
      code: maskCode(EDITION),
      order_ref: maskOrderNumber(ORDER),
      for_child_id: AISYAH,
      child_label: "Aisyah",
      click_only: true,
      sealed_kind: "edition",
      sealed_code_hmac: hmacCode(EDITION, BOOK_SECRET),
      sealed_order_hmac: hmacOrderNumber(ORDER, BOOK_SECRET),
    },
    ctx: (o: { plan?: string } = {}) => makeCtx({ role: "parent", hat: "parent", schoolId: null, plan: o.plan }),
    user: TEACHER_ID,
    redeem: () => ({ codes: { [hmacCode(EDITION, BOOK_SECRET)]: { product_id: PRODUCT } }, links: [{ parent: TEACHER_ID, child: AISYAH }] }),
  },
  /** S5 slice D: the principal's click-only school notice (one school_events row). */
  "notice.school": {
    action: "notice.school",
    params: {
      audience: "school",
      title: "No school on Friday",
      body: "No school on Friday. Classes resume on Monday.",
      starts_at: "2026-10-29",
      school_label: "Demo School",
      seen_by: "Every parent, student and teacher at Demo School",
      click_only: true,
    },
    ctx: (o: { plan?: string } = {}) => makeCtx({ role: "school_admin", hat: "principal", plan: o.plan }),
    user: TEACHER_ID,
  },
};

const TABLES = {
  classes: [{ id: CLASS_7B, name: "7B", teacher_id: TEACHER_ID }],
  generation_shares: [{ id: SHARE, generation_id: GEN, class_id: CLASS_7B }],
  enrollments: [
    { class_id: CLASS_7B, student_id: ALI, profiles: { full_name: "Ali Hassan" } },
    { class_id: CLASS_7B, student_id: SITI, profiles: { full_name: "Siti Aminah" } },
  ],
  student_progress: [],
  // S2 slice B: a file worksheet awaiting a grade on her own kit, and a book on her shelf.
  submissions: [{ id: SUB, generation_id: GEN, student_id: ALI, mode: "file", grade_status: "pending", auto_score: null, max_score: null, answers: null, submitted_at: "2026-10-27T01:00:00.000Z" }],
  generations: [{ id: GEN, kind: "worksheet", title: "Cells worksheet", chapter_ref: "1", book_id: null, owner_id: TEACHER_ID, params: null, status: "done" }],
  books: [{ id: BOOK, title: "Biology", subject: "Science", grade: "Form 4", language: "en", status: "ready", owner_id: TEACHER_ID, school_id: SCHOOL_ID, chapters: [{ num: 2, title: "Specialised Cells", parts: [] }] }],
  // S4 slice D: the book.activate parent's verified child, and the product's title.
  parent_links: [{ parent_id: TEACHER_ID, child_id: AISYAH, verified_at: "2026-10-01T00:00:00.000Z", profiles: { full_name: "Aisyah binti Ali" } }],
  sk_book_products: [{ id: PRODUCT, title: "Biology" }],
};

function world(name: string, o: { ctx?: SkContext; issuedFor?: SkContext; expiresAt?: string } = {}) {
  const c = CASES[name];
  const ctx = o.ctx ?? c.ctx();
  const { row, token } = signedRow({ id: ID, action: c.action, params: c.params, user_id: c.user, contextHash: (o.issuedFor ?? ctx).contextHash, ...(o.expiresAt ? { expires_at: o.expiresAt } : {}) });
  const admin = statefulAdmin({ [ID]: row }, NOW, c.redeem?.());
  const session = diarySession(structuredClone(TABLES)); // updates patch rows in place
  const sink = new MemoryAuditSink();
  const input = (over: Partial<ActInput> = {}): ActInput => ({ ctx, token, via: "click", turnId: "t-1", now: NOW, memory: freshMemory(ctx, NOW), admin, session, sink, ...over });
  /** Every write this world has seen: diary notes + assign's shares + grades that matched + kit rows + book grants + notices. */
  const writes = () => session.notes.length + admin.shareWrites.length + session.updates.reduce((n, u) => n + u.ids.length, 0) + session.generations.length + admin.grants.length + session.events.length;
  return { ctx, row, token, admin, session, sink, input, writes };
}

describe.each(Object.keys(CASES))("%s", (name) => {
  const action = CASES[name].action;
  it("is a registered handler", () => {
    expect(HANDLERS[action]).toBeDefined();
  });
  it("single use: the first click writes, the second is `already_used` and writes nothing", async () => {
    const w = world(name);
    const first = await executeAction(w.input());
    expect(first.response.outcome).toBe("done");
    const n = w.writes();
    expect(n).toBeGreaterThan(0);
    const second = await executeAction(w.input());
    expect(second.response).toEqual({ ok: false, outcome: "already_used", summary: ACT_LINES.already_used });
    expect(w.writes()).toBe(n);
  });
  it("a duplicate click — two at once — gives exactly one write and one `already_used`", async () => {
    const w = world(name);
    const [a, b] = await Promise.all([executeAction(w.input()), executeAction(w.input({ turnId: "t-2" }))]);
    expect([a.response.outcome, b.response.outcome].sort()).toEqual(["already_used", "done"]);
    const one = world(name);
    await executeAction(one.input());
    expect(w.writes()).toBe(one.writes()); // the same as a single click
  });
  it("expired → `expired`, nothing consumed or written", async () => {
    const w = world(name, { expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
    expect((await executeAction(w.input())).response).toEqual({ ok: false, outcome: "expired", summary: ACT_LINES.expired });
    expect(w.admin.calls).toEqual([]);
    expect(w.writes()).toBe(0);
  });
  it("altered params (the stored row changed after signing) → `refused`, nothing consumed", async () => {
    const w = world(name);
    const tampered = { ...w.row.params, class_id: "cf000000-0000-4000-8000-000000000003" };
    // A row whose params no longer match the signed canonical form…
    w.admin.rows[ID] = { ...w.row, params: tampered };
    expect((await executeAction(w.input())).response.outcome).toBe("refused");
    // …and one whose canonical form was rewritten too (the HMAC no longer matches).
    w.admin.rows[ID] = { ...w.row, params: tampered, params_canonical: canonicalParams(tampered) };
    expect((await executeAction(w.input())).response.outcome).toBe("refused");
    expect(w.admin.calls).toEqual([]);
    expect(w.writes()).toBe(0);
  });
  it("a context change between card and click (another hat) → `context_mismatch`, nothing consumed", async () => {
    // Issued as the teacher; the live Context is the same user under a different plan.
    const w = world(name, { issuedFor: CASES[name].ctx(), ctx: CASES[name].ctx({ plan: "pro" }) });
    expect((await executeAction(w.input())).response).toEqual({ ok: false, outcome: "context_mismatch", summary: ACT_LINES.context_mismatch });
    expect(w.admin.calls).toEqual([]);
    expect(w.writes()).toBe(0);
  });
  it("another user's token → `refused`", async () => {
    const w = world(name);
    w.admin.rows[ID] = { ...w.row, user_id: "99999999-9999-4999-8999-999999999999" };
    expect((await executeAction(w.input())).response.outcome).toBe("refused");
    expect(w.writes()).toBe(0);
  });
  it("every outcome leaves exactly one audit row, except assign's done (its RPC audits)", async () => {
    const w = world(name);
    await executeAction(w.input());
    await executeAction(w.input());
    const rows = w.sink.rows;
    expect(rows.length).toBe(action === "assign" ? 1 : 2);
    if (action !== "assign") expect(rows[0]).toMatchObject({ action, tier: "confirm", kind: "act", ok: true, token_id: ID });
    // The repeat fails verification (used_at is set), so no row is dispatched:
    // the audit carries the generic name and the decoded id in `result.token`.
    expect(rows[rows.length - 1]).toMatchObject({ action: "act", tier: "confirm", kind: "act", ok: false, error: "already_used", token_id: null, result: { token: ID } });
  });
});
