// Kit Manifest derivation — pure logic (spike M1, plan §5.2 + §9.1 + §9.6).
//
// Everything here is deterministic and I/O-free so it can be unit-tested; the
// CLI (tools/sk/manifest/derive.ts) fetches nothing itself either — it reads a
// kit directory, calls Haiku for the two model passes, and writes the JSON.
//
// Mechanical rules (each one is documented in docs/SK-M1-REPORT.md):
//  T1 segments come from script.video.segments in order; start_s/end_s are the
//     cumulative sum of clip_duration_seconds (the mp4 is a straight concat of
//     the clips — measured within 0.03 s on all M1 kits).
//  T2 slide_k = 1-based position of the segment in script.script.segments for
//     its part (the deck has one slide per script segment, same order). The
//     video-only outro (s990) has slide_k null.
//  T3 slide_t = end_s - SLIDE_EPS_S (≈1.5 frames at 24 fps): the last frame of
//     the segment. No transition bleeds (cuts are hard); see report §3.
//  C1 concept↔segment is mechanical when scene.concept equals a concept id or
//     name, or when ALL content words (>= 2 of them) of exactly one concept name
//     appear in the segment heading. Everything else goes to ONE Haiku pass.
//  C2 a model assignment is accepted only if its ids exist and its confidence
//     >= CONCEPT_MIN_CONFIDENCE; otherwise the segment's concept is unavailable
//     with a reason.
//  I1 item→concept is mechanical when the item came from the catalogue bank AND
//     (I1b, translations) its source item belongs to the article version the kit's article was translated from, AND
//     the bank row's article_id equals the kit's article_id (objective_ref is
//     only meaningful against the article version it was written for).
//  I2 everything else goes to ONE Haiku pass; accepted only with valid ids and
//     confidence >= ITEM_MIN_CONFIDENCE, else unavailable with a reason.

import { createHash } from "crypto";
import { CONCEPT_PROMPT_VERSION, ITEM_PROMPT_VERSION } from "./prompts";

export const MANIFEST_SCHEMA = "sk-kit-manifest/m1";
/** Bumped whenever the LOADER or the derivation rules change what a manifest
 * would say for the same artifacts. A stored manifest with another version is
 * served as stale and rebuilt (store.ts readManifest). Manifests written before
 * the field existed count as version 1.
 *   1  S1: items never carried bank traces (objective_ref path never ran)
 *   2  S3 slice A: items carry topic_questions traces (bank_article_id, source article) */
export const MANIFEST_DERIVATION_VERSION = 2;
export const SLIDE_EPS_S = 0.0625;
export const CONCEPT_MIN_CONFIDENCE = 0.7;
export const ITEM_MIN_CONFIDENCE = 0.8;

export type Availability = "available" | "degraded" | "unavailable";

// ── inputs ──────────────────────────────────────────────────────────────────
export type ScriptSegment = {
  segment_id: string;
  type?: string;
  text?: string;
  slide_heading?: string | null;
  slide_points?: unknown[] | null;
  hold_secs?: number | null;
  scene?: { concept?: string | null; elements?: { id?: string; asset?: string | null }[] } | null;
};
export type VideoSegment = { segment_id: string; clip_duration_seconds?: number | null; audio_duration_seconds?: number | null };
export type ScriptFile = {
  part?: number | null;
  of?: number | null;
  language?: string | null;
  script: { script_id?: string; segments: ScriptSegment[] };
  video: { manifest_id?: string; segments: VideoSegment[] };
};
export type ArtifactRow = { id: string; generation_id: string; kind: string; storage_path: string; created_at: string };
export type ConceptSrc = { concept_id: string; name: string; definition: string };
export type ItemSrc = {
  q_id: string; // unique within the manifest, e.g. "ws:q3" or "quiz:q7"
  source: "worksheet" | "quiz";
  generation_id: string;
  type: string;
  prompt: string;
  answer: string;
  bank_item_id?: string;
  bank_article_id?: string;
  /** For a translated bank item: the article_id of the item it was translated FROM (null = source not found). */
  bank_source_article_id?: string | null;
  objective_ref?: string;
  difficulty?: number;
  hint?: string;
};

