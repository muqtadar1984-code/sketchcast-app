/**
 * SK B8 — entitlement and metering IN THE LOOP, on both production wirings
 * (in-memory store + static entitlements; Supabase store + Supabase
 * entitlements over the strict fake of 0022/0156/0157/0158/0159):
 *
 *   who may open      a school licence, an SK plan, or a live grant for the
 *                     product → the session opens; nobody else (403, reason
 *                     "no_book_access"); the founder's staff grant is the
 *                     default seed and must keep working;
 *   who may ask live  tutoring access with allowance left; with the window
 *                     over or the allowance spent the session still opens
 *                     and commands / checks run, but a free-text question
 *                     gets SK's own line and NO model call;
 *   what is counted   one live_turn per turn that reached the router or the
 *                     teacher model (never a rule-matched command), one
 *                     generated_segment per accepted aside; with
 *                     FEATURE_SK_ALLOWANCE off usage is written and nothing is
 *                     refused for it.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/access-loop.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { LIVE_ENDED_TEXT, LIVE_EXHAUSTED_TEXT, NO_BOOK_ACCESS_TEXT } from "../access-notice";
import { uuidv7 } from "../ids";
import { openSession, runCommand, runTurn, sessionView, submitAnswer, type SessionView } from "../loop";
import { ASIDE_TOOL } from "../teacher";
import type { SseEvent } from "../types";
import { PRODUCT, SLUG } from "./cells-fixtures";
import { ITEM, LOOP_WIRINGS, staffGrant, STUDENT, supabaseLoopDeps, type AccessSeed, type HarnessOpts, type LoopHarness } from "./supabase-loop-deps";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 27, 12, 0, 0); // 2026-10-27T12:00Z
const clock = (t = T0) => () => t;
const open = (h: LoopHarness) => openSession(h.deps, { studentId: h.studentId, productId: SLUG, chapter: 2 });
const collect = async (gen: AsyncGenerator<SseEvent>) => {
  const out: SseEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};
const text = (evs: SseEvent[]) => evs.filter((e) => e.event === "text").map((e) => String(e.data)).join("");
const done = (evs: SseEvent[]) => evs.find((e) => e.event === "done")!.data as { view: SessionView; metered?: { live_turns: number; generated_segments: number } };
const ask = (h: LoopHarness, s: Awaited<ReturnType<typeof open>>, q: string) => collect(runTurn(h.deps, s, { eventId: uuidv7(), utterance: { text: q, modality: "typed" }, cursor: { unitKey: "s1", assetId: "s1-explain-main", t: 2000 } }));
/** The key usage is written under on each wiring: the product's uuid on Supabase, the slug on the static source. */
const usageKey = (h: LoopHarness) => (h.db ? PRODUCT : SLUG);
const usage = (h: LoopHarness) => h.store.getUsage(STUDENT, usageKey(h), "2026-10");

/** A teacher that answers in two chunks and draws one small aside (a `write` needs no target). */
const teacher = () => new StubProvider([{ text: ["The eyepiece ", "is the top lens."], toolCalls: [{ id: "t1", name: ASIDE_TOOL.name, args: { tal: "0.2-aside", duration_ms: 1000, actions: [{ op: "write", id: "g1", text: "eyepiece", at: { x: 10, y: 10 }, size: 3, t: 0, dur: 500 }], gestures: [] } }] }]);
/** A router with nothing to propose: the call is made, the default intent (a question) follows. */
const silentRouter = () => new StubProvider([{ text: [] }]);

const expiredTutor = (now: number): AccessSeed => ({ grants: [{ ...staffGrant(now), source: "code", tutor_expires_at: new Date(now - DAY).toISOString() }] });
const metered = (now: number, live_turns: number): AccessSeed => ({ grants: [{ ...staffGrant(now), source: "edition_code", usage_allowance: { live_turns } }] });

