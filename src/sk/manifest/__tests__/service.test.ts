import { describe, expect, it, vi } from "vitest";
import { FakeAdmin, type Row } from "./fake-admin";
import { BUILDING_TTL_MS, MAX_ITEMS, MAX_SEGMENTS, S1_VISUAL_REASON, deriveAndStore, visualForApp, type ModelCall } from "../service";
import { artifactsHash, assemble, buildSegments, type ArtifactRow, type KitInput, type KitManifest } from "../derive";
import type { LoadedKit } from "../load";
import { CONCEPT_PROMPT_VERSION, ITEM_PROMPT_VERSION } from "../prompts";

const OWNER = "9d41e12e-e9c9-4b82-b3a9-3421c2c57726";
const GEN = "eef426bd-523b-4fed-827c-95421263d89a";
const WS = "a416ce84-5c87-46fa-8874-22a8cbfdd1d2";
const NOW = new Date("2026-10-28T10:00:00.000Z");

const rows: ArtifactRow[] = [
  { id: "a1", generation_id: GEN, kind: "video_mp4", storage_path: `${OWNER}/${GEN}/lesson.mp4`, created_at: "2026-10-25T09:40:29+00:00" },
  { id: "a2", generation_id: GEN, kind: "script_json", storage_path: `${OWNER}/${GEN}/script.json`, created_at: "2026-10-25T09:40:30+00:00" },
  { id: "a3", generation_id: WS, kind: "questions_json", storage_path: `${OWNER}/${WS}/worksheet_questions.json`, created_at: "2026-10-25T09:35:21+00:00" },
];
const seg = (id: string, heading: string, concept: string | null = null) => ({ segment_id: id, type: "explore", text: `About ${heading}`, slide_heading: heading, slide_points: ["p"], scene: { concept, elements: [] } });
const input: KitInput = {
  generation_id: GEN,
  book_id: "book",
  chapter_ref: "4",
  article_id: null,
  format_version: 3,
  language: "en",
  scripts: [
    {
      part: 1,
      of: 1,
      script: { script_id: "S1", segments: [seg("s001", "Hook"), seg("s002", "Cell wall structure", "c001"), seg("s003", "Big vacuole")] },
      video: { manifest_id: "V1", segments: [{ segment_id: "s001", clip_duration_seconds: 10 }, { segment_id: "s002", clip_duration_seconds: 20 }, { segment_id: "s003", clip_duration_seconds: 15 }, { segment_id: "s990", clip_duration_seconds: 2 }] },
    },
  ],
  artifacts: rows,
  concepts: [
    { concept_id: "c001", name: "Cell wall", definition: "rigid layer" },
    { concept_id: "c002", name: "Vacuole", definition: "sap store" },
  ],
  concept_source: "chapter_grounding",
  items: [
    { q_id: "ws:a416ce84:q1", source: "worksheet", generation_id: WS, type: "fill_blank", prompt: "The wall is ____", answer: "rigid" },
    { q_id: "ws:a416ce84:q2", source: "worksheet", generation_id: WS, type: "short", prompt: "What stores sap?", answer: "vacuole" },
  ],
  has_video: { 1: true },
};
const loaded = (over: Partial<KitInput> = {}): LoadedKit => {
  const i = { ...input, ...over };
  return {
    input: i,
    artifactRows: i.artifacts,
    generation: { id: GEN, owner_id: OWNER, book_id: "book", chapter_ref: "4", kind: "presentation", status: "done", withdrawn_at: null, params: { format_version: 3 } },
    worksheetGenerationId: WS,
  };
};

/** A model that answers both passes with valid JSON (s001 hook → null, s003 → c002; both items mapped). */
const goodModel: ModelCall = async (req) => {
  const text = req.user.includes("QUESTIONS:")
    ? JSON.stringify({ items: [{ q: "ws:a416ce84:q1", concepts: ["c001"], segments: ["p1:s002"], confidence: 0.95, reason: "wall" }, { q: "ws:a416ce84:q2", concepts: ["c002"], segments: ["p1:s003"], confidence: 0.9, reason: "vacuole" }] })
    : JSON.stringify({ assignments: [{ segment: "p1:s001", primary: null, secondary: [], confidence: 0.9, reason: "hook" }, { segment: "p1:s003", primary: "c002", secondary: [], confidence: 0.92, reason: "vacuole" }] });
  return { text, usage: { input_tokens: 1000, output_tokens: 200 } };
};

