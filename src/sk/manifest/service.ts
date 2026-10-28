// Kit Manifest — derivation on demand, stored in `sk_manifests` (S1 slice A;
// Final Plan §5.2, §9.1, §9.6).
//
// WHY THE APP AND NOT A WORKER JOB (decided 2026-10-28, a deviation from plan
// §5.2 "queued job"): the worker's generic lane claims ANY unknown jobs.type
// and dispatches by generations.kind — a "manifest" job carrying a
// presentation's generation_id would REBUILD THE KIT. So derivation runs here,
// in the route's request, and `sk_manifests.status` is the queue:
//   building  a derivation is running (claimed at most once per 10 minutes)
//   ready     served — after the read path re-verifies the pins (store.ts)
//   stale     the 0163 trigger or the read-time re-check found the artifacts changed
//   failed    the last derivation failed; stale_reason says why (≤ 300 chars)
//
// Claim rules (deriveAndStore):
//   - no row                      → insert `building` (a 23505 means someone else just did)
//   - row stale | failed          → update to `building` where status is still that value
//   - row building, < 10 min old  → return {status:"building"} without deriving
//   - row building, ≥ 10 min old  → treat as abandoned: re-claim (keyed on updated_at)
//   - row ready                   → re-read through store.readManifest; served if still
//                                   fresh, otherwise it is now `stale` and claimed above
//
// Model passes: ONE Haiku call for concepts (segments the mechanical rules did
// not place) and ONE for items (questions without a valid objective_ref),
// through src/utils/claude-backend.ts (OIDC role in production; no `temperature`
// — Haiku 5.5 refuses it). The VISUAL pass needs the slide frames and the app
// has no ffmpeg: see visualForApp() for the S1 limitation.
//
// deriveAndStore never throws: every failure is written as `failed` and
// returned as such.

import type { ArtifactRow, KitManifest, ManifestSegment, ModelAssignment, ModelItem, ModelPasses } from "./derive";
import { assemble, assertNoMisleadingFrame, buildSegments, mechanicalItem, movesOf, parseModelJson, segmentsNeedingModel } from "./derive";
import { CONCEPT_PROMPT_VERSION, conceptPrompt, itemPrompt } from "./prompts";
import { loadKitInput, ManifestLoadError, type LoadedKit, type ManifestAdmin } from "./load";
import { readManifest, readRow, type ManifestRow, type ReadResult } from "./store";
import { claudeClient, claudeModel } from "@/utils/claude-backend";

export const MANIFEST_MODEL = "claude-haiku-5-5";
export const BUILDING_TTL_MS = 10 * 60_000;
export const MAX_SEGMENTS = 60;
export const MAX_ITEMS = 80;
const MODEL_MAX_TOKENS = 6000;
/** worker shared/claude_client.py MODEL_PRICING["claude-haiku-5-5"], USD per token. */
const PRICE_IN = 0.1 / 1e6;
const PRICE_OUT = 0.5 / 1e6;

export type ModelUsage = { input_tokens: number; output_tokens: number };
/** One model round trip (system + user → text). Injected in tests; the default
 * goes through claudeClient()/claudeModel(). */
export type ModelCall = (req: { model: string; system: string; user: string; maxTokens: number }) => Promise<{ text: string; usage: ModelUsage }>;

export type DeriveOptions = {
  model?: string;
  now?: Date;
  call?: ModelCall;
  /** Test seam: replaces loadKitInput. */
  load?: (admin: ManifestAdmin, generationId: string) => Promise<LoadedKit>;
};

export async function defaultModelCall(req: { model: string; system: string; user: string; maxTokens: number }): Promise<{ text: string; usage: ModelUsage }> {
  const client = claudeClient();
  const res = (await client.messages.create({
    model: claudeModel(req.model),
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
  })) as unknown as { content: { type: string; text?: string }[]; usage: ModelUsage; stop_reason: string };
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text || "").join("");
  if (res.stop_reason === "max_tokens") throw new Error(`model reply hit max_tokens (${res.usage.output_tokens} out)`);
  return { text, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } };
}

export const S1_VISUAL_REASON = "no frame check in app (S1)";

/** S1: the app cannot extract slide frames (no ffmpeg) and the mechanical
 * `hold_secs`/heading-change heuristics are NOT a visual verdict, so every
 * lesson segment is `unknown` / `caption_only` with this reason — UNLESS a
 * previously stored manifest for the SAME artifacts_hash already carries a
 * frame-judged verdict for that segment key (e.g. seeded from the M1 CLI, or
 * a later frame-aware pass): those are carried over verbatim, then the
 * misleading/fallback invariant is re-asserted. The founder's worker
 * asset-correctness gate plus a frame-aware pass lifts this limitation. */
