/**
 * S4 slice D — `book.activate` end to end below the routes:
 *   - the rules send a code (any role), an activation phrase (student /
 *     parent; EN / MS / AR) or the answer to SK's own question to
 *     book.activate — never to the model; words are not codes;
 *   - the resolver checks FORMAT only, asks for the order number (SKE) and
 *     for the child (2+), refuses a foreign child id before any card, and
 *     builds a card whose code is MASKED, with only HMACs in sealed params;
 *   - execution: a spoken yes is refused (click-only); an unlinked child is
 *     refused BEFORE the consume; no BOOK_CODE_SECRET → refused; every RPC
 *     outcome → its line; a replay → already_used; the redeem runs with the
 *     server-verified user; the code and its HMAC never reach the response or
 *     the audit row.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/act-book.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACT_CLICK_ONLY_LINE, ACT_LINES, executeAction, type ActInput } from "../act";
import { MemoryAuditSink } from "../audit";
import { freshMemory } from "../memory";
import { publicParams, type ActionParams } from "../tokens";
import { routeByRules, bookActivateOf } from "../rules";
import { lineFor } from "../lines";
import { BOOK_LINE_TABLES } from "../act-book-lines";
import { BOOK_REFUSALS } from "../act-book";
import type { SkContext } from "../types";
import { NOW, TEACHER_ID, makeCtx } from "./fixtures";
import { ACT_SECRET, AISYAH, OMAR, PRODUCT, diarySession, signedRow, statefulAdmin, type RedeemWorld } from "./act-fakes";
import { resolveBookActivate, encodeBookPending } from "@/sk/capabilities/book";
import { formatCode, generateCode, generateEditionCode, hmacCode, hmacOrderNumber } from "@/sk/access";
import { maskCode } from "@/sk/book-activate";

const BOOK_SECRET = "book-code-secret-of-adequate-length";
const rnd = (seed: number) => (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * seed + 5) & 0xff));
const EDITION = generateEditionCode(rnd(19));
const CARD = generateCode("SKB2", rnd(23));
const ORDER = "123-1234567-1234567";
const H = hmacCode(EDITION, BOOK_SECRET);
const OH = hmacOrderNumber(ORDER, BOOK_SECRET);
const ID = "66666666-6666-4666-8666-666666666666";
const L = BOOK_LINE_TABLES;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["SK_SHELL_SECRET", "BOOK_CODE_SECRET"]) saved[k] = process.env[k];
  process.env.SK_SHELL_SECRET = ACT_SECRET;
  process.env.BOOK_CODE_SECRET = BOOK_SECRET;
});
afterEach(() => {
  for (const k of ["SK_SHELL_SECRET", "BOOK_CODE_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const parent = (o: { locale?: string } = {}) => makeCtx({ role: "parent", hat: "parent", schoolId: null, ...o });
const student = () => makeCtx({ role: "student", hat: null });
const link = (child: string, name: string, verified = true) => ({ parent_id: TEACHER_ID, child_id: child, verified_at: verified ? "2026-10-01T00:00:00.000Z" : null, profiles: { full_name: name } });
const TABLES = (children = [link(AISYAH, "Aisyah binti Ali")]) => ({ parent_links: children, sk_book_products: [{ id: PRODUCT, title: "Biology" }] });

// ── Rules ────────────────────────────────────────────────────────────────────

describe("rules: what goes to book.activate (and never to a model)", () => {
  const route = (text: string, ctx: SkContext) => routeByRules(text, ctx, NOW);
  it("a code, with the child named, in EN — and the order number when given", () => {
    const d = route(`activate my book code ${formatCode(EDITION)} for Aisyah`, parent());
    expect(d).toEqual({ intent: "act", action: "book.activate", book: { code: EDITION, childQuery: "Aisyah" } });
    const e = route(`${formatCode(EDITION)} order ${ORDER}`, parent());
    expect(e).toMatchObject({ book: { code: EDITION, orderNumber: ORDER } });
  });
  it("activation phrases for students and parents (EN / MS / AR)", () => {
    for (const text of ["I have a code", "activate my book", "please redeem a code", "aktifkan kod buku", "saya ada kod", "فعّل الكود", "عندي كود"]) {
      expect(route(text, parent()), text).toMatchObject({ intent: "act", action: "book.activate" });
      expect(route(text, student()), text).toMatchObject({ intent: "act", action: "book.activate" });
    }
  });
  it("a teacher's phrase is not an activation; a teacher's CODE still never goes to the model", () => {
    expect(route("I have a code", makeCtx())).not.toMatchObject({ action: "book.activate" });
    expect(route(`here is ${formatCode(CARD)}`, makeCtx())).toMatchObject({ intent: "act", action: "book.activate", book: { code: CARD } });
  });
  it("questions and words are not activations", () => {
    expect(route("how do I activate my book?", parent())).not.toMatchObject({ action: "book.activate" });
    expect(route("what does a skeleton do", student())).not.toMatchObject({ action: "book.activate" });
  });
  it("the answer to SK's own question: an order number, or a short name when it asked which child", () => {
    const asked = (need: "order" | "child") => {
      const c = parent();
      c.pending = encodeBookPending({ need, kind: "edition", h: H, m: maskCode(EDITION) });
      return c;
    };
    expect(bookActivateOf(ORDER, ORDER, asked("order"))).toEqual({ orderNumber: ORDER });
    expect(bookActivateOf("Aisyah", "aisyah", asked("child"))).toEqual({ childQuery: "Aisyah" });
    expect(bookActivateOf("untuk Omar", "untuk omar", asked("child"))).toEqual({ childQuery: "Omar" });
    // Only while SK is waiting, and never a navigate.
    expect(bookActivateOf("Aisyah", "aisyah", parent())).toBeNull();
    expect(bookActivateOf("open analytics", "open analytics", asked("child"))).toBeNull();
    expect(bookActivateOf("Aisyah", "aisyah", asked("order"))).toBeNull();
  });
});

// ── Resolver (the card) ──────────────────────────────────────────────────────

describe("resolver: format only, asks, then a masked card", () => {
  const deps = (children?: ReturnType<typeof link>[]) => ({ session: diarySession(TABLES(children)), now: NOW });
  it("parent, one verified child, edition code + order → the card for her, code masked, only HMACs sealed", async () => {
    const r = await resolveBookActivate(parent(), { code: formatCode(EDITION), orderNumber: ORDER }, deps());
    expect(r.ok).toBe(true);
    expect(r.confirm?.action).toBe("book.activate");
    expect(r.confirm?.title).toBe("Activate a book code for Aisyah");
    const p = r.confirm!.params;
    expect(p).toMatchObject({ code: maskCode(EDITION), for_child_id: AISYAH, child_label: "Aisyah", click_only: true, sealed_kind: "edition", sealed_code_hmac: H, sealed_order_hmac: OH });
    expect(p.order_ref).toBe("•••-•••••••-•••4567");
    // The full code (and the order number) are nowhere in the card, summary or facts.
    const visible = JSON.stringify({ title: r.confirm!.title, params: publicParams(p), summary: r.summary, facts: r.facts });
    expect(visible).not.toContain(EDITION);
    expect(visible).not.toContain(formatCode(EDITION));
    expect(visible).not.toContain("1234567-1234567");
    expect(visible).not.toContain("sealed_");
    expect(JSON.stringify(p)).not.toContain(EDITION); // even the stored params hold the HMAC, not the code
    expect(r.pending).toBeNull();
  });
  it("a code card needs no order number; a student activates for herself", async () => {
    const r = await resolveBookActivate(student(), { code: CARD }, deps());
    expect(r.confirm?.title).toBe("Activate a book code");
    expect(r.confirm?.params).toMatchObject({ for_child_id: null, sealed_kind: "card", sealed_code_hmac: hmacCode(CARD, BOOK_SECRET) });
    expect(r.confirm?.params.child_label).toBeUndefined();
  });
  it("no code → asks; a malformed code → says so (no RPC, no card)", async () => {
    expect((await resolveBookActivate(parent(), {}, deps())).summary).toBe(lineFor(L.askCode, "en"));
    const bad = await resolveBookActivate(parent(), { code: "SKE-AAAA-BBBB-CCCC-DDDDD" }, deps());
    expect(bad).toMatchObject({ ok: false, error: "bad_code", summary: lineFor(L.badCode, "en") });
    expect(bad.confirm).toBeUndefined();
  });
  it("an edition code without the order number asks for it and holds the HMAC (not the code) as pending", async () => {
    const r = await resolveBookActivate(parent(), { code: EDITION }, deps());
    expect(r.summary).toBe(lineFor(L.askOrder, "en"));
    expect(r.confirm).toBeUndefined();
    expect(r.pending?.task).toBe("book.activate");
    expect(JSON.stringify(r.pending)).not.toContain(EDITION);
    expect(JSON.stringify(r.pending)).toContain(H);
    // The answer on the next turn completes it.
    const c = parent();
    c.pending = r.pending!;
    const next = await resolveBookActivate(c, { orderNumber: ORDER }, deps());
    expect(next.confirm?.params).toMatchObject({ sealed_code_hmac: H, sealed_order_hmac: OH, for_child_id: AISYAH });
  });
  it("two children → asks which (no default); the name on the next turn picks one", async () => {
    const two = [link(AISYAH, "Aisyah binti Ali"), link(OMAR, "Omar Hakim")];
    const r = await resolveBookActivate(parent(), { code: CARD }, deps(two));
    expect(r.summary).toBe(lineFor(L.askChild, "en", { names: "Aisyah / Omar" }));
    expect(r.confirm).toBeUndefined();
    const c = parent();
    c.pending = r.pending!;
    const next = await resolveBookActivate(c, { childQuery: "Omar" }, deps(two));
    expect(next.confirm?.title).toBe("Activate a book code for Omar");
    expect(next.confirm?.params.for_child_id).toBe(OMAR);
  });
  it("an unverified link is not a child; a foreign child id is refused before any card", async () => {
    const r = await resolveBookActivate(parent(), { code: CARD, childQuery: "Omar" }, deps([link(AISYAH, "Aisyah"), link(OMAR, "Omar", false)]));
    expect(r).toMatchObject({ ok: false, error: "child_not_found" });
    const f = await resolveBookActivate(parent(), { code: CARD, childId: OMAR }, deps());
    expect(f).toMatchObject({ ok: false, error: "not_your_child", summary: lineFor(L.notYourChild, "en") });
    expect(f.confirm).toBeUndefined();
  });
  it("without BOOK_CODE_SECRET: 'Book codes aren't switched on yet.' and no card", async () => {
    delete process.env.BOOK_CODE_SECRET;
    const r = await resolveBookActivate(parent(), { code: CARD }, deps());
    expect(r).toMatchObject({ ok: false, error: "not_configured", summary: "Book codes aren't switched on yet." });
  });
  it("speaks the user's language (ms)", async () => {
    const r = await resolveBookActivate(parent({ locale: "ms" }), { code: CARD }, deps());
    expect(r.confirm?.title).toBe("Aktifkan kod buku untuk Aisyah");
  });
});

// ── Execution ────────────────────────────────────────────────────────────────

const CARD_PARAMS = (o: Partial<ActionParams> = {}): ActionParams => ({
  code_kind: "Edition code (in the book)",
  code: maskCode(EDITION),
  order_ref: "•••-•••••••-•••4567",
  for_child_id: AISYAH,
  child_label: "Aisyah",
  click_only: true,
  sealed_kind: "edition",
  sealed_code_hmac: H,
  sealed_order_hmac: OH,
  ...o,
});

function world(o: { ctx?: SkContext; params?: ActionParams; redeem?: Partial<RedeemWorld>; children?: ReturnType<typeof link>[] } = {}) {
  const ctx = o.ctx ?? parent();
  const { row, token } = signedRow({ id: ID, action: "book.activate", params: o.params ?? CARD_PARAMS(), contextHash: ctx.contextHash });
  const redeem: RedeemWorld = { codes: { [H]: { product_id: PRODUCT }, [hmacCode(CARD, BOOK_SECRET)]: { product_id: PRODUCT } }, links: [{ parent: TEACHER_ID, child: AISYAH }], ...o.redeem };
  const admin = statefulAdmin({ [ID]: row }, NOW, redeem);
  const session = diarySession(TABLES(o.children));
  const sink = new MemoryAuditSink();
  const input = (over: Partial<ActInput> = {}): ActInput => ({ ctx, token, via: "click", turnId: "t-1", now: NOW, memory: freshMemory(ctx, NOW), admin, session, sink, ...over });
  return { ctx, admin, session, sink, input, redeem };
}

describe("execution (/api/sk/act → act-book.ts)", () => {
  it("a click redeems FOR THE CHILD as the server-verified parent and says so", async () => {
    const w = world();
    const out = await executeAction(w.input());
    expect(out.response).toMatchObject({ ok: true, outcome: "done", summary: "Biology is now unlocked for Aisyah." });
    expect(w.admin.grants).toEqual([{ user: TEACHER_ID, child: AISYAH, product: PRODUCT }]);
    const rpc = w.admin.calls.find((c) => c.fn === "redeem_edition_code")!;
    expect(rpc.args).toMatchObject({ p_code_hmac: H, p_order_hmac: OH, p_user: TEACHER_ID, p_for_child: AISYAH, p_channel: "kdp" });
    // consume first, then the redeem
    expect(w.admin.calls.map((c) => c.fn)).toEqual(["sk_consume_action_token", "redeem_edition_code"]);
  });
  it("a student's code card: for herself", async () => {
    const ctx = student();
    const w = world({ ctx, params: CARD_PARAMS({ code: maskCode(CARD), sealed_kind: "card", sealed_code_hmac: hmacCode(CARD, BOOK_SECRET), sealed_order_hmac: null, order_ref: null, for_child_id: null, child_label: null }) });
    const out = await executeAction(w.input());
    expect(out.response).toMatchObject({ outcome: "done", summary: "Biology is now unlocked." });
    expect(w.admin.calls.find((c) => c.fn === "redeem_book_code")?.args).toMatchObject({ p_user: TEACHER_ID, p_for_child: null, p_days: 30 });
  });
  it("a spoken yes is refused (click-only) and nothing is consumed", async () => {
    const w = world();
    const out = await executeAction(w.input({ via: "voice" }));
    expect(out.response).toEqual({ ok: false, outcome: "refused", summary: ACT_CLICK_ONLY_LINE });
    expect(w.admin.calls).toEqual([]);
  });
  it("an unlinked child is refused BEFORE the consume (the card stays unspent)", async () => {
    const w = world({ params: CARD_PARAMS({ for_child_id: OMAR, child_label: "Omar" }) });
    const out = await executeAction(w.input());
    expect(out.response).toMatchObject({ ok: false, outcome: "refused", summary: lineFor(L.notYourChild, "en"), result: { reason: "not_your_child" } });
    expect(w.admin.calls).toEqual([]);
    // An unverified link is not a link either.
    const u = world({ children: [link(AISYAH, "Aisyah", false)] });
    expect((await executeAction(u.input())).response.outcome).toBe("refused");
    expect(u.admin.calls).toEqual([]);
  });
  it("without BOOK_CODE_SECRET → refused with 'Book codes aren't switched on yet.', nothing consumed", async () => {
    const w = world();
    delete process.env.BOOK_CODE_SECRET;
    const out = await executeAction(w.input());
    expect(out.response).toMatchObject({ ok: false, outcome: "refused", summary: "Book codes aren't switched on yet." });
    expect(w.admin.calls).toEqual([]);
  });
  it("every RPC refusal → its outcome and line", async () => {
    for (const [reason, m] of Object.entries(BOOK_REFUSALS)) {
      const w = world({ redeem: { force: reason } });
      const out = await executeAction(w.input());
      expect(out.response, reason).toMatchObject({ ok: false, outcome: m.outcome, summary: lineFor(m.line, "en"), result: { reason } });
    }
    expect(BOOK_REFUSALS.used.outcome).toBe("already_used");
    const e = world({ redeem: { forceError: true } });
    expect((await executeAction(e.input())).response).toMatchObject({ ok: false, outcome: "error", summary: lineFor(L.failed, "en") });
  });
  it("a code already spent elsewhere → already_used: 'This code has already been used.'", async () => {
    const w = world({ redeem: { codes: { [H]: { used: true } } } });
    expect((await executeAction(w.input())).response).toMatchObject({ outcome: "already_used", summary: "This code has already been used." });
  });
  it("a replay of the same card → already_used, one grant", async () => {
    const w = world();
    await executeAction(w.input());
    const again = await executeAction(w.input());
    expect(again.response).toEqual({ ok: false, outcome: "already_used", summary: ACT_LINES.already_used });
    expect(w.admin.grants.length).toBe(1);
  });
  it("a malformed stored row is refused before the consume", async () => {
    const w = world({ params: CARD_PARAMS({ sealed_code_hmac: "not-a-hash" }) });
    expect((await executeAction(w.input())).response).toMatchObject({ outcome: "refused", result: { reason: "bad_params" } });
    expect(w.admin.calls).toEqual([]);
  });
  it("neither the code nor its HMAC reaches the response or the audit row", async () => {
    const w = world();
    const out = await executeAction(w.input());
    await executeAction(w.input()); // the replay's audit row too
    const everything = JSON.stringify({ response: out.response, audit: w.sink.rows, memory: out.memory });
    expect(everything).not.toContain(EDITION);
    expect(everything).not.toContain(formatCode(EDITION));
    expect(everything).not.toContain(H);
    expect(everything).not.toContain(OH);
    expect(everything).not.toContain("sealed_");
    expect(w.sink.rows[0]).toMatchObject({ action: "book.activate", ok: true, params: { code: maskCode(EDITION), for_child_id: AISYAH } });
  });
});