export type KitInput = {
  generation_id: string;
  book_id: string | null;
  chapter_ref: string | null;
  article_id: string | null;
  /** topic_articles.source_article_id of the kit's article (the English version a translation was made from). */
  article_source_id?: string | null;
  format_version: number | null;
  language: string | null;
  scripts: ScriptFile[];
  artifacts: ArtifactRow[]; // presentation + worksheet (+ quiz) rows
  concepts: ConceptSrc[] | null; // null = no concept source
  concept_source: "chapter_grounding" | "article_objectives" | "none";
  items: ItemSrc[];
  has_video: Record<number, boolean>; // part → mp4 artifact exists
};

// ── outputs ─────────────────────────────────────────────────────────────────
export type ConceptLink = {
  concept_id: string | null;
  secondary: string[];
  method: "scene" | "heading" | "model" | "none";
  confidence: number;
  availability: Availability;
  reason?: string;
};
export type ManifestSegment = {
  key: string; // "p<part>:<segment_id>"
  segment_id: string;
  part: number;
  k: number; // 0-based order across the whole kit
  start_s: number;
  end_s: number;
  slide_t: number;
  slide_k: number | null;
  type: string;
  heading: string;
  points: string[];
  narration: string;
  concept_slug: string | null;
  assets: string[];
  video_path: string | null;
  concept: ConceptLink;
  /** Contract with the M2 Board controller — field names are fixed. */
  visual: SegmentVisual;
  visual_metrics?: VisualMetrics;
};

// ── V1–V3: semantic visual suitability ─────────────────────────────────────
export type VisualStatus = "distinct" | "reused_relevant" | "misleading" | "unknown";
export type VisualShow = "frame" | "fallback_frame" | "caption_only";
export type SegmentVisual = {
  status: VisualStatus;
  show: VisualShow;
  /** `k` (0-based kit-wide segment index) of the segment whose slide frame to show instead. */
  fallback_k?: number;
  reason: string;
  judged_by: { model: string | null; prompt_version: string | null };
};
/** Mechanical image difference of this segment's slide frame (fraction of masked pixels changed). */
export type VisualMetrics = { diff_prev: number | null; diff_min_earlier: number | null; nearest_earlier: string | null; model_confidence?: number };
/** m1-visual-v1 answered depicts yes/no; m1-visual-v2 answers verdict matches/related/unrelated. */
export type ModelVisual = { depicts?: "yes" | "no"; verdict?: "matches" | "related" | "unrelated"; confidence: number; reason?: string };

/** "yes" = the drawing may be shown for this segment; "no" = it would mislead; null = unusable reply. */
export function relevanceOf(j: ModelVisual | undefined): "yes" | "no" | null {
  if (!j) return null;
  if (j.verdict === "matches" || j.verdict === "related") return "yes";
  if (j.verdict === "unrelated") return "no";
  if (j.depicts === "yes" || j.depicts === "no") return j.depicts;
  return null;
}

/** Calibrated on the M1 kits: reused boards measured 0.000–0.026, new boards ≥ 0.04 (report §3b). */
export const VISUAL_DISTINCT_MIN = 0.03;
export const VISUAL_MIN_CONFIDENCE = 0.7;

export function isDistinct(m: VisualMetrics | undefined): boolean | null {
  if (!m) return null;
  if (m.diff_prev === null && m.diff_min_earlier === null) return true; // first segment of the kit
  const vals = [m.diff_prev, m.diff_min_earlier].filter((x): x is number => typeof x === "number");
  return vals.every((v) => v >= VISUAL_DISTINCT_MIN);
}