export function visualForApp(segments: ManifestSegment[], previous: KitManifest | null, artifactsHash: string): { carried: number } {
  const prevByKey = new Map<string, ManifestSegment>();
  if (previous && previous.pinned && previous.pinned.artifacts_hash === artifactsHash && Array.isArray(previous.segments)) {
    for (const s of previous.segments) if (s.visual && s.visual.judged_by && s.visual.judged_by.model) prevByKey.set(s.key, s);
  }
  let carried = 0;
  for (const s of segments) {
    if (s.slide_k === null) {
      s.visual = { status: "unknown", show: "caption_only", reason: "video-only outro (not judged)", judged_by: { model: null, prompt_version: null } };
      continue;
    }
    const prev = prevByKey.get(s.key);
    if (prev) {
      s.visual = { ...prev.visual };
      if (prev.visual_metrics) s.visual_metrics = { ...prev.visual_metrics };
      carried++;
    } else {
      s.visual = { status: "unknown", show: "caption_only", reason: S1_VISUAL_REASON, judged_by: { model: null, prompt_version: null } };
    }
  }
  // A carried fallback must still point at a carried, shown frame — otherwise degrade it.
  for (const s of segments) {
    if (s.visual.show !== "fallback_frame") continue;
    const t = segments.find((o) => o.k === s.visual.fallback_k);
    if (!t || t.visual.show !== "frame") s.visual = { ...s.visual, show: "caption_only", reason: `${s.visual.reason}; fallback frame not verified in this build` };
  }
  assertNoMisleadingFrame(segments);
  return { carried };
}

type Claim = { claimed: true; previous: KitManifest | null } | { claimed: false; result: ReadResult };

function previousManifestOf(row: ManifestRow | null): KitManifest | null {
  const m = row?.manifest as KitManifest | null | undefined;
  return m && m.pinned && Array.isArray(m.segments) ? m : null;
}

async function claim(admin: ManifestAdmin, generationId: string, now: Date): Promise<Claim> {
  const row = await readRow(admin, generationId);
  const nowIso = now.toISOString();
  if (!row) {
    const { error } = await admin.from("sk_manifests").insert({
      generation_id: generationId,
      manifest_id: "",
      artifact_hash: "",
      artifact_paths: [],
      manifest: {},
      status: "building",
      stale_reason: null,
      built_at: nowIso,
      updated_at: nowIso,
    });
    if (error) {
      if ((error as { code?: string }).code === "23505") return { claimed: false, result: { status: "building" } };
      throw new Error(`sk_manifests insert failed: ${(error as { message?: string }).message ?? "unknown"}`);
    }
    return { claimed: true, previous: null };
  }
  if (row.status === "ready") {
    const r = await readManifest(admin, generationId, now);
    if (r.status === "ready") return { claimed: false, result: r };
    // readManifest flipped it to stale: claim that.
    return claimFrom(admin, generationId, { ...row, status: "stale" }, nowIso);
  }
  if (row.status === "building") {
    const age = now.getTime() - new Date(row.updated_at).getTime();
    if (Number.isFinite(age) && age < BUILDING_TTL_MS) return { claimed: false, result: { status: "building" } };
  }
  return claimFrom(admin, generationId, row, nowIso);
}

/** Optimistic claim: flip to `building` only if the row still looks like what we read. */
async function claimFrom(admin: ManifestAdmin, generationId: string, row: ManifestRow, nowIso: string): Promise<Claim> {
  let q = admin
    .from("sk_manifests")
    .update({ status: "building", stale_reason: null, updated_at: nowIso })
    .eq("generation_id", generationId)
    .eq("status", row.status);
  if (row.status === "building") q = q.eq("updated_at", row.updated_at);
  const { data, error } = await q.select("generation_id");
  if (error) throw new Error(`sk_manifests claim failed: ${(error as { message?: string }).message ?? "unknown"}`);
  if (!data || !(data as unknown[]).length) return { claimed: false, result: { status: "building" } };
  return { claimed: true, previous: previousManifestOf(row) };
}

async function writeFailed(admin: ManifestAdmin, generationId: string, reason: string, now: Date): Promise<void> {
  try {
    await admin
      .from("sk_manifests")
      .update({ status: "failed", stale_reason: reason.slice(0, 300), updated_at: now.toISOString() })
      .eq("generation_id", generationId)
      .eq("status", "building");
  } catch (e) {
    console.warn("sk-manifest: failed-row write threw", (e as Error).message);
  }
}

export type DeriveStats = { segments: number; items: number; conceptsToModel: number; itemsToModel: number; visualCarried: number; usage: { input_tokens: number; output_tokens: number; usd: number } };

/** Derive the manifest for one presentation and store it. Returns the read
 * result afterwards (ready | building | failed …) and never throws. */
