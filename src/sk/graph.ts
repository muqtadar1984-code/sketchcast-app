// SK B4 — teaching-graph access (contracts §3.1). Parsing is strict: a graph
// is data from a file (later a database row), so unit keys, prerequisites and
// asset ids are checked before any planner reads them.

import type { AssetKind, Cursor, GraphAsset, GraphUnit, TeachingGraph } from "./types";

export class GraphError extends Error {}

const KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KINDS = new Set<AssetKind>(["explain", "alt", "example", "demo", "misconception", "practice", "check"]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new GraphError(`${what}: expected a non-empty string`);
  return v;
};
const optStr = (v: unknown, what: string): string | undefined => (v == null ? undefined : str(v, what));

/** `clips: { female: "…clip.mp4", male: "…clip-male.mp4" }` on an asset — the
 * same clip with the other narration voice; keys are genders, values paths. */
function clipsOf(v: unknown, assetId: string, uri: (s: string | undefined) => string | undefined): GraphAsset["clips"] {
  if (v == null) return undefined;
  if (!isObj(v)) throw new GraphError(`asset ${assetId}.clips: not a map`);
  const out: NonNullable<GraphAsset["clips"]> = {};
  for (const [g, p] of Object.entries(v)) {
    if (g !== "female" && g !== "male") throw new GraphError(`asset ${assetId}.clips: bad gender ${g}`);
    out[g] = uri(str(p, `asset ${assetId}.clips.${g}`));
  }
  return Object.keys(out).length ? out : undefined;
}

/** `baseUri` (e.g. "/sk-s1/ch02/") resolves the B3 packager's relative segment
 * paths ("s1/explain-main/segment.json") to the URL the browser fetches. */
export function parseGraph(raw: unknown, baseUri = ""): TeachingGraph {
  if (!isObj(raw)) throw new GraphError("graph: not an object");
  const base = baseUri && !baseUri.endsWith("/") ? baseUri + "/" : baseUri;
  const uri = (v: string | undefined) => (v == null || /^(\/|https?:)/.test(v) ? v : base + v);
  const units = raw.units;
  if (!Array.isArray(units) || !units.length) throw new GraphError("graph: no units");
  const seenUnits = new Set<string>();
  const seenAssets = new Set<string>();
  const parsed: GraphUnit[] = units.map((u, i) => {
    if (!isObj(u)) throw new GraphError(`unit[${i}]: not an object`);
    const unit_key = str(u.unit_key, `unit[${i}].unit_key`);
    if (!KEY_RE.test(unit_key)) throw new GraphError(`unit ${unit_key}: bad key`);
    if (seenUnits.has(unit_key)) throw new GraphError(`unit ${unit_key}: duplicate`);
    seenUnits.add(unit_key);
    const assets = Array.isArray(u.assets) ? u.assets : [];
    const parsedAssets: GraphAsset[] = assets.map((a, j) => {
      if (!isObj(a)) throw new GraphError(`unit ${unit_key}.assets[${j}]: not an object`);
      const asset_id = str(a.asset_id, `unit ${unit_key}.assets[${j}].asset_id`);
      if (seenAssets.has(asset_id)) throw new GraphError(`asset ${asset_id}: duplicate`);
      seenAssets.add(asset_id);
      const kind = str(a.kind, `asset ${asset_id}.kind`) as AssetKind;
      if (!KINDS.has(kind)) throw new GraphError(`asset ${asset_id}: unknown kind ${kind}`);
      const item_ids = a.item_ids == null ? undefined : (a.item_ids as unknown[]).map((x, k) => str(x, `asset ${asset_id}.item_ids[${k}]`));
      if ((kind === "practice" || kind === "check") && !item_ids?.length) throw new GraphError(`asset ${asset_id}: ${kind} needs item_ids`);
      const origin = a.origin == null ? "prepared" : a.origin;
      if (origin !== "prepared" && origin !== "generated") throw new GraphError(`asset ${asset_id}: bad origin`);
      const validation = a.validation == null ? undefined : a.validation;
      if (validation != null && validation !== "pass" && validation !== "fail" && validation !== "pending") throw new GraphError(`asset ${asset_id}: bad validation`);
      return {
        asset_id,
        kind,
        style: optStr(a.style, `asset ${asset_id}.style`),
        segment: uri(optStr(a.segment, `asset ${asset_id}.segment`)),
        // B3 manifests name the segment by the asset id; the fixture spells it out.
        segment_id: optStr(a.segment_id, `asset ${asset_id}.segment_id`) ?? asset_id,
        clip: uri(optStr(a.clip, `asset ${asset_id}.clip`)),
        hitmap: uri(optStr(a.hitmap, `asset ${asset_id}.hitmap`)),
        clips: clipsOf(a.clips, asset_id, uri),
        item_ids,
        origin,
        validation: validation as GraphAsset["validation"],
        misconception_ref: optStr(a.misconception_ref, `asset ${asset_id}.misconception_ref`),
      };
    });
    const order = typeof u.order === "number" && Number.isFinite(u.order) ? u.order : i + 1;
    // Figures: ids ("light_microscope") or the packager's { ref, asset_key }.
    const figures = Array.isArray(u.figures)
      ? u.figures.map((f, k) => (isObj(f) ? str(f.asset_key ?? f.ref, `unit ${unit_key}.figures[${k}]`) : str(f, `unit ${unit_key}.figures[${k}]`)))
      : [];
    return {
      unit_key,
      // B1 assigns teaching objectives; until a unit has one, it keys on its own
      // graph position so mastery still works (plan §10: unmapped units teach).
      teaching_objective_id: optStr(u.teaching_objective_id, `unit ${unit_key}.teaching_objective_id`) ?? `to:${String(raw.graph_id)}/${unit_key}`,
      title: str(u.title, `unit ${unit_key}.title`),
      prereqs: Array.isArray(u.prereqs) ? u.prereqs.map((p, k) => str(p, `unit ${unit_key}.prereqs[${k}]`)) : [],
      order,
      assets: parsedAssets,
      figures,
    };
  });
  for (const u of parsed) for (const p of u.prereqs) if (!seenUnits.has(p)) throw new GraphError(`unit ${u.unit_key}: unknown prereq ${p}`);
  parsed.sort((a, b) => a.order - b.order);
  const status = raw.status ?? "draft";
  if (status !== "draft" && status !== "validated" && status !== "live" && status !== "retired") throw new GraphError("graph: bad status");
  const version = typeof raw.version === "number" ? raw.version : Number(raw.version);
  // sk_sessions.graph_version is CHECK (>= 1) (migration 0157): a graph the store
  // cannot record is refused here, at load, not at the student's first Play.
  if (!Number.isInteger(version) || version < 1) throw new GraphError("graph: bad version (must be an integer >= 1)");
  const chapter = typeof raw.chapter === "number" ? raw.chapter : Number(raw.chapter);
  // sk_sessions.chapter, sk_book_units.chapter and teaching_objectives.chapter
  // are all CHECK (>= 1) (0156/0157): a chapter-0 graph would open and then
  // fail at the first save, exactly as version 0 did — refuse it at load.
  if (!Number.isInteger(chapter) || chapter < 1) throw new GraphError("graph: bad chapter (must be an integer >= 1, as sk_sessions.chapter requires)");
  return {
    graph_id: str(raw.graph_id, "graph_id"),
    product_id: str(raw.product_id ?? raw.product, "product_id"),
    chapter,
    version,
    language: str(raw.language ?? "en", "language"),
    status,
    units: parsed,
  };
}