/** V1+V2: one segment, before fallbacks. A misleading frame is NEVER `show: "frame"`. */
export function decideVisual(
  metrics: VisualMetrics | undefined,
  judgement: ModelVisual | undefined,
  judgedBy: SegmentVisual["judged_by"],
): SegmentVisual {
  if (!metrics) return { status: "unknown", show: "caption_only", reason: "no slide frame measured", judged_by: judgedBy };
  const rel = relevanceOf(judgement);
  if (!judgement || rel === null)
    return { status: "unknown", show: "caption_only", reason: "no model judgement", judged_by: judgedBy };
  const conf = Number.isFinite(judgement.confidence) ? judgement.confidence : 0;
  if (conf < VISUAL_MIN_CONFIDENCE)
    return { status: "unknown", show: "caption_only", reason: `model confidence ${conf} < ${VISUAL_MIN_CONFIDENCE}: ${judgement.reason || ""}`.trim(), judged_by: judgedBy };
  if (rel === "no")
    return { status: "misleading", show: "caption_only", reason: judgement.reason || "drawing does not depict this segment", judged_by: judgedBy };
  const distinct = isDistinct(metrics);
  return {
    status: distinct ? "distinct" : "reused_relevant",
    show: "frame",
    reason: `${distinct ? "new board" : `board reused (diff ${metrics.diff_prev ?? metrics.diff_min_earlier})`}; ${judgement.reason || "depicts the segment"}`,
    judged_by: judgedBy,
  };
}

/** Measured image difference between two segments' slide frames (keys), or null when not measured. */
export type FrameDiff = (aKey: string, bKey: string) => number | null;

/** V3: a misleading segment borrows a VERIFIED frame — another segment of the same kit whose own
 * frame was judged relevant (show "frame"), whose primary concept is this segment's primary
 * concept (both available), and whose picture is measurably DIFFERENT from the misleading frame
 * (diff >= VISUAL_DISTINCT_MIN; otherwise it is the same picture under another heading).
 * Nearest earlier first, then nearest later. Otherwise caption only. */
export function resolveFallbacks(segments: ManifestSegment[], diff?: FrameDiff): void {
  for (const s of segments) {
    if (s.visual.status !== "misleading") continue;
    const cid = s.concept.availability === "available" ? s.concept.concept_id : null;
    if (!cid) {
      s.visual = { ...s.visual, show: "caption_only", reason: `${s.visual.reason}; no mapped concept, so no verified fallback` };
      continue;
    }
    const ok = (o: ManifestSegment) =>
      o.key !== s.key && o.visual.show === "frame" && (o.visual.status === "distinct" || o.visual.status === "reused_relevant") &&
      o.concept.availability === "available" && o.concept.concept_id === cid &&
      (() => {
        const d = diff ? diff(s.key, o.key) : null;
        return d !== null && d >= VISUAL_DISTINCT_MIN; // unmeasured or same picture → not verified
      })();
    const earlier = segments.filter((o) => o.k < s.k && ok(o)).sort((a, b) => b.k - a.k);
    const later = segments.filter((o) => o.k > s.k && ok(o)).sort((a, b) => a.k - b.k);
    const pick = earlier[0] || later[0];
    s.visual = pick
      ? { ...s.visual, show: "fallback_frame", fallback_k: pick.k, reason: `${s.visual.reason}; using ${pick.key} (same concept ${cid}, frame judged relevant)` }
      : { ...s.visual, show: "caption_only", reason: `${s.visual.reason}; no different frame verified for ${cid}` };
  }
  assertNoMisleadingFrame(segments);
}

