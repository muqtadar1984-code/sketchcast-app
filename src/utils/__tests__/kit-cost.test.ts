/**
 * Average cost per kit (console Overview). Pinned: client kits grouped by
 * (book, chapter, part, language) and summed over every builder job (retries
 * included, support diagnoses not); catalogue kits from topic_kits with the
 * translate run joined by stage.kit_id; the exclusion rules and their
 * reasons; median; per-piece averages; the provider split (by_model first,
 * then the recorded model, then routing); all-in usage when the worker
 * records images and TTS; and the window parser.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/kit-cost.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  CATALOGUE_CLAUDE_FROM,
  jobProviders,
  jobSpend,
  kitCostReport,
  median,
  parseCostWindow,
  type CostGen,
  type CostJob,
  type TopicKitRow,
} from "../kit-cost";

const START = Date.parse("2026-10-01T00:00:00Z");
const AT = "2026-10-16T00:00:00Z"; // after usage tracking began
let n = 0;
const G = (over: Partial<CostGen>): CostGen => ({
  id: `g${++n}`, owner_id: "teacher", kind: "presentation", book_id: "b1", chapter_ref: "1",
  created_at: AT, part: null, language: "en", catalogue: null, catalogue_ref: null,
  coverage_model: null, ...over,
});
const J = (gen: string | null, cost: number | null, over: Partial<CostJob> = {}): CostJob => ({
  id: `j${++n}`, generation_id: gen, type: null, status: "done",
  usage: cost === null ? null : { cost_usd: cost }, created_at: AT, ...over,
});
const K = (over: Partial<TopicKitRow>): TopicKitRow => ({
  id: `k${++n}`, topic_id: "t1", language: "en", source_kit_id: null, status: "approved",
  created_at: "2026-10-16T00:00:00Z", presentation_generation_id: null, doc_generation_ids: null, ...over,
});
const report = (gens: CostGen[], jobs: CostJob[], kits: TopicKitRow[] = [], excluded: string[] = []) =>
  kitCostReport({ gens, jobs, topicKits: kits, excludedOwners: new Set(excluded), windowStartMs: START });

describe("jobSpend", () => {
  it("is text-only on today's rows and all-in once the worker records images and TTS", () => {
    expect(jobSpend(null)).toBeNull();
    expect(jobSpend({})).toBeNull();
    expect(jobSpend({ cost_usd: 0.5 })).toEqual({ usd: 0.5, textUsd: 0.5, allIn: false });
    expect(jobSpend({ cost_usd: 0.5, images_usd: 0.3, tts_usd: 0.2 })).toEqual({ usd: 1, textUsd: 0.5, allIn: true });
    expect(jobSpend({ cost_usd: 0.5, images_usd: 0.3, tts_usd: 0.2, total_usd: 1.1 })?.usd).toBe(1.1);
    // Images but no TTS figure: added, but not all-in.
    expect(jobSpend({ cost_usd: 0.5, images_usd: 0.3 })).toEqual({ usd: 0.8, textUsd: 0.5, allIn: false });
  });
});

describe("jobProviders", () => {
  it("splits by by_model exactly when the row carries it", () => {
    const j = J("g", 1, { usage: { cost_usd: 1, by_model: {
      "bedrock:claude-sonnet-5-5": { backend: "bedrock", model: "claude-sonnet-5-5", cost_usd: 0.7 },
      "vertex:gemini-3.5-flash": { backend: "vertex", model: "gemini-3.5-flash", cost_usd: 0.3 },
    } } });
    const r = jobProviders(j, { catalogue: false, language: "en", coverageModel: null });
    expect(r.inferred).toBe(false);
    expect(r.split.get("Claude")).toBeCloseTo(0.7);
    expect(r.split.get("Gemini")).toBeCloseTo(0.3);
  });
  it("falls back to the recorded model, then the routing rules", () => {
    const j = J("g", 1);
    expect([...jobProviders(j, { catalogue: false, language: "en", coverageModel: "claude-haiku-4-5" }).split.keys()]).toEqual(["Claude"]);
    expect([...jobProviders(j, { catalogue: false, language: "ar", coverageModel: null }).split.keys()]).toEqual(["Claude"]);
    expect([...jobProviders(j, { catalogue: false, language: "fr", coverageModel: null }).split.keys()]).toEqual(["Gemini"]);
    const before = J("g", 1, { created_at: "2026-10-18T08:00:00Z" });
    const after = J("g", 1, { created_at: CATALOGUE_CLAUDE_FROM });
    expect([...jobProviders(before, { catalogue: true, language: "en", coverageModel: null }).split.keys()]).toEqual(["Gemini"]);
    expect([...jobProviders(after, { catalogue: true, language: "en", coverageModel: null }).split.keys()]).toEqual(["Claude"]);
    expect(jobProviders(after, { catalogue: true, language: "en", coverageModel: null }).inferred).toBe(true);
  });
});

describe("median", () => {
  it("handles odd, even and empty", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("kitCostReport — client kits", () => {
  it("groups by book, chapter, part and language and sums every builder job", () => {
    const p = G({ kind: "presentation" });
    const w = G({ kind: "worksheet" });
    const fr = G({ kind: "presentation", language: "fr" }); // same chapter, other language: its own kit
    const r = report([p, w, fr], [
      J(p.id, 0.4, { status: "error" }), J(p.id, 0.6), // a retry: both attempts are spend
      J(p.id, 9, { type: "support_diagnose" }),        // a diagnosis is not the lesson's cost
      J(w.id, 0.2),
      J(fr.id, 0.5),
    ]);
    expect(r.client.kits).toBe(2);
    expect(r.client.costed).toBe(2);
    expect(r.client.totalUsd).toBeCloseTo(1.7);
    expect(r.client.avgUsd).toBeCloseTo(0.85);
    expect(r.client.medianUsd).toBeCloseTo(0.85);
    expect(r.client.pieces.map((x) => [x.kind, x.n])).toEqual([["presentation", 2], ["worksheet", 1]]);
    expect(r.client.pieces[0].avgUsd).toBeCloseTo(0.75);
  });

  it("skips catalogue pieces, adopted copies, excluded owners and kits begun before the window", () => {
    const r = report([
      G({ catalogue: "true" }),
      G({ catalogue_ref: "x" }),
      G({ owner_id: "staff" }),
      G({ book_id: "old", created_at: "2026-09-20T00:00:00Z" }),
      G({ book_id: "old", kind: "deck" }), // later piece of a kit that began before the window
    ], [], [], ["staff"]);
    expect(r.client.kits).toBe(0);
  });

  it("excludes kits begun before usage tracking, running kits, and kits with a finished piece that recorded nothing", () => {
    const early = G({ book_id: "early", created_at: "2026-10-14T20:00:00Z" });
    const a = G({ book_id: "a" });
    const b = G({ book_id: "b" });
    const b2 = G({ book_id: "b", kind: "deck" });
    const c = G({ book_id: "c" });
    const r = report([early, a, b, b2, c], [
      J(early.id, 0.01),
      J(a.id, 0.5, { status: "processing" }),
      J(b.id, 0.5), J(b2.id, null),
      J(c.id, null, { status: "error" }),
    ]);
    expect(r.client.kits).toBe(4);
    expect(r.client.costed).toBe(0);
    expect(r.client.avgUsd).toBeNull();
    expect(Object.fromEntries(r.client.excluded.map((e) => [e.reason, e.n]))).toEqual({
      "before usage tracking (15 Oct)": 1, "still generating": 1, "a finished piece recorded no usage": 1, "nothing finished": 1,
    });
  });

  it("counts full kits and estimates a full kit from the per-piece averages", () => {
    const kinds = ["presentation", "deck", "worksheet", "activity", "case_study", "lesson_plan"];
    const full = kinds.map((kind) => G({ book_id: "full", kind }));
    const part = G({ book_id: "part", kind: "presentation" });
    const r = report([...full, part], [...full.map((g) => J(g.id, 0.1)), J(part.id, 0.3)]);
    expect(r.client.fullKits).toBe(1);
    expect(r.client.fullKitEstimateUsd).toBeCloseTo(0.2 + 0.5); // presentation avg 0.2 + five pieces at 0.1
  });

  it("classifies each kit by provider; a kit on both is Mixed", () => {
    const en = G({ book_id: "en", coverage_model: "gemini-3.5-flash" });
    const ar = G({ book_id: "ar", language: "ar" });
    const mix = G({ book_id: "mix", coverage_model: "gemini-3.5-flash" });
    const mix2 = G({ book_id: "mix", kind: "deck", coverage_model: "claude-sonnet-4-6" });
    const r = report([en, ar, mix, mix2], [J(en.id, 0.5), J(ar.id, 1), J(mix.id, 0.2), J(mix2.id, 0.2)]);
    expect(Object.fromEntries(r.client.providers.map((p) => [p.provider, p.kits]))).toEqual({ Gemini: 1, Claude: 1, Mixed: 1 });
    expect(r.client.providersInferred).toBe(true);
    expect(r.client.allIn).toBe(0);
  });
});

describe("kitCostReport — catalogue kits", () => {
  it("costs an English kit from its presentation and documents; question bank and quiz add nothing", () => {
    const p = G({ catalogue: "true" });
    const d = G({ catalogue: "true", kind: "deck" });
    const w = G({ catalogue: "true", kind: "worksheet" });
    const qb = G({ catalogue: "true", kind: "question_bank" });
    const kit = K({ presentation_generation_id: p.id, doc_generation_ids: { deck: d.id, worksheet: w.id, question_bank: qb.id } });
    const r = report([p, d, w, qb], [J(p.id, 0.6), J(d.id, 0.05), J(w.id, null), J(qb.id, null)], [kit]);
    expect(r.english.costed).toBe(1);
    expect(r.english.avgUsd).toBeCloseTo(0.65);
    expect(r.english.pieces.map((x) => x.kind)).toEqual(["presentation", "deck"]);
    expect(r.translated.kits).toBe(0);
  });

  it("excludes kits before usage tracking and English kits whose video recorded nothing", () => {
    const p1 = G({ catalogue: "true" });
    const p2 = G({ catalogue: "true" });
    const early = K({ created_at: "2026-10-14T00:00:00Z", presentation_generation_id: p1.id });
    const blind = K({ presentation_generation_id: p2.id });
    const r = report([p1, p2], [J(p1.id, 0.6), J(p2.id, null)], [early, blind]);
    expect(r.english.kits).toBe(2);
    expect(r.english.costed).toBe(0);
    expect(Object.fromEntries(r.english.excluded.map((e) => [e.reason, e.n]))).toEqual({
      "before usage tracking (15 Oct)": 1, "video recorded no usage": 1,
    });
  });

  it("adds the translate run joined by stage.kit_id; a replaced run is its own line", () => {
    const p = G({ catalogue: "true", language: "ar" });
    const a = G({ catalogue: "true", kind: "activity", language: "ar" });
    const kit = K({ language: "ar", source_kit_id: "src", presentation_generation_id: p.id, doc_generation_ids: { activity: a.id } });
    const lost = K({ language: "ms", source_kit_id: "src" }); // no translate run, no video usage
    const r = report([p, a], [
      J(p.id, null), J(a.id, 0.3),
      J(null, 0.4, { type: "kit_translate", stage_kit_id: kit.id }),
      J(null, 0.35, { type: "kit_translate", stage_kit_id: "gone" }),
      J(null, null, { type: "kit_translate", stage_kit_id: "gone2", status: "error" }),
    ], [kit, lost]);
    expect(r.translated.kits).toBe(2);
    expect(r.translated.costed).toBe(1);
    expect(r.translated.avgUsd).toBeCloseTo(0.7);
    expect(r.translated.pieces.map((x) => x.kind)).toEqual(["activity", "translation"]);
    expect(r.translated.excluded).toEqual([{ reason: "no translation spend recorded", n: 1 }]);
    expect(r.extras.orphanTranslate).toEqual({ jobs: 2, costed: 1, totalUsd: 0.35, avgUsd: 0.35 });
  });

  it("flags translated kits over $2 — measured plus a labelled TTS estimate while usage is text-only", () => {
    const p1 = G({ catalogue: "true", language: "hi" });
    const p2 = G({ catalogue: "true", language: "fr" });
    const p3 = G({ catalogue: "true", language: "es" });
    const dear = K({ language: "hi", topic_id: "tA", source_kit_id: "src", presentation_generation_id: p1.id });
    const near = K({ language: "fr", topic_id: "tB", source_kit_id: "src", presentation_generation_id: p2.id });
    const allIn = K({ language: "es", topic_id: "tC", source_kit_id: "src", presentation_generation_id: p3.id });
    const r = report([p1, p2, p3], [
      J(p1.id, 0.6), J(null, 1.3, { type: "kit_translate", stage_kit_id: dear.id }),        // 1.9 + 0.21 est.
      J(p2.id, 0.5), J(null, 1.25, { type: "kit_translate", stage_kit_id: near.id }),       // 1.75 + 0.21 est. = 1.96
      J(p3.id, null, { usage: { cost_usd: 1, tts_usd: 0.6, images_usd: 0.5, total_usd: 2.1 } }),
      J(null, 0, { type: "kit_translate", stage_kit_id: allIn.id, usage: { cost_usd: 0, tts_usd: 0, images_usd: 0 } }),
    ], [dear, near, allIn]);
    expect(r.translatedOverWarn.map((k) => [k.language, Number(k.totalUsd.toFixed(2)), k.ttsEstimateUsd])).toEqual([
      ["hi", 2.11, 0.21],
      ["es", 2.1, 0],
    ]);
    expect(r.translatedOverWarn[0].pieces).toEqual([{ kind: "presentation", usd: 0.6 }, { kind: "translation", usd: 1.3 }]);
  });

  it("reports topic articles and question sets per job and per topic", () => {
    const r = report([], [
      J(null, 0.02, { type: "topic_article", topic_id: "t1" }),
      J(null, 0.2, { type: "topic_questions", topic_id: "t1" }),
      J(null, 0.18, { type: "topic_questions", topic_id: "t2" }),
      J(null, null, { type: "topic_article", topic_id: "t3" }),
      J(null, 5, { type: "topic_article", topic_id: "t9", created_at: "2026-09-01T00:00:00Z" }), // before the window
    ]);
    expect(r.extras.articles).toEqual({ jobs: 2, costed: 1, totalUsd: 0.02, avgUsd: 0.02 });
    expect(r.extras.questions.costed).toBe(2);
    expect(r.extras.questions.avgUsd).toBeCloseTo(0.19);
    expect(r.extras.topics).toBe(2);
    expect(r.extras.perTopicUsd).toBeCloseTo(0.2);
  });
});

describe("parseCostWindow", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  it("defaults to 30 days and accepts 90", () => {
    expect(parseCostWindow({}, now)).toMatchObject({ days: 30, since: null, label: "last 30 days" });
    expect(parseCostWindow({ costdays: "90" }, now).days).toBe(90);
    expect(parseCostWindow({ costdays: "7" }, now).days).toBe(30);
  });
  it("takes a since-date over the days, and ignores junk or the future", () => {
    expect(parseCostWindow({ costdays: "90", costsince: "2026-10-15" }, now)).toMatchObject({
      days: null, since: "2026-10-15", startMs: Date.parse("2026-10-15T00:00:00Z"),
    });
    expect(parseCostWindow({ costsince: "15/10/2026" }, now).days).toBe(30);
    expect(parseCostWindow({ costsince: "2026-11-01" }, now).days).toBe(30);
  });
});