export async function deriveAndStore(admin: ManifestAdmin, generationId: string, opts: DeriveOptions = {}): Promise<ReadResult & { stats?: DeriveStats }> {
  const now = opts.now ?? new Date();
  const model = opts.model ?? MANIFEST_MODEL;
  const call = opts.call ?? defaultModelCall;
  const load = opts.load ?? loadKitInput;

  let c: Claim;
  try {
    c = await claim(admin, generationId, now);
  } catch (e) {
    return { status: "failed", reason: `claim failed: ${(e as Error).message}`.slice(0, 300) };
  }
  if (!c.claimed) return c.result;

  try {
    const kit = await load(admin, generationId);
    const input = kit.input;
    const segs = buildSegments(input.scripts, input.artifacts, input.generation_id);
    if (segs.length > MAX_SEGMENTS) throw new Error(`too large: ${segs.length} segments > ${MAX_SEGMENTS}`);
    if (input.items.length > MAX_ITEMS) throw new Error(`too large: ${input.items.length} items > ${MAX_ITEMS}`);

    const usage = { input_tokens: 0, output_tokens: 0, usd: 0 };
    const add = (u: ModelUsage) => {
      usage.input_tokens += u.input_tokens;
      usage.output_tokens += u.output_tokens;
      usage.usd += u.input_tokens * PRICE_IN + u.output_tokens * PRICE_OUT;
    };
    let conceptsPass: ModelAssignment[] | undefined;
    let itemsPass: ModelItem[] | undefined;
    let conceptsToModel = 0;
    let itemsToModel = 0;
    let usedModel = false;
    if (input.concepts && input.concepts.length) {
      const todo = segmentsNeedingModel(segs, input.concepts, input.language);
      conceptsToModel = todo.length;
      if (todo.length) {
        const p = conceptPrompt(input.concepts, todo.map((s) => ({ key: s.key, type: s.type, heading: s.heading, narration: s.narration })), CONCEPT_PROMPT_VERSION);
        const r = await call({ model, system: p.system, user: p.user, maxTokens: MODEL_MAX_TOKENS });
        add(r.usage);
        usedModel = true;
        conceptsPass = parseModelJson<{ assignments: ModelAssignment[] }>(r.text)?.assignments || [];
      } else conceptsPass = [];
      const ids = new Set(input.concepts.map((x) => x.concept_id));
      const pending = input.items.filter((i) => !mechanicalItem(i, input.article_id, ids, input.article_source_id ?? null));
      itemsToModel = pending.length;
      if (pending.length) {
        const p = itemPrompt(
          input.concepts,
          segs.filter((s) => s.slide_k !== null).map((s) => ({ key: s.key, type: s.type, heading: s.heading, narration: s.narration })),
          pending.map((i) => ({ q: i.q_id, type: i.type, prompt: i.prompt, answer: i.answer, hint: i.hint })),
        );
        const r = await call({ model, system: p.system, user: p.user, maxTokens: MODEL_MAX_TOKENS });
        add(r.usage);
        usedModel = true;
        itemsPass = parseModelJson<{ items: ModelItem[] }>(r.text)?.items || [];
      } else itemsPass = [];
    }
    const passes: ModelPasses = { concepts: conceptsPass, items: itemsPass, model: usedModel ? model : null, usage, concept_prompt_version: CONCEPT_PROMPT_VERSION };
    const m = assemble(input, passes, now.toISOString());
    const { carried } = visualForApp(m.segments, c.previous, m.pinned.artifacts_hash);
    m.moves = movesOf(m.completeness, m.segments, m.items);
    if (carried) {
      // assemble() lists the concept/item prompt versions; add the carried visual verdicts' version(s).
      const pv = new Set(m.derived_by.prompt_versions);
      for (const s of m.segments) if (s.visual.judged_by.prompt_version) pv.add(s.visual.judged_by.prompt_version);
      m.derived_by.prompt_versions = Array.from(pv);
    }

    const { error } = await admin
      .from("sk_manifests")
      .update({
        manifest_id: m.manifest_id,
        script_id: m.pinned.script_ids.filter(Boolean).join(",") || null,
        video_manifest_id: m.pinned.video_manifest_ids.filter(Boolean).join(",") || null,
        format_version: m.pinned.format_version === null ? null : String(m.pinned.format_version),
        artifact_hash: m.pinned.artifacts_hash,
        artifact_paths: m.pinned.artifact_paths,
        manifest: m,
        completeness: m.completeness,
        derived_by: { model: m.derived_by.model, prompt_versions: m.derived_by.prompt_versions, at: m.derived_by.at, usage, visual: carried ? `carried ${carried} verdict(s) from the previous manifest` : S1_VISUAL_REASON },
        status: "ready",
        stale_reason: null,
        built_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("generation_id", generationId)
      .eq("status", "building");
    if (error) throw new Error(`sk_manifests write failed: ${(error as { message?: string }).message ?? "unknown"}`);

    const stats: DeriveStats = { segments: m.segments.length, items: m.items.length, conceptsToModel, itemsToModel, visualCarried: carried, usage };
    const r = await readManifest(admin, generationId, now);
    return { ...r, stats };
  } catch (e) {
    const msg = e instanceof ManifestLoadError ? `${e.code}: ${e.message}` : (e as Error)?.message || String(e);
    await writeFailed(admin, generationId, msg, now);
    return { status: "failed", reason: msg.slice(0, 300) };
  }
}

export type { ArtifactRow };