export const unitOf = (g: TeachingGraph, key: string): GraphUnit | undefined => g.units.find((u) => u.unit_key === key);

export function assetOf(g: TeachingGraph, assetId: string): { unit: GraphUnit; asset: GraphAsset } | undefined {
  for (const unit of g.units) {
    const asset = unit.assets.find((a) => a.asset_id === assetId);
    if (asset) return { unit, asset };
  }
  return undefined;
}

/** A unit's primary teaching asset: explain/main, else the first segment-bearing asset. */
export function mainAsset(unit: GraphUnit): GraphAsset | undefined {
  return unit.assets.find((a) => a.kind === "explain" && (a.style ?? "main") === "main") ?? unit.assets.find((a) => a.segment);
}

export function cursorFor(g: TeachingGraph, unit: GraphUnit, asset: GraphAsset, t = 0): Cursor {
  return { graphVersion: g.version, unitKey: unit.unit_key, assetId: asset.asset_id, segmentId: asset.segment_id ?? asset.asset_id, t };
}

/** Where a brand-new session starts: the first unit's main asset. */
export function startCursor(g: TeachingGraph): Cursor {
  const unit = g.units[0]!;
  const asset = mainAsset(unit) ?? unit.assets[0];
  if (!asset) throw new GraphError(`unit ${unit.unit_key}: no assets`);
  return cursorFor(g, unit, asset);
}

/** Resolve a student's wording to a unit key: "u4", "unit 4", "4", or a title fragment. */
export function resolveUnitKey(g: TeachingGraph, text: string): string | undefined {
  const s = text.trim().toLowerCase();
  if (!s) return undefined;
  const exact = g.units.find((u) => u.unit_key.toLowerCase() === s);
  if (exact) return exact.unit_key;
  const m = /^(?:unit\s*|u\s*|section\s*)?(\d{1,2})$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    // "unit 3" → the key that ends in 3 (u3, s3), whatever the packager's prefix.
    const byKey = g.units.find((u) => new RegExp(`^[a-z]+0*${n}$`, "i").test(u.unit_key));
    if (byKey) return byKey.unit_key;
    const byOrder = g.units.find((u) => u.order === n);
    if (byOrder) return byOrder.unit_key;
  }
  const byTitle = g.units.filter((u) => u.title.toLowerCase().includes(s) || s.includes(u.title.toLowerCase()));
  return byTitle.length === 1 ? byTitle[0]!.unit_key : undefined;
}