describe.each(LOOP_WIRINGS)("B8 access and metering in the loop — $name", ({ make }) => {
  const withProviders = (opts: HarnessOpts, p: { teacher?: StubProvider; router?: StubProvider } = {}) => {
    const h = make({ now: clock(), ...opts });
    h.deps.teacherProvider = p.teacher;
    h.deps.routerProvider = p.router;
    return h;
  };

  describe("who may open", () => {
    it("the founder's staff grant (the default seed): opens with source grant/staff, tutoring on, nothing metered yet", async () => {
      const h = withProviders({});
      const s = await open(h);
      const v = await sessionView(h.deps, s);
      expect(v.access).toEqual({ source: "grant", grantSource: "staff", book: true, tutor: true, tutorExpiresAt: new Date(T0 + 365 * DAY).toISOString(), allowance: null, liveExhausted: false, warning: "none", enforced: false });
      expect(await usage(h)).toBeNull();
    });
    it("no licence, no plan, no grant: 403 no_book_access, and no session is created", async () => {
      const h = withProviders({ access: {} });
      await expect(open(h)).rejects.toMatchObject({ status: 403, reason: "no_book_access", message: NO_BOOK_ACCESS_TEXT });
      expect(await h.store.findSession(STUDENT, SLUG, 2)).toBeNull();
    });
    it("a revoked grant, or one for another product, does not open; an expired BOOK window does not either", async () => {
      const revoked = withProviders({ access: { grants: [{ ...staffGrant(T0), revoked_at: new Date(T0 - 1000).toISOString() }] } });
      await expect(open(revoked)).rejects.toMatchObject({ status: 403 });
      const expiredBook = withProviders({ access: { grants: [{ ...staffGrant(T0), expires_at: new Date(T0 - 1000).toISOString() }] } });
      await expect(open(expiredBook)).rejects.toMatchObject({ status: 403 });
    });
    it("a school licence opens with tutoring (source school); so does an SK plan (source subscription, ends with the period)", async () => {
      const school = withProviders({ access: { schoolLicence: true } });
      expect((await sessionView(school.deps, await open(school))).access).toMatchObject({ source: "school", tutor: true, tutorExpiresAt: null });
      const end = new Date(T0 + 20 * DAY).toISOString();
      const plan = withProviders({ access: { subscriptions: [{ plan_key: "homeschool_monthly", active: true, current_period_end: end }] } });
      expect((await sessionView(plan.deps, await open(plan))).access).toMatchObject({ source: "subscription", tutor: true, tutorExpiresAt: end });
      // plain Pro is not an SK plan; an inactive or lapsed SK plan does not count
      const pro = withProviders({ access: { subscriptions: [{ plan_key: "teacher_pro_monthly", active: true, current_period_end: end }] } });
      await expect(open(pro)).rejects.toMatchObject({ status: 403 });
      const lapsed = withProviders({ access: { subscriptions: [{ plan_key: "family_monthly", active: true, current_period_end: new Date(T0 - DAY).toISOString() }] } });
      await expect(open(lapsed)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("who may ask live questions", () => {
    it("tutor window over: the session opens, play / check / answer work, a question gets SK's line and no model is called", async () => {
      const t = teacher();
      const r = silentRouter();
      const h = withProviders({ access: expiredTutor(T0) }, { teacher: t, router: r });
      const s = await open(h);
      expect((await sessionView(h.deps, s)).access).toMatchObject({ source: "grant", grantSource: "code", book: true, tutor: false, liveExhausted: false });
      // prepared teaching is untouched
      const play = await runCommand(h.deps, s, { name: "continue", args: {} }, { unitKey: "s1", assetId: "s1-explain-main", t: 1000 });
      expect(play.view.state).toBe("PRESENTING");
      const q = await ask(h, s, "why does the image look bigger?");
      expect(text(q)).toBe(LIVE_ENDED_TEXT);
      expect(q.some((e) => e.event === "tal")).toBe(false);
      expect(done(q).view.state).toBe("PRESENTING"); // answered → play, as after a real answer
      expect(done(q).metered).toBeUndefined();
      expect(t.calls).toHaveLength(0);
      expect(r.calls).toHaveLength(0);
      expect((await h.store.getSession(s.id))!.history).toEqual([]);
      expect(await usage(h)).toBeNull();
      // a rule-matched route still runs; the check's questions are graded as ever
      const c = await ask(h, s, "check me");
      expect(done(c).view.openCheck).toMatchObject({ purpose: "unit", total: 2 });
      const g = await submitAnswer(h.deps, s, { eventId: uuidv7(), itemId: ITEM.s1_tf, attemptNo: 1, response: "true", modality: "typed" });
      expect(g).toMatchObject({ kind: "graded", outcome: "correct" });
      expect(g.view.access.tutor).toBe(false);
      expect(await usage(h)).toBeNull();
    });

    it("allowance enforced: each answered question counts, the last one exhausts it, the next gets SK's line and no model call", async () => {
      const t = teacher();
      const h = withProviders({ access: metered(T0, 2), allowanceEnforced: true }, { teacher: t });
      const s = await open(h);
      await runCommand(h.deps, s, { name: "continue", args: {} }, { unitKey: "s1", assetId: "s1-explain-main", t: 1000 });
      expect((await sessionView(h.deps, s)).access).toMatchObject({ grantSource: "edition_code", tutor: true, allowance: { liveTurns: 2, generatedSegments: null }, liveExhausted: false, warning: "none", enforced: true });

      const q1 = await ask(h, s, "which lens is the eyepiece?");
      expect(text(q1)).toBe("The eyepiece is the top lens.");
      expect(q1.filter((e) => e.event === "tal")).toHaveLength(1);
      expect(done(q1).metered).toEqual({ live_turns: 1, generated_segments: 1 });
      expect(done(q1).view.access).toMatchObject({ allowance: { liveTurns: 1, generatedSegments: null }, liveExhausted: false, warning: "none" });
      expect(await usage(h)).toEqual({ live_turns: 1, generated_segments: 1, interactive_ms: 0 });

      const q2 = await ask(h, s, "and the objective lens?");
      expect(done(q2).view.access).toMatchObject({ allowance: { liveTurns: 0, generatedSegments: null }, liveExhausted: true, warning: "exhausted" });
      expect(await usage(h)).toMatchObject({ live_turns: 2, generated_segments: 2 });
      expect(t.calls).toHaveLength(2);

      const q3 = await ask(h, s, "what about the stage?");
      expect(text(q3)).toBe(LIVE_EXHAUSTED_TEXT);
      expect(done(q3).metered).toBeUndefined();
      expect(t.calls).toHaveLength(2); // no third call
      expect(await usage(h)).toMatchObject({ live_turns: 2 });
      // prepared teaching carries on past the allowance
      expect((await runCommand(h.deps, s, { name: "repeat", args: {} })).speech).toBe("Let me say that part again.");
    });

    it("allowance NOT enforced (the default): the same grant refuses nothing, and usage is still written", async () => {
      const t = teacher();
      const h = withProviders({ access: metered(T0, 2) }, { teacher: t });
      const s = await open(h);
      await runCommand(h.deps, s, { name: "continue", args: {} }, { unitKey: "s1", assetId: "s1-explain-main", t: 1000 });
      for (const q of ["one?", "two?", "three?"]) expect(text(await ask(h, s, q))).toBe("The eyepiece is the top lens.");
      expect(t.calls).toHaveLength(3);
      expect(await usage(h)).toEqual({ live_turns: 3, generated_segments: 3, interactive_ms: 0 });
      expect((await sessionView(h.deps, s)).access).toMatchObject({ allowance: null, liveExhausted: false, warning: "none", enforced: false });
    });

    it("warnings: 75 % and 90 % of the live-turn allowance, in the view", async () => {
      const h = withProviders({ access: metered(T0, 20), allowanceEnforced: true });
      const s = await open(h);
      await h.store.bumpUsage(STUDENT, usageKey(h), "2026-10", { live_turns: 15 });
      expect((await sessionView(h.deps, s)).access).toMatchObject({ warning: "75", allowance: { liveTurns: 5, generatedSegments: null } });
      await h.store.bumpUsage(STUDENT, usageKey(h), "2026-10", { live_turns: 3 });
      expect((await sessionView(h.deps, s)).access).toMatchObject({ warning: "90", liveExhausted: false });
      // last month's usage does not count against this month
      await h.store.bumpUsage(STUDENT, usageKey(h), "2026-09", { live_turns: 100 });
      expect((await sessionView(h.deps, s)).access).toMatchObject({ warning: "90", liveExhausted: false });
    });
  });

  describe("what is counted", () => {
    it("a rule-matched command is not a live turn; a turn the ROUTER model saw is, even when the teacher never ran", async () => {
      const r = silentRouter();
      const h = withProviders({}, { router: r });
      const s = await open(h);
      const cmd = await ask(h, s, "slower");
      expect(done(cmd).metered).toBeUndefined();
      expect(r.calls).toHaveLength(0);
      expect(await usage(h)).toBeNull();
      const q = await ask(h, s, "hmm what do you reckon about all this");
      expect(r.calls).toHaveLength(1);
      expect(text(q)).toMatch(/can't answer questions right now/); // no teacher provider wired
      expect(done(q).metered).toEqual({ live_turns: 1, generated_segments: 0 });
      expect(await usage(h)).toEqual({ live_turns: 1, generated_segments: 0, interactive_ms: 0 });
    });
    it("a school-licensed student's questions are counted too (never refused: no allowance on a licence)", async () => {
      const t = teacher();
      const h = withProviders({ access: { schoolLicence: true }, allowanceEnforced: true }, { teacher: t });
      const s = await open(h);
      await runCommand(h.deps, s, { name: "continue", args: {} }, { unitKey: "s1", assetId: "s1-explain-main", t: 1000 });
      await ask(h, s, "which lens is the eyepiece?");
      expect(await usage(h)).toMatchObject({ live_turns: 1, generated_segments: 1 });
      expect((await sessionView(h.deps, s)).access).toMatchObject({ source: "school", allowance: null, liveExhausted: false });
    });
    it("a metering failure never breaks the turn: the answer still goes out, the decision stands", async () => {
      const t = teacher();
      const h = withProviders({}, { teacher: t });
      const s = await open(h);
      await runCommand(h.deps, s, { name: "continue", args: {} }, { unitKey: "s1", assetId: "s1-explain-main", t: 1000 });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      h.store.bumpUsage = async () => {
        throw new Error("sk_usage is down");
      };
      const q = await ask(h, s, "which lens is the eyepiece?");
      expect(text(q)).toBe("The eyepiece is the top lens.");
      expect(done(q).view.access).toMatchObject({ source: "grant", tutor: true });
      expect(err).toHaveBeenCalledWith("[sk] usage not recorded:", "sk_usage is down");
      err.mockRestore();
    });
  });
});

describe("what only the Supabase wiring can tell us (B8)", () => {
  it("the sk_usage row: keyed on the product's uuid and the UTC month, one row per period, upserted on the primary key", async () => {
    const h = supabaseLoopDeps({ now: clock(Date.UTC(2026, 9, 31, 23, 30)) }); // 2026-10-31T23:30Z
    h.deps.teacherProvider = teacher();
    const s = await open(h);
    await runCommand(h.deps, s, { name: "continue", args: {} }, { unitKey: "s1", assetId: "s1-explain-main", t: 1000 });
    await ask(h, s, "which lens is the eyepiece?");
    await ask(h, s, "and the objective?");
    expect(h.db.rows("sk_usage")).toEqual([{ user_id: STUDENT, product_id: PRODUCT, period: "2026-10", live_turns: 2, generated_segments: 2, interactive_ms: 0, updated_at: expect.any(String) }]);
    // an hour later it is November: a new row, the old one untouched
    const later = supabaseLoopDeps({ now: clock(Date.UTC(2026, 10, 1, 0, 30)) });
    later.db.seed("sk_usage", h.db.rows("sk_usage"));
    later.deps.teacherProvider = teacher();
    const s2 = await open(later);
    await runCommand(later.deps, s2, { name: "continue", args: {} }, { unitKey: "s1", assetId: "s1-explain-main", t: 1000 });
    await ask(later, s2, "which lens is the eyepiece?");
    expect(later.db.rows("sk_usage").map((r) => [r.period, r.live_turns])).toEqual([
      ["2026-10", 2],
      ["2026-11", 1],
    ]);
  });
  it("grants are read by the product's uuid, never its slug (a slug in that filter is a 22P02 on the real table)", async () => {
    const h = supabaseLoopDeps({ now: clock() });
    const rows = await h.entitlements.load(STUDENT, SLUG, new Date(T0));
    expect(rows.productId).toBe(PRODUCT);
    expect(rows.grants).toEqual([{ product_id: PRODUCT, source: "staff", activated_at: staffGrant(T0).activated_at, expires_at: null, tutor_expires_at: staffGrant(T0).tutor_expires_at, revoked_at: null, usage_allowance: null }]);
    await expect(h.db.from("book_access_grants").select("id").eq("product_id", SLUG)).resolves.toMatchObject({ error: { code: "22P02" } });
    // an unknown slug: no product, no grants, nothing to meter — and no access unless a licence or plan says so
    expect(await h.entitlements.load(STUDENT, "no-such-book", new Date(T0))).toEqual({ productId: null, schoolLicence: false, subscriptions: [], grants: [] });
  });
  it("the school licence is the school's school_* entitlement row through profiles.school_id, live only while its period runs", async () => {
    const h = supabaseLoopDeps({ now: clock(), access: { schoolLicence: true } });
    expect((await h.entitlements.load(STUDENT, SLUG, new Date(T0))).schoolLicence).toBe(true);
    for (const r of h.db.live("entitlements")) if (r.school_id) r.current_period_end = new Date(T0 - DAY).toISOString();
    expect((await h.entitlements.load(STUDENT, SLUG, new Date(T0))).schoolLicence).toBe(false);
    await expect(open(h)).rejects.toMatchObject({ status: 403 });
  });
});