function admin(manifestRows: Row[] = [], liveRows: ArtifactRow[] = rows) {
  return new FakeAdmin({ sk_manifests: manifestRows, artifacts: liveRows.map((r) => ({ ...r })), generations: [{ id: GEN, params: { format_version: 3 } }] });
}
const row = (status: string, over: Partial<Row> = {}): Row => ({ generation_id: GEN, status, manifest: {}, stale_reason: null, built_at: "2026-10-28T09:00:00.000Z", updated_at: "2026-10-28T09:00:00.000Z", ...over });

describe("deriveAndStore — happy path", () => {
  it("no row → inserts building, derives with one concept call and one item call, writes ready, returns the manifest", async () => {
    const a = admin();
    const call = vi.fn(goodModel);
    const r = await deriveAndStore(a, GEN, { now: NOW, call, load: async () => loaded() });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") throw new Error("unreachable");
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0].model).toBe("claude-haiku-5-5");
    expect(call.mock.calls[0][0].user).toContain("p1:s001"); // the hook needed the model
    expect(call.mock.calls[0][0].user).not.toContain('key="p1:s002"'); // scene.concept placed s002 mechanically
    const m = r.manifest;
    expect(m.segments.map((s) => s.key)).toEqual(["p1:s001", "p1:s002", "p1:s003", "p1:s990"]);
    expect(m.segments[1].concept).toMatchObject({ concept_id: "c001", method: "scene", availability: "available" });
    expect(m.segments[2].concept).toMatchObject({ concept_id: "c002", method: "model", availability: "available" });
    expect(m.items.every((i) => i.availability === "available")).toBe(true);
    expect(m.items[0].segment_ids).toEqual(["p1:s002"]);
    // S1 visual: every lesson segment unknown/caption_only with the S1 reason; the outro keeps its own
    for (const s of m.segments.filter((s) => s.slide_k !== null)) expect(s.visual).toEqual({ status: "unknown", show: "caption_only", reason: S1_VISUAL_REASON, judged_by: { model: null, prompt_version: null } });
    expect(m.segments[3].visual.reason).toMatch(/outro/);
    expect(m.moves.slide).toBe("degraded");
    expect(m.moves.segment).toBe("available");
    expect(m.moves.remediate).toBe("available");
    // the stored row
    const stored = a.tables.sk_manifests[0];
    expect(stored.status).toBe("ready");
    expect(stored.manifest_id).toBe(m.manifest_id);
    expect(stored.artifact_hash).toBe(artifactsHash(rows));
    expect(stored.artifact_paths).toEqual(rows.map((x) => x.storage_path).sort());
    expect(stored.script_id).toBe("S1");
    expect(stored.video_manifest_id).toBe("V1");
    expect(stored.format_version).toBe("3");
    expect(stored.completeness).toEqual(m.completeness);
    expect(stored.built_at).toBe(NOW.toISOString());
    const d = stored.derived_by as { model: string; prompt_versions: string[]; usage: { input_tokens: number; output_tokens: number; usd: number } };
    expect(d.model).toBe("claude-haiku-5-5");
    expect(d.prompt_versions).toEqual([CONCEPT_PROMPT_VERSION, ITEM_PROMPT_VERSION]);
    expect(d.usage).toEqual({ input_tokens: 2000, output_tokens: 400, usd: 2000 * 0.1e-6 + 400 * 0.5e-6 });
    expect(r.stats).toMatchObject({ segments: 4, items: 2, conceptsToModel: 2, itemsToModel: 2, visualCarried: 0 });
    // the insert came first, the ready write keyed on status=building
    expect(a.log.some((l) => l.startsWith("sk_manifests.insert"))).toBe(true);
    expect(a.log.filter((l) => l === 'sk_manifests.eq("status","building")')).toHaveLength(1);
  });

  it("no concept source → no model call at all, still ready", async () => {
    const a = admin();
    const call = vi.fn(goodModel);
    const r = await deriveAndStore(a, GEN, { now: NOW, call, load: async () => loaded({ concepts: null, concept_source: "none" }) });
    expect(r.status).toBe("ready");
    expect(call).not.toHaveBeenCalled();
    expect((a.tables.sk_manifests[0].derived_by as { model: string | null }).model).toBeNull();
  });

  it("a garbage model reply leaves the mappings unavailable with a reason — never a throw, never a guess", async () => {
    const a = admin();
    const r = await deriveAndStore(a, GEN, { now: NOW, call: async () => ({ text: "I cannot do that", usage: { input_tokens: 1, output_tokens: 1 } }), load: async () => loaded() });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.manifest.segments[2].concept).toMatchObject({ availability: "unavailable", reason: "model returned no assignment" });
    expect(r.manifest.items.every((i) => i.availability === "unavailable")).toBe(true);
    expect(r.manifest.moves.remediate).toBe("unavailable");
  });
});

