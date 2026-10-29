import { describe, expect, it } from "vitest";
import { FakeAdmin, type Row } from "./fake-admin";
import { generationOfPath, pinnedGenerationIds, readManifest } from "../store";
import { MANIFEST_DERIVATION_VERSION, artifactsHash, assemble, type ArtifactRow, type KitInput, type KitManifest } from "../derive";

const OWNER = "9d41e12e-e9c9-4b82-b3a9-3421c2c57726";
const GEN = "eef426bd-523b-4fed-827c-95421263d89a";
const WS = "a416ce84-5c87-46fa-8874-22a8cbfdd1d2";
const NOW = new Date("2026-10-28T10:00:00Z");

const rows: ArtifactRow[] = [
  { id: "a1", generation_id: GEN, kind: "video_mp4", storage_path: `${OWNER}/${GEN}/lesson.mp4`, created_at: "2026-10-25T09:40:29+00:00" },
  { id: "a2", generation_id: GEN, kind: "script_json", storage_path: `${OWNER}/${GEN}/script.json`, created_at: "2026-10-25T09:40:30+00:00" },
  { id: "a3", generation_id: WS, kind: "questions_json", storage_path: `${OWNER}/${WS}/worksheet_questions.json`, created_at: "2026-10-25T09:35:21+00:00" },
];
const input: KitInput = {
  generation_id: GEN,
  book_id: null,
  chapter_ref: null,
  article_id: "art",
  format_version: 3,
  language: "en",
  scripts: [{ part: 1, of: 1, script: { script_id: "S", segments: [{ segment_id: "s001", slide_heading: "H", text: "t" }] }, video: { manifest_id: "V", segments: [{ segment_id: "s001", clip_duration_seconds: 5 }] } }],
  artifacts: rows,
  concepts: null,
  concept_source: "none",
  items: [],
  has_video: { 1: true },
};
const manifest: KitManifest = assemble(input, { model: null }, "2026-10-28T09:00:00Z");

function admin(status: string, over: Partial<Row> = {}, liveRows: ArtifactRow[] = rows, fv: number | null = 3) {
  return new FakeAdmin({
    sk_manifests: [{ generation_id: GEN, status, manifest, stale_reason: status === "failed" ? "boom" : null, built_at: "2026-10-28T09:00:00Z", updated_at: "2026-10-28T09:00:00Z", ...over }],
    artifacts: liveRows.map((r) => ({ ...r })),
    generations: [{ id: GEN, params: { format_version: fv } }],
  });
}

describe("readManifest — the read-path rule", () => {
  it("missing / building / failed / stale answer with their status and never a manifest", async () => {
    expect(await readManifest(new FakeAdmin({ sk_manifests: [] }), GEN, NOW)).toEqual({ status: "missing" });
    expect(await readManifest(admin("building"), GEN, NOW)).toEqual({ status: "building" });
    expect(await readManifest(admin("failed"), GEN, NOW)).toEqual({ status: "failed", reason: "boom" });
    expect(await readManifest(admin("stale", { stale_reason: "artifacts update at …" }), GEN, NOW)).toEqual({ status: "stale", reason: "artifacts update at …" });
  });

  it("ready + live rows match the pins → the manifest", async () => {
    const a = admin("ready");
    const r = await readManifest(a, GEN, NOW);
    expect(r.status).toBe("ready");
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.manifest.manifest_id).toBe(manifest.manifest_id);
    expect(r.builtAt).toBe("2026-10-28T09:00:00Z");
    // the re-check read the live rows of BOTH pinned generations
    expect(a.log.some((l) => l === `artifacts.in("generation_id",${JSON.stringify([GEN, WS])})`)).toBe(true);
    expect(a.tables.sk_manifests[0].status).toBe("ready");
  });

  it("ready but a presentation artifact row changed → flips the row to stale and answers stale", async () => {
    const changed = rows.map((r) => (r.id === "a1" ? { ...r, created_at: "2026-10-28T09:59:00+00:00" } : r));
    const a = admin("ready", {}, changed);
    expect(artifactsHash(changed)).not.toBe(manifest.pinned.artifacts_hash);
    const r = await readManifest(a, GEN, NOW);
    expect(r.status).toBe("stale");
    expect(a.tables.sk_manifests[0].status).toBe("stale");
    expect(String(a.tables.sk_manifests[0].stale_reason)).toMatch(/read-time re-check/);
    expect(a.tables.sk_manifests[0].updated_at).toBe(NOW.toISOString());
  });

  it("ready but the pinned WORKSHEET's row vanished (the trigger would not see this) → stale", async () => {
    const a = admin("ready", {}, rows.filter((r) => r.generation_id !== WS));
    expect((await readManifest(a, GEN, NOW)).status).toBe("stale");
    expect(a.tables.sk_manifests[0].status).toBe("stale");
  });

  it("ready but a NEW artifact row appeared on the presentation → stale", async () => {
    const a = admin("ready", {}, [...rows, { id: "a9", generation_id: GEN, kind: "video_mp4", storage_path: `${OWNER}/${GEN}/lesson_part2.mp4`, created_at: "2026-10-28T00:00:00+00:00" }]);
    expect((await readManifest(a, GEN, NOW)).status).toBe("stale");
  });

  it("ready but the generation's format_version moved → stale", async () => {
    const a = admin("ready", {}, rows, 4);
    expect((await readManifest(a, GEN, NOW)).status).toBe("stale");
    expect(a.tables.sk_manifests[0].status).toBe("stale");
  });

  it("ready but built by an older derivation (no derivation_version = 1) → stale, so it is rebuilt with the bank traces", async () => {
    expect(manifest.derivation_version).toBe(MANIFEST_DERIVATION_VERSION);
    const old = JSON.parse(JSON.stringify(manifest)) as KitManifest;
    delete old.derivation_version;
    const a = admin("ready", { manifest: old });
    const r = await readManifest(a, GEN, NOW);
    expect(r.status).toBe("stale");
    expect(a.tables.sk_manifests[0].status).toBe("stale");
    expect(String(a.tables.sk_manifests[0].stale_reason)).toMatch(/derivation version 1 != 2/);
    // the live-row re-check is not even needed: no artifacts read
    expect(a.log.some((l) => l.startsWith("artifacts."))).toBe(false);
  });

  it("a ready row without a manifest document is flipped to stale, not served", async () => {
    const a = admin("ready", { manifest: {} });
    const r = await readManifest(a, GEN, NOW);
    expect(r.status).toBe("stale");
    expect(a.tables.sk_manifests[0].status).toBe("stale");
  });

  it("never touches storage or the model", async () => {
    const a = admin("ready");
    await readManifest(a, GEN, NOW);
    expect(a.log.some((l) => l.startsWith("storage."))).toBe(false);
  });
});

describe("pinned generation ids", () => {
  it("come from the artifact paths' second component plus the manifest's own generation", () => {
    expect(generationOfPath(`${OWNER}/${WS}/worksheet_questions.json`)).toBe(WS);
    expect(generationOfPath("weird/path")).toBeNull();
    expect(generationOfPath(`${OWNER}/not-a-uuid/x.json`)).toBeNull();
    expect(pinnedGenerationIds(manifest)).toEqual([GEN, WS]);
  });
});