export function assertNoMisleadingFrame(segments: ManifestSegment[]): void {
  for (const s of segments) {
    if ((s.visual.status === "misleading" || s.visual.status === "unknown") && s.visual.show === "frame")
      throw new Error(`visual invariant broken: ${s.key} is ${s.visual.status} but show=frame`);
    if (s.visual.show === "fallback_frame") {
      const t = segments.find((o) => o.k === s.visual.fallback_k);
      if (!t || t.visual.show !== "frame") throw new Error(`visual invariant broken: ${s.key} falls back to an unverified frame`);
    }
  }
}
export type ManifestItem = {
  q_id: string;
  source: "worksheet" | "quiz";
  generation_id: string;
  type: string;
  prompt_hash: string;
  concept_ids: string[];
  segment_ids: string[];
  method: "objective_ref" | "model" | "none";
  confidence: number;
  availability: Availability;
  reason?: string;
  difficulty?: number;
  bank_item_id?: string;
};
export type KitManifest = {
  schema: string;
  /** MANIFEST_DERIVATION_VERSION at build time; absent on manifests built before S3 (= 1). */
  derivation_version?: number;
  manifest_id: string;
  generation_id: string;
  book_id: string | null;
  chapter_ref: string | null;
  article_id: string | null;
  parts: number[];
  language: string | null;
  format_version: number | null;
  pinned: {
    script_ids: string[];
    video_manifest_ids: string[];
    format_version: number | null;
    artifact_paths: string[];
    artifacts_hash: string;
  };
  completeness: {
    video: "ok" | "missing" | "partial";
    script: "ok" | "legacy" | "missing";
    questions: "ok" | "none";
    concepts: "ok" | "none";
    format_version: number | null;
  };
  moves: Record<"intro" | "segment" | "slide" | "practise" | "walkthrough" | "explain" | "remediate", Availability>;
  segments: ManifestSegment[];
  concepts: { concept_id: string; name: string; definition: string; segment_ids: string[] }[];
  items: ManifestItem[];
  retrieval: { fts: "chapter_grounding.script_text" | "topic_articles.sections" | "none" };
  derived_by: { model: string | null; prompt_versions: string[]; at: string; usage?: { input_tokens: number; output_tokens: number; usd: number } };
};

// ── T1–T3: segments ─────────────────────────────────────────────────────────
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function partOf(s: ScriptFile): number {
  return typeof s.part === "number" && s.part > 0 ? s.part : 1;
}

export function videoPathFor(part: number, artifacts: ArtifactRow[], generationId: string): string | null {
  const name = part === 1 ? "lesson.mp4" : `lesson_part${part}.mp4`;
  const row = artifacts.find((a) => a.generation_id === generationId && a.kind === "video_mp4" && a.storage_path.endsWith("/" + name));
  return row ? row.storage_path : null;
}

const pointText = (p: unknown): string =>
  typeof p === "string" ? p : p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : JSON.stringify(p);

export function buildSegments(scripts: ScriptFile[], artifacts: ArtifactRow[], generationId: string): ManifestSegment[] {
  const out: ManifestSegment[] = [];
  const sorted = scripts.slice().sort((a, b) => partOf(a) - partOf(b));
  let k = 0;
  for (const sf of sorted) {
    const part = partOf(sf);
    const bySid = new Map(sf.script.segments.map((s, i) => [s.segment_id, { s, i }] as const));
    const video = videoPathFor(part, artifacts, generationId);
    let t = 0;
    for (const v of sf.video.segments) {
      const d = Number(v.clip_duration_seconds || 0);
      const hit = bySid.get(v.segment_id);
      const seg = hit ? hit.s : null;
      const assets = ((seg && seg.scene && seg.scene.elements) || [])
        .filter((e) => e && e.asset && !(e.id || "").startsWith("__"))
        .map((e) => String(e.asset));
      const sceneConcept = seg && seg.scene && typeof seg.scene.concept === "string" && seg.scene.concept.trim() ? seg.scene.concept.trim() : null;
      out.push({
        key: `p${part}:${v.segment_id}`,
        segment_id: v.segment_id,
        part,
        k: k++,
        start_s: r3(t),
        end_s: r3(t + d),
        slide_t: r3(Math.max(t, t + d - SLIDE_EPS_S)),
        slide_k: hit ? hit.i + 1 : null,
        type: (seg && seg.type) || "outro",
        heading: (seg && seg.slide_heading) || "",
        points: ((seg && seg.slide_points) || []).map(pointText),
        narration: (seg && seg.text) || "",
        concept_slug: sceneConcept,
        assets: Array.from(new Set(assets)),
        video_path: video,
        concept: { concept_id: null, secondary: [], method: "none", confidence: 0, availability: "unavailable", reason: "not yet mapped" },
        visual: { status: "unknown", show: "caption_only", reason: "not yet judged", judged_by: { model: null, prompt_version: null } },
      });
      t += d;
    }
  }
  return out;
}