describe("deriveAndStore — claim rules", () => {
  it("a building row younger than 10 minutes → {building}, nothing derived", async () => {
    const a = admin([row("building", { updated_at: new Date(NOW.getTime() - BUILDING_TTL_MS + 1000).toISOString() })]);
    const call = vi.fn(goodModel);
    const load = vi.fn(async () => loaded());
    expect(await deriveAndStore(a, GEN, { now: NOW, call, load })).toEqual({ status: "building" });
    expect(call).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(a.tables.sk_manifests[0].status).toBe("building");
  });

  it("a building row 10+ minutes old is abandoned → re-claimed and derived", async () => {
    const stuckAt = new Date(NOW.getTime() - BUILDING_TTL_MS).toISOString();
    const a = admin([row("building", { updated_at: stuckAt })]);
    const r = await deriveAndStore(a, GEN, { now: NOW, call: goodModel, load: async () => loaded() });
    expect(r.status).toBe("ready");
    expect(a.log).toContain(`sk_manifests.eq("updated_at","${stuckAt}")`);
  });

  it("stale and failed rows are claimed (where status is still that value)", async () => {
    for (const st of ["stale", "failed"]) {
      const a = admin([row(st, { stale_reason: "old" })]);
      const r = await deriveAndStore(a, GEN, { now: NOW, call: goodModel, load: async () => loaded() });
      expect(r.status).toBe("ready");
      expect(a.log).toContain(`sk_manifests.eq("status","${st}")`);
      expect(a.tables.sk_manifests[0].stale_reason).toBeNull();
    }
  });

  it("a ready row whose pins still hold → served as is, no derivation", async () => {
    const m = assemble(input, { model: null }, "2026-10-28T09:00:00Z");
    const a = admin([row("ready", { manifest: m })]);
    const call = vi.fn(goodModel);
    const r = await deriveAndStore(a, GEN, { now: NOW, call, load: async () => loaded() });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.manifest.manifest_id).toBe(m.manifest_id);
    expect(call).not.toHaveBeenCalled();
  });

  it("a ready row whose artifacts changed → flipped stale by the read-path, then claimed and rebuilt", async () => {
    const m = assemble(input, { model: null }, "2026-10-28T09:00:00Z");
    const changed = rows.map((x) => (x.id === "a1" ? { ...x, created_at: "2026-10-28T09:59:00+00:00" } : x));
    const a = admin([row("ready", { manifest: m })], changed);
    const r = await deriveAndStore(a, GEN, { now: NOW, call: goodModel, load: async () => loaded({ artifacts: changed }) });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.manifest.pinned.artifacts_hash).toBe(artifactsHash(changed));
    expect(a.log).toContain('sk_manifests.eq("status","stale")');
  });

  it("a lost insert race (23505) → {building}", async () => {
    const a = admin();
    // make the row appear between the read and the insert
    const origFrom = a.from.bind(a);
    let reads = 0;
    a.from = (t: string) => {
      if (t === "sk_manifests" && reads++ === 0) {
        const b = origFrom(t);
        const then = b.then;
        b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          a.tables.sk_manifests.push(row("building", { updated_at: NOW.toISOString() }));
          return then((v: { data: unknown }) => res({ ...v, data: null }), rej);
        };
        return b;
      }
      return origFrom(t);
    };
    const call = vi.fn(goodModel);
    expect(await deriveAndStore(a, GEN, { now: NOW, call, load: async () => loaded() })).toEqual({ status: "building" });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("deriveAndStore — failure paths (never throw)", () => {
  it("a load refusal writes failed with the reason", async () => {
    const a = admin();
    const { ManifestLoadError } = await import("../load");
    const r = await deriveAndStore(a, GEN, {
      now: NOW,
      call: goodModel,
      load: async () => {
        throw new ManifestLoadError("generation is a worksheet, not a presentation", "not_presentation");
      },
    });
    expect(r).toEqual({ status: "failed", reason: "not_presentation: generation is a worksheet, not a presentation" });
    expect(a.tables.sk_manifests[0]).toMatchObject({ status: "failed", stale_reason: "not_presentation: generation is a worksheet, not a presentation", updated_at: NOW.toISOString() });
  });

  it("a model failure writes failed (reason ≤ 300 chars)", async () => {
    const a = admin();
    const r = await deriveAndStore(a, GEN, {
      now: NOW,
      call: async () => {
        throw new Error("x".repeat(500));
      },
      load: async () => loaded(),
    });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("unreachable");
    expect(r.reason).toHaveLength(300);
    expect(String(a.tables.sk_manifests[0].stale_reason)).toHaveLength(300);
    expect(a.tables.sk_manifests[0].status).toBe("failed");
  });

  it("size guard: too many segments or items → failed 'too large', no model call", async () => {
    const many = Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => `s${String(i + 1).padStart(3, "0")}`);
    const big: KitInput = {
      ...input,
      scripts: [{ part: 1, of: 1, script: { script_id: "S", segments: many.map((id) => seg(id, id)) }, video: { manifest_id: "V", segments: many.map((id) => ({ segment_id: id, clip_duration_seconds: 1 })) } }],
    };
    expect(buildSegments(big.scripts, big.artifacts, GEN)).toHaveLength(MAX_SEGMENTS + 1);
    const call = vi.fn(goodModel);
    let a = admin();
    let r = await deriveAndStore(a, GEN, { now: NOW, call, load: async () => loaded(big) });
    expect(r).toEqual({ status: "failed", reason: `too large: ${MAX_SEGMENTS + 1} segments > ${MAX_SEGMENTS}` });
    a = admin();
    const items = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ ...input.items[0], q_id: `ws:x:q${i}` }));
    r = await deriveAndStore(a, GEN, { now: NOW, call, load: async () => loaded({ items }) });
    expect(r).toEqual({ status: "failed", reason: `too large: ${MAX_ITEMS + 1} items > ${MAX_ITEMS}` });
    expect(call).not.toHaveBeenCalled();
    expect(a.tables.sk_manifests[0].status).toBe("failed");
  });

  it("the ready write failing → failed row, not a throw", async () => {
    const a = admin();
    const origFrom = a.from.bind(a);
    a.from = (t: string) => {
      const b = origFrom(t);
      if (t === "sk_manifests") {
        const upd = b.update;
        b.update = (p: Row) => {
          if (p.status === "ready") {
            const c = upd({ ...p, status: "building" });
            const then = c.then;
            c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => then(() => res({ data: null, error: { message: "disk full" } }), rej);
            return c;
          }
          return upd(p);
        };
      }
      return b;
    };
    const r = await deriveAndStore(a, GEN, { now: NOW, call: goodModel, load: async () => loaded() });
    expect(r).toEqual({ status: "failed", reason: "sk_manifests write failed: disk full" });
    expect(a.tables.sk_manifests[0].status).toBe("failed");
  });
});

