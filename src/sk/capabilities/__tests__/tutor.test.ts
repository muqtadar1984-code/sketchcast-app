/**
 * SK S3 slice D — the student capabilities (tutor.*), over the kit routes'
 * own world (the REAL ProductKits + SupabaseEntitlements + SupabaseSessionStore
 * on the schema-checking fake, kit-fixtures / remediation-fixtures):
 *   - registry scopes: a student sees navigate + tutor.* and nothing else;
 *     no adult role or hat ever sees a tutor.* entry;
 *   - tutor.explain is the kit turn: ONE model call, ONE sk_usage live_turns,
 *     and a resent Shell turn (same turn id) replays without a second call or meter;
 *   - tutor.progress reads only the student's own sk_objective_mastery rows,
 *     even through a session that ignores every filter;
 *   - tutor.where is deterministic (pure whereNext + the capability);
 *   - the moves resolve sections by number, step and the student's words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { SupabaseEntitlements } from "@/sk/entitlement";
import { SupabaseItemBank } from "@/sk/items-supabase";
import { __setKitDepsForTests, type KitAdmin, type KitDeps } from "@/sk/kit-server";
import { kitSegments } from "@/sk/kit-view";
import { ProductKits } from "@/sk/product-kits";
import { SupabaseSessionStore } from "@/sk/store-supabase";
import { MASTERY_RULE_VERSION } from "@/sk/mastery";
import { whereNext, type KitObjective } from "@/sk/tutor";
import type { FakeDb } from "@/sk/__tests__/fake-supabase";
import { CELLS, kitManifest, kitWorld, PRODUCT, SLUG, STRANGER, STUDENT, T0 } from "@/sk/__tests__/kit-fixtures";
import { CH5_KIT, ch5Manifest, O1_KEY, O2_KEY, seedCh5 } from "@/sk/__tests__/remediation-fixtures";
import { allowedFor } from "@/sk/shell/registry";
import { runCapability, type RunnerDeps } from "@/sk/shell/runner";
import { MemoryAuditSink } from "@/sk/shell/audit";
import { SK_STUDENT_RULES } from "@/sk/shell/prompt";
import type { SkContext, SkHat, SkRole, SkTutorState } from "@/sk/shell/types";
import { fakeSession, makeCtx } from "@/sk/shell/__tests__/fixtures";
import { REGISTRY } from "@/sk/capabilities";
import { TUTOR_CAPABILITIES } from "../tutor";

const TUTOR = new Set(TUTOR_CAPABILITIES.map((c) => c.meta.name));

function install(teacher?: StubProvider): FakeDb {
  const db = seedCh5(kitWorld());
  const admin: KitAdmin = { from: (t: string) => db.from(t), storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x" }, error: null }) }) } };
  const read = vi.fn(async (_a: KitAdmin, g: string) => ({ status: "ready" as const, manifest: g === CH5_KIT ? ch5Manifest() : kitManifest(), builtAt: new Date(T0).toISOString() }));
  const entitlements = new SupabaseEntitlements(db);
  const deps: Partial<KitDeps> = {
    kits: new ProductKits(db, entitlements, () => new Date(T0)),
    admin: () => admin,
    read,
    derive: read,
    items: () => new SupabaseItemBank(db),
    store: new SupabaseSessionStore(db, { now: () => T0, pollMs: 1, inflightTimeoutMs: 500 }),
    entitlements,
    teacherProvider: teacher,
    now: () => T0,
  };
  __setKitDepsForTests(deps);
  return db;
}

const segs = (m: ReturnType<typeof ch5Manifest>) => kitSegments(m).map((s, i) => ({ k: i, key: s.key, heading: s.heading }));

function studentCtx(tutor?: Partial<SkTutorState> | null, locale = "en"): SkContext {
  const ctx = makeCtx({ role: "student", hat: null, userId: STUDENT, schoolId: null, locale });
  if (tutor !== null) ctx.tutor = { product: SLUG, chapter: "5", kit: CH5_KIT, k: 0, key: "p1:s001", segments: segs(ch5Manifest()), ...(tutor ?? {}) };
  return ctx;
}

function runner(session: unknown, turnId: string | null = null): RunnerDeps {
  return { session: session as RunnerDeps["session"], now: new Date(T0), sink: new MemoryAuditSink(), sessionId: null, turnId };
}

beforeEach(() => {
  process.env.FEATURE_SK = "true";
});
afterEach(() => {
  __setKitDepsForTests(null);
  delete process.env.FEATURE_SK;
  vi.clearAllMocks();
});

describe("registry scopes", () => {
  it("a student sees navigate and the tutor.* entries — nothing else", () => {
    const names = allowedFor(studentCtx()).map((c) => c.meta.name).sort();
    // + S4 slice D's book.activate (student and parent: her own book code),
    // + S7 K2's knowledge.search (every role: her own sources only),
    // + 2026-10-30's tour / language controls (every role, no flag).
    expect(names).toEqual(["book.activate", "knowledge.search", "navigate", "start_tour", "tour_control", "set_answer_language", "repeat_in_language", ...[...TUTOR].sort()].sort());
    expect(TUTOR).toEqual(new Set(["tutor.where", "tutor.progress", "tutor.play", "tutor.section", "tutor.slide", "tutor.practise", "tutor.explain"]));
  });
  it("every tutor.* entry is student-only, hat-less, immediate, behind the sk flag", () => {
    for (const c of TUTOR_CAPABILITIES) {
      expect(c.meta).toMatchObject({ roles: ["student"], tier: "immediate", flags: ["sk"] });
      expect(c.meta.hats).toBeUndefined();
      expect(REGISTRY).toContain(c);
    }
  });
  it("no adult role, wearing any hat, ever sees a tutor.* entry", () => {
    const roles: SkRole[] = ["teacher", "parent", "school_admin"];
    const hats: SkHat[] = ["teacher", "parent", "principal", "coordinator", null];
    for (const role of roles)
      for (const hat of hats) {
        const names = allowedFor(makeCtx({ role, hat })).map((c) => c.meta.name);
        expect(names.filter((n) => TUTOR.has(n)), `${role}/${hat}`).toEqual([]);
      }
    const coordinator = allowedFor(makeCtx({ role: "teacher", hat: "coordinator", scope: [{ grade: "7", subject: null }] })).map((c) => c.meta.name);
    expect(coordinator.filter((n) => TUTOR.has(n))).toEqual([]);
  });
  it("with FEATURE_SK's context flag off a student has no tutor entry", () => {
    const ctx = studentCtx();
    ctx.flags = { ...ctx.flags, sk: false };
    expect(allowedFor(ctx).map((c) => c.meta.name)).toEqual(["navigate", "start_tour", "tour_control", "set_answer_language", "repeat_in_language"]);
  });
  it("the runner refuses a tutor.* call from a teacher at execution time", async () => {
    install();
    const r = await runCapability(makeCtx({ role: "teacher", hat: "teacher" }), "tutor.progress", {}, runner(fakeSession({})));
    expect(r).toMatchObject({ ok: false, error: "not_allowed" });
  });
});

describe("tutor.explain — the kit turn, metered once", () => {
  const turnId = "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f";
  const cellsCtx = () => studentCtx({ chapter: "1", kit: CELLS, k: 0, key: "p1:s001", segments: segs(kitManifest()) });

  it("one student turn → one model call, one sk_usage live_turns, grounded on the section", async () => {
    const teacher = new StubProvider([{ text: ["A cell is the smallest unit of life."] }, { text: ["Every living thing is made of cells."] }]);
    const db = install(teacher);
    const r = await runCapability(cellsCtx(), "tutor.explain", {}, runner(fakeSession({}), turnId));
    expect(r.ok).toBe(true);
    expect(r.reply).toMatchObject({ text: "A cell is the smallest unit of life.", label: "grounded", sources: ["tutor.explain", "kit"] });
    expect(teacher.calls).toHaveLength(1);
    expect(teacher.calls[0]!.system).toContain(SK_STUDENT_RULES);
    expect(db.rows("sk_usage")).toEqual([expect.objectContaining({ user_id: STUDENT, product_id: PRODUCT, live_turns: 1, generated_segments: 0 })]);

    // The SAME Shell turn resent (a retry): replayed, no second call, no second meter.
    const again = await runCapability(cellsCtx(), "tutor.explain", {}, runner(fakeSession({}), turnId));
    expect(again.reply?.text).toBe("A cell is the smallest unit of life.");
    expect(again.facts?.[0]).toMatchObject({ replayed: true, metered: false });
    expect(teacher.calls).toHaveLength(1);
    expect(db.rows("sk_usage")[0]).toMatchObject({ live_turns: 1 });

    // A NEW turn is a new live turn: exactly one more.
    await runCapability(cellsCtx(), "tutor.explain", { question: "why are cells small?" }, runner(fakeSession({}), "7a1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f"));
    expect(teacher.calls).toHaveLength(2);
    expect(db.rows("sk_usage")[0]).toMatchObject({ live_turns: 2 });
  });

  it("a kit the student may not open: SK's line, no model call, nothing metered", async () => {
    const teacher = new StubProvider([{ text: ["never"] }]);
    const db = install(teacher);
    const ctx = makeCtx({ role: "student", hat: null, userId: STRANGER, schoolId: null });
    ctx.tutor = { product: SLUG, chapter: "1", kit: CELLS, k: 0, key: "p1:s001", segments: segs(kitManifest()) };
    const r = await runCapability(ctx, "tutor.explain", {}, runner(fakeSession({}), turnId));
    expect(r).toMatchObject({ ok: false, error: "not_entitled" });
    expect(teacher.calls).toHaveLength(0);
    expect(db.rows("sk_usage")).toEqual([]);
  });

  it("no lesson open: asks her to open one, no model call", async () => {
    const teacher = new StubProvider([{ text: ["never"] }]);
    install(teacher);
    const r = await runCapability(studentCtx(null), "tutor.explain", { question: "what is a cell?" }, runner(fakeSession({}), turnId));
    expect(r.ok).toBe(false);
    expect(r.reply?.text).toMatch(/^Open a chapter and pick a section/);
    expect(teacher.calls).toHaveLength(0);
  });
});

const masteryRow = (student: string, key: string, status: string) => ({
  student_id: student,
  objective_key: key,
  status,
  independent: status === "mastered",
  evidence: {},
  rule_version: MASTERY_RULE_VERSION,
  updated_at: new Date(T0).toISOString(),
});

describe("tutor.progress — her own rows only", () => {
  it("lists her mastered / needs-work ideas by section heading; another learner's rows never appear", async () => {
    const db = install();
    db.seed("sk_objective_mastery", [masteryRow(STUDENT, O1_KEY, "mastered"), masteryRow(STRANGER, O2_KEY, "needs_work")]);
    const r = await runCapability(studentCtx(), "tutor.progress", {}, runner(db));
    expect(r.ok).toBe(true);
    expect(r.reply?.text).toBe("Your progress on Specialised Cells and Tissues: Mastered: Why cells specialise.");
    expect(r.facts).toEqual([{ idea: "Why cells specialise", status: "mastered" }]);
  });

  it("even a session that ignores every filter (no RLS, no eq) cannot surface another learner's row", async () => {
    install();
    const leaky = fakeSession({ sk_objective_mastery: [masteryRow(STRANGER, O1_KEY, "mastered"), masteryRow(STRANGER, O2_KEY, "needs_work")] });
    const r = await runCapability(studentCtx(), "tutor.progress", {}, runner(leaky));
    expect(r.reply?.text).toBe("You haven't answered any questions in this lesson yet. Say \"quiz me\" to start.");
    expect(r.facts).toEqual([]);
  });

  it("speaks her language", async () => {
    const db = install();
    db.seed("sk_objective_mastery", [masteryRow(STUDENT, O2_KEY, "needs_work")]);
    const r = await runCapability(studentCtx({}, "ms"), "tutor.progress", {}, runner(db));
    expect(r.reply?.text).toBe("Kemajuan anda dalam Specialised Cells and Tissues: Perlu diperbaiki: Red blood cells.");
  });
});

describe("tutor.where — deterministic", () => {
  const m = ch5Manifest();
  const sections = kitSegments(m);
  const objectives: KitObjective[] = [
    { key: O1_KEY, heading: "Why cells specialise", index: 0 },
    { key: O2_KEY, heading: "Red blood cells", index: 1 },
  ];
  it("whereNext: watch → practise → onwards; a needs_work objective comes first; same input, same answer", () => {
    const base = { sections, objectives, mastery: {}, current: 0, watched: [] as number[], practised: [] as number[] };
    expect(whereNext(base)).toEqual({ kind: "watch", index: 0, heading: "Why cells specialise" });
    expect(whereNext({ ...base, watched: [0] })).toEqual({ kind: "practise", index: 0, heading: "Why cells specialise" });
    expect(whereNext({ ...base, watched: [0], practised: [0] })).toEqual({ kind: "watch", index: 1, heading: "Red blood cells" });
    expect(whereNext({ ...base, watched: [0, 1, 2], practised: [0, 1, 2] })).toEqual({ kind: "done" });
    const weak = { ...base, current: 2, watched: [0, 1, 2], mastery: { [O1_KEY]: "mastered" as const, [O2_KEY]: "needs_work" as const } };
    expect(whereNext(weak)).toEqual({ kind: "weak", index: 1, heading: "Red blood cells", key: O2_KEY });
    for (let i = 0; i < 5; i++) expect(whereNext(weak)).toEqual(whereNext(weak));
  });

  it("the capability: her kit session's answers count as practised; the answer is the same every time", async () => {
    const db = install();
    const first = await runCapability(studentCtx({ watched: [0] }), "tutor.where", {}, runner(db));
    expect(first.reply?.text).toBe("Next: practise section 1, Why cells specialise.");
    db.seed("sk_objective_mastery", [masteryRow(STUDENT, O2_KEY, "needs_work"), masteryRow(STRANGER, O1_KEY, "needs_work")]);
    const a = await runCapability(studentCtx({ watched: [0] }), "tutor.where", {}, runner(db));
    const b = await runCapability(studentCtx({ watched: [0] }), "tutor.where", {}, runner(db));
    expect(a.reply?.text).toBe("Next: go over Red blood cells again — that idea still needs work.");
    expect(b.reply?.text).toBe(a.reply?.text);
    expect(a.facts).toEqual(b.facts);
  });

  it("no lesson open: her chapters, from the kit map she is entitled to", async () => {
    const db = install();
    const r = await runCapability(studentCtx(null), "tutor.where", {}, runner(db));
    expect(r.ok).toBe(true);
    expect(r.reply?.text).toContain("Chapter 1: Cells");
    expect(r.reply?.text).toContain("Chapter 5: Specialised Cells and Tissues");
    expect(r.reply?.text).not.toContain("Another book");
  });
});

describe("the moves", () => {
  it("section by number, by step and by her words; the slide and practice of the current section", async () => {
    install();
    const s = fakeSession({});
    expect((await runCapability(studentCtx(), "tutor.section", { k: 2 }, runner(s))).tutor).toEqual({ move: "section", args: { k: 2, key: "p1:s003" }, say: "Section 3: Tissues and organs." });
    expect((await runCapability(studentCtx({ k: 1 }), "tutor.section", { step: "next" }, runner(s))).tutor?.args).toEqual({ k: 2, key: "p1:s003" });
    expect((await runCapability(studentCtx(), "tutor.section", { query: "the red blood cells part" }, runner(s))).tutor?.args).toEqual({ k: 1, key: "p1:s002" });
    expect((await runCapability(studentCtx({ k: 1 }), "tutor.slide", {}, runner(s))).tutor).toEqual({ move: "slide", args: { k: 1, key: "p1:s002" }, say: "Here is the slide for Red blood cells." });
    expect((await runCapability(studentCtx({ k: 1 }), "tutor.practise", {}, runner(s))).tutor?.move).toBe("practise");
    expect((await runCapability(studentCtx(), "tutor.play", { action: "pause" }, runner(s))).tutor).toEqual({ move: "pause", args: {}, say: "Paused." });
    expect((await runCapability(studentCtx({}, "ar"), "tutor.play", {}, runner(s))).tutor?.say).toBe("تشغيل Why cells specialise.");
  });
  it("a part that is not in the lesson, or no lesson at all: SK's line, no move", async () => {
    install();
    const s = fakeSession({});
    const miss = await runCapability(studentCtx(), "tutor.section", { query: "photosynthesis in leaves" }, runner(s));
    expect(miss).toMatchObject({ ok: false, error: "no_such_section" });
    expect(miss.tutor).toBeUndefined();
    const none = await runCapability(studentCtx(null), "tutor.play", {}, runner(s));
    expect(none).toMatchObject({ ok: false, error: "no tutor" });
    expect(none.reply?.text).toMatch(/^Open a chapter first/);
  });
});