// ── C1: mechanical concept matching ────────────────────────────────────────
const STOP = new Set(
  "the and for with from that this into onto their there these those what which when where how why are was were has have had its it's not but can use used using of to in on at by as is be or an a vs versus between within about part".split(" "),
);

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("es") && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function contentTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem);
}

/** Concepts whose every name word appears in `heading`. Names of ONE content
 * word ("Air", "Wind") are excluded: in M1 they matched broad headings ("What is
 * Air Made Of?" → "Air" instead of "Composition of Air"). */
export function headingMatches(heading: string, concepts: ConceptSrc[]): ConceptSrc[] {
  const h = new Set(contentTokens(heading));
  return concepts.filter((c) => {
    const n = contentTokens(c.name);
    return n.length >= 2 && n.every((w) => h.has(w));
  });
}

/** The heading rule's tokenizer, stop-words and stemmer are English-only (ASCII words).
 * Any other language — Arabic, Malay, Jawi, Chinese… — skips the heading rule and goes
 * to the model pass. Unknown language (legacy kits store none) counts as English only when
 * the heading text itself is plain ASCII. */
export function headingRuleApplies(language: string | null | undefined, heading: string): boolean {
  const lang = (language || "").trim().toLowerCase();
  if (lang) return lang === "en" || lang.startsWith("en-");
  return /^[\x00-\x7f]*$/.test(heading);
}

export function mechanicalConcept(seg: ManifestSegment, concepts: ConceptSrc[], language: string | null = "en"): ConceptLink | null {
  if (seg.concept_slug) {
    const slug = seg.concept_slug.toLowerCase();
    const c = concepts.find((x) => x.concept_id.toLowerCase() === slug || x.name.toLowerCase() === slug);
    if (c) return { concept_id: c.concept_id, secondary: [], method: "scene", confidence: 1, availability: "available" };
  }
  if (!seg.heading || !headingRuleApplies(language, seg.heading)) return null;
  const m = headingMatches(seg.heading, concepts);
  if (m.length === 1) return { concept_id: m[0].concept_id, secondary: [], method: "heading", confidence: 0.95, availability: "available" };
  return null;
}

// ── C2: model assignments ───────────────────────────────────────────────────
export type ModelAssignment = { segment: string; primary: string | null; secondary?: string[]; confidence: number; reason?: string };

export function acceptConcept(a: ModelAssignment | undefined, conceptIds: Set<string>): ConceptLink {
  if (!a) return { concept_id: null, secondary: [], method: "model", confidence: 0, availability: "unavailable", reason: "model returned no assignment" };
  const conf = Number.isFinite(a.confidence) ? a.confidence : 0;
  if (a.primary !== null && !conceptIds.has(a.primary))
    return { concept_id: null, secondary: [], method: "model", confidence: conf, availability: "unavailable", reason: `unknown concept id ${a.primary}` };
  if (conf < CONCEPT_MIN_CONFIDENCE)
    return { concept_id: null, secondary: [], method: "model", confidence: conf, availability: "unavailable", reason: `model confidence ${conf} < ${CONCEPT_MIN_CONFIDENCE}${a.reason ? ": " + a.reason : ""}` };
  const sec = (a.secondary || []).filter((x) => conceptIds.has(x) && x !== a.primary).slice(0, 2);
  return {
    concept_id: a.primary,
    secondary: sec,
    method: "model",
    confidence: conf,
    availability: "available",
    reason: a.primary === null ? `no single concept${a.reason ? ": " + a.reason : ""}` : a.reason,
  };
}

// ── I1 / I2: items ──────────────────────────────────────────────────────────
export const promptHash = (s: string) => createHash("sha256").update(s.trim()).digest("hex").slice(0, 16);