describe("visualForApp — the S1 limitation", () => {
  const judged = (m: KitManifest) => {
    const prev: KitManifest = JSON.parse(JSON.stringify(m));
    prev.segments[1].visual = { status: "distinct", show: "frame", reason: "new board; depicts the wall", judged_by: { model: "haiku", prompt_version: "m1-visual-v3" } };
    prev.segments[1].visual_metrics = { diff_prev: 0.2, diff_min_earlier: 0.2, nearest_earlier: null };
    prev.segments[2].visual = { status: "misleading", show: "fallback_frame", fallback_k: 1, reason: "golgi, not vacuole", judged_by: { model: "haiku", prompt_version: "m1-visual-v3" } };
    return prev;
  };

  it("without a previous manifest every lesson segment is unknown/caption_only", () => {
    const m = assemble(input, { model: null }, "t");
    const { carried } = visualForApp(m.segments, null, m.pinned.artifacts_hash);
    expect(carried).toBe(0);
    for (const s of m.segments.filter((s) => s.slide_k !== null)) expect(s.visual).toMatchObject({ status: "unknown", show: "caption_only", reason: S1_VISUAL_REASON });
  });

  it("carries frame-judged verdicts from a previous manifest with the SAME artifacts_hash (fallbacks re-verified)", () => {
    const m = assemble(input, { model: null }, "t");
    const prev = judged(m);
    const { carried } = visualForApp(m.segments, prev, m.pinned.artifacts_hash);
    expect(carried).toBe(2);
    expect(m.segments[1].visual.show).toBe("frame");
    expect(m.segments[1].visual_metrics?.diff_prev).toBe(0.2);
    expect(m.segments[2].visual).toMatchObject({ show: "fallback_frame", fallback_k: 1 });
    expect(m.segments[0].visual.reason).toBe(S1_VISUAL_REASON); // s001 was never judged → S1 default
  });

  it("a different artifacts_hash carries nothing", () => {
    const m = assemble(input, { model: null }, "t");
    const prev = judged(m);
    prev.pinned.artifacts_hash = "other";
    expect(visualForApp(m.segments, prev, m.pinned.artifacts_hash).carried).toBe(0);
    expect(m.segments[1].visual.show).toBe("caption_only");
  });

  it("a carried fallback whose target is no longer a shown frame degrades to caption_only", () => {
    const m = assemble(input, { model: null }, "t");
    const prev = judged(m);
    prev.segments[1].visual = { status: "unknown", show: "caption_only", reason: "x", judged_by: { model: null, prompt_version: null } }; // not judged → not carried
    visualForApp(m.segments, prev, m.pinned.artifacts_hash);
    expect(m.segments[2].visual.show).toBe("caption_only");
    expect(m.segments[2].visual.reason).toMatch(/not verified in this build/);
  });

  it("deriveAndStore carries the previous row's verdicts and records their prompt version", async () => {
    const m = assemble(input, { model: null }, "2026-10-28T09:00:00Z");
    const a = admin([row("stale", { manifest: judged(m) })]);
    const r = await deriveAndStore(a, GEN, { now: NOW, call: goodModel, load: async () => loaded() });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.stats?.visualCarried).toBe(2);
    expect(r.manifest.segments[1].visual.show).toBe("frame");
    expect(r.manifest.derived_by.prompt_versions).toContain("m1-visual-v3");
    expect(String((a.tables.sk_manifests[0].derived_by as { visual: string }).visual)).toMatch(/carried 2/);
  });
});

describe("deriveAndStore — concurrent model passes (fix/sk-speed)", () => {
  it("both Haiku calls are in flight together, and the manifest equals the sequential one (fixtures/derived-sequential.json) but for derived_by.at", async () => {
    const { default: sequential } = await import("./fixtures/derived-sequential.json");
    let inFlight = 0;
    let peak = 0;
    const call: ModelCall = async (req) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return goodModel(req);
    };
    const r = await deriveAndStore(admin(), GEN, { now: NOW, call, load: async () => loaded() });
    if (r.status !== "ready") throw new Error(`expected ready, got ${r.status}`);
    expect(peak).toBe(2);
    const strip = (m: unknown) => {
      const c = JSON.parse(JSON.stringify(m)) as { derived_by: Record<string, unknown> };
      delete c.derived_by.at;
      return c;
    };
    expect(strip(r.manifest)).toEqual(strip(sequential));
  });
});