export function mechanicalItem(
  item: ItemSrc,
  kitArticleId: string | null,
  conceptIds: Set<string>,
  kitArticleSourceId: string | null = null,
): ManifestItem | null {
  if (!item.bank_item_id || !item.objective_ref || !kitArticleId) return null;
  if (item.bank_article_id !== kitArticleId) return null; // I1: older article version → objective ids differ
  // I1b: a translated item keeps the objective_ref of the item it was translated from. It is only valid
  // when that source item belongs to the article version this translation was made from.
  if (item.bank_source_article_id !== undefined && (!kitArticleSourceId || item.bank_source_article_id !== kitArticleSourceId)) return null;
  if (!conceptIds.has(item.objective_ref)) return null;
  return {
    q_id: item.q_id,
    source: item.source,
    generation_id: item.generation_id,
    type: item.type,
    prompt_hash: promptHash(item.prompt),
    concept_ids: [item.objective_ref],
    segment_ids: [],
    method: "objective_ref",
    confidence: 1,
    availability: "available",
    difficulty: item.difficulty,
    bank_item_id: item.bank_item_id,
  };
}

export type ModelItem = { q: string; concepts: string[]; segments?: string[]; confidence: number; reason?: string };

export function acceptItem(item: ItemSrc, m: ModelItem | undefined, conceptIds: Set<string>, segKeys: Set<string>): ManifestItem {
  const base = {
    q_id: item.q_id,
    source: item.source,
    generation_id: item.generation_id,
    type: item.type,
    prompt_hash: promptHash(item.prompt),
    difficulty: item.difficulty,
    bank_item_id: item.bank_item_id,
  };
  if (!m) return { ...base, concept_ids: [], segment_ids: [], method: "model", confidence: 0, availability: "unavailable", reason: "model returned no mapping" };
  const conf = Number.isFinite(m.confidence) ? m.confidence : 0;
  const bad = m.concepts.filter((c) => !conceptIds.has(c));
  const segs = (m.segments || []).filter((s) => segKeys.has(s));
  if (!m.concepts.length || bad.length)
    return { ...base, concept_ids: [], segment_ids: segs, method: "model", confidence: conf, availability: "unavailable", reason: bad.length ? `unknown concept id ${bad.join(",")}` : `no concept fits${m.reason ? ": " + m.reason : ""}` };
  if (conf < ITEM_MIN_CONFIDENCE)
    return { ...base, concept_ids: [], segment_ids: segs, method: "model", confidence: conf, availability: "unavailable", reason: `model confidence ${conf} < ${ITEM_MIN_CONFIDENCE}${m.reason ? ": " + m.reason : ""}` };
  return { ...base, concept_ids: m.concepts.slice(0, 2), segment_ids: segs, method: "model", confidence: conf, availability: "available", reason: m.reason };
}

/** For objective_ref items: the segments whose primary concept is the item's concept. */
export function segmentsForConcept(conceptId: string, segments: ManifestSegment[]): string[] {
  return segments.filter((s) => s.concept.availability === "available" && s.concept.concept_id === conceptId).map((s) => s.key);
}

// ── pinning + invalidation (§9.6) ───────────────────────────────────────────
export function artifactsHash(rows: ArtifactRow[]): string {
  const lines = rows
    .map((r) => [r.id, r.generation_id, r.kind, r.storage_path, r.created_at].join("|"))
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** True when the generation's artifacts rows no longer match what the manifest pinned. */
export function isStale(m: KitManifest, currentRows: ArtifactRow[], currentFormatVersion: number | null): boolean {
  return artifactsHash(currentRows) !== m.pinned.artifacts_hash || currentFormatVersion !== m.pinned.format_version;
}

// ── §9.1 completeness + move availability ───────────────────────────────────
export const LEGACY_BELOW_FORMAT = 3;

export function completenessOf(input: KitInput, items: ManifestItem[]) {
  const parts = input.scripts.map(partOf);
  const expected = Math.max(1, ...input.scripts.map((s) => (typeof s.of === "number" ? s.of : 1)));
  const withVideo = parts.filter((p) => input.has_video[p]).length;
  const video: "ok" | "missing" | "partial" = withVideo === 0 ? "missing" : withVideo < expected ? "partial" : "ok";
  const script: "ok" | "legacy" | "missing" =
    input.scripts.length === 0 ? "missing" : input.format_version === null || input.format_version < LEGACY_BELOW_FORMAT ? "legacy" : "ok";
  return {
    video,
    script,
    questions: (items.length ? "ok" : "none") as "ok" | "none",
    concepts: (input.concepts && input.concepts.length ? "ok" : "none") as "ok" | "none",
    format_version: input.format_version,
  };
}

export function movesOf(c: KitManifest["completeness"], segments: ManifestSegment[], items: ManifestItem[]): KitManifest["moves"] {
  const segOk: Availability = segments.length === 0 ? "unavailable" : c.video === "ok" ? "available" : "degraded";
  const mappedItems = items.filter((i) => i.availability === "available").length;
  const mappedSegs = segments.filter((s) => s.concept.availability === "available" && s.concept.concept_id).length;
  return {
    intro: segments.length ? segOk : "unavailable",
    segment: segOk,
    // a slide move is only "available" when every lesson segment may show its own frame (V1–V3)
    slide: segOk === "available" && segments.some((s) => s.slide_k !== null && s.visual.show !== "frame") ? "degraded" : segOk,
    practise: items.length ? "available" : "unavailable",
    walkthrough: items.length ? (mappedItems === items.length ? "available" : "degraded") : "unavailable",
    explain: "available", // retrieval over chapter text / article always works (§9.1)
    remediate: c.concepts === "none" || mappedItems === 0 || mappedSegs === 0 ? "unavailable" : mappedItems < items.length ? "degraded" : "available",
  };
}

// ── assembly ────────────────────────────────────────────────────────────────
export type ModelPasses = {
  concepts?: ModelAssignment[];
  items?: ModelItem[];
  model: string | null;
  usage?: { input_tokens: number; output_tokens: number; usd: number };
  concept_prompt_version?: string;
  /** Visual pass: per segment key, the measured frame metrics and the model's judgement. */
  visual?: {
    metrics: Record<string, VisualMetrics>;
    judgements: Record<string, ModelVisual>;
    model: string | null;
    prompt_version: string;
    /** pair_diff[a][b] = image difference between the slide frames of segments a and b (either order). */
    pair_diff?: Record<string, Record<string, number>>;
  };
};

export function segmentsNeedingModel(segments: ManifestSegment[], concepts: ConceptSrc[], language: string | null = "en"): ManifestSegment[] {
  return segments.filter((s) => s.slide_k !== null && !mechanicalConcept(s, concepts, language));
}

export function assemble(input: KitInput, passes: ModelPasses, at: string): KitManifest {
  const segments = buildSegments(input.scripts, input.artifacts, input.generation_id);
  const concepts = input.concepts || [];
  const ids = new Set(concepts.map((c) => c.concept_id));
  const byKey = new Map((passes.concepts || []).map((a) => [a.segment, a] as const));
  for (const s of segments) {
    if (s.slide_k === null) {
      s.concept = { concept_id: null, secondary: [], method: "none", confidence: 1, availability: "available", reason: "video-only outro" };
      continue;
    }
    if (!concepts.length) {
      s.concept = { concept_id: null, secondary: [], method: "none", confidence: 0, availability: "unavailable", reason: "no concept source for this kit" };
      continue;
    }
    s.concept = mechanicalConcept(s, concepts, input.language) || acceptConcept(byKey.get(s.key), ids);
  }
  if (passes.visual) {
    const v = passes.visual;
    for (const s of segments) {
      const metrics = v.metrics[s.key];
      const j = v.judgements[s.key];
      if (s.slide_k === null) {
        s.visual = { status: "unknown", show: "caption_only", reason: "video-only outro (not judged)", judged_by: { model: null, prompt_version: null } };
      } else {
        s.visual = decideVisual(metrics, j, { model: j ? v.model : null, prompt_version: j ? v.prompt_version : null });
      }
      if (metrics) s.visual_metrics = { ...metrics, model_confidence: j ? j.confidence : undefined };
    }
    const pd = v.pair_diff || {};
    const fd: FrameDiff = (a, b) => (pd[a] && typeof pd[a][b] === "number" ? pd[a][b] : pd[b] && typeof pd[b][a] === "number" ? pd[b][a] : null);
    resolveFallbacks(segments, fd);
  }
  const segKeys = new Set(segments.map((s) => s.key));
  const modelItems = new Map((passes.items || []).map((m) => [m.q, m] as const));
  const items: ManifestItem[] = input.items.map((it) => {
    if (!concepts.length)
      return { q_id: it.q_id, source: it.source, generation_id: it.generation_id, type: it.type, prompt_hash: promptHash(it.prompt), concept_ids: [], segment_ids: [], method: "none", confidence: 0, availability: "unavailable", reason: "no concept source for this kit" };
    const mech = mechanicalItem(it, input.article_id, ids, input.article_source_id ?? null);
    if (mech) {
      mech.segment_ids = segmentsForConcept(mech.concept_ids[0], segments);
      return mech;
    }
    return acceptItem(it, modelItems.get(it.q_id), ids, segKeys);
  });
  const conceptsOut = concepts.map((c) => ({
    ...c,
    segment_ids: segments
      .filter((s) => s.concept.availability === "available" && (s.concept.concept_id === c.concept_id || s.concept.secondary.includes(c.concept_id)))
      .map((s) => s.key),
  }));
  const parts = Array.from(new Set(input.scripts.map(partOf))).sort((a, b) => a - b);
  const byPart = input.scripts.slice().sort((a, b) => partOf(a) - partOf(b));
  const pinnedRows = input.artifacts;
  const artifacts_hash = artifactsHash(pinnedRows);
  const completeness = completenessOf(input, items);
  const prompt_versions: string[] = [];
  if (passes.concepts) prompt_versions.push(passes.concept_prompt_version || CONCEPT_PROMPT_VERSION);
  if (passes.items) prompt_versions.push(ITEM_PROMPT_VERSION);
  if (passes.visual) prompt_versions.push(passes.visual.prompt_version);
  const m: KitManifest = {
    schema: MANIFEST_SCHEMA,
    derivation_version: MANIFEST_DERIVATION_VERSION,
    manifest_id: createHash("sha256").update(`${input.generation_id}|${artifacts_hash}|${prompt_versions.join(",")}|d${MANIFEST_DERIVATION_VERSION}`).digest("hex").slice(0, 24),
    generation_id: input.generation_id,
    book_id: input.book_id,
    chapter_ref: input.chapter_ref,
    article_id: input.article_id,
    parts,
    language: input.language,
    format_version: input.format_version,
    pinned: {
      script_ids: byPart.map((s) => s.script.script_id || ""),
      video_manifest_ids: byPart.map((s) => s.video.manifest_id || ""),
      format_version: input.format_version,
      artifact_paths: pinnedRows.map((r) => r.storage_path).sort(),
      artifacts_hash,
    },
    completeness,
    moves: { intro: "unavailable", segment: "unavailable", slide: "unavailable", practise: "unavailable", walkthrough: "unavailable", explain: "available", remediate: "unavailable" },
    segments,
    concepts: conceptsOut,
    items,
    retrieval: { fts: input.concept_source === "chapter_grounding" ? "chapter_grounding.script_text" : input.concept_source === "article_objectives" ? "topic_articles.sections" : "none" },
    derived_by: { model: passes.model, prompt_versions, at, usage: passes.usage },
  };
  m.moves = movesOf(completeness, segments, items);
  return m;
}

/** Pull the first JSON object out of a model reply (tolerates prose or ``` fences around it). */
export function parseModelJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
