// Kit Manifest → what the Board consumes (S1 slice A). Pure.
//
// The Board controller (src/app/present/board-controller.ts) plays ONE video
// part and indexes its segments 0..n-1 within that part; the KitManifest
// indexes segments kit-wide (`k`) across parts. toBoardManifest slices one
// part and re-bases `visual.fallback_k` to that part's indices — a fallback
// frame that lives in ANOTHER part cannot be shown by seeking this video, so
// the segment degrades to caption_only rather than pointing at a frame that
// does not exist in the loaded video. Every other `visual.show` is preserved.

import type { BoardManifest, ManifestSegment as BoardSegment } from "@/app/present/board-controller";
import type { KitManifest, ManifestItem, ManifestSegment } from "./derive";

export type PartBoardManifest = BoardManifest & {
  generation_id: string;
  part: number;
  /** storage path of this part's mp4, or null when the kit has no video for it. */
  video_path: string | null;
  /** keys of the segments in this part, index-aligned with `segments`. */
  keys: string[];
};

export function partsOf(m: KitManifest): number[] {
  return m.parts && m.parts.length ? m.parts.slice().sort((a, b) => a - b) : Array.from(new Set(m.segments.map((s) => s.part))).sort((a, b) => a - b);
}

export function segmentsOfPart(m: KitManifest, part: number): ManifestSegment[] {
  return m.segments.filter((s) => s.part === part).sort((a, b) => a.k - b.k);
}

export function toBoardManifest(m: KitManifest, part?: number): PartBoardManifest {
  const p = part ?? partsOf(m)[0] ?? 1;
  const segs = segmentsOfPart(m, p);
  const indexOfK = new Map(segs.map((s, i) => [s.k, i] as const));
  const segments: BoardSegment[] = segs.map((s) => {
    const v = s.visual;
    let visual: BoardSegment["visual"];
    if (v.show === "fallback_frame") {
      const local = typeof v.fallback_k === "number" ? indexOfK.get(v.fallback_k) : undefined;
      visual =
        local === undefined
          ? { status: v.status, show: "caption_only", reason: `${v.reason}; fallback frame is in another video part` }
          : { status: v.status, show: "fallback_frame", fallback_k: local, reason: v.reason };
    } else {
      visual = { status: v.status, show: v.show, reason: v.reason };
    }
    return { start_s: s.start_s, end_s: s.end_s, slide_t: s.slide_t, heading: s.heading, points: s.points, visual };
  });
  return { generation_id: m.generation_id, part: p, video_path: segs[0]?.video_path ?? null, keys: segs.map((s) => s.key), segments };
}

const norm = (s: string) => s.trim().toLowerCase();

/** The first lesson segment (kit order) whose primary concept is `conceptIdOrName`
 * (an id, or a concept name case-insensitively). Only AVAILABLE links count (§9.6:
 * uncertain mappings are never used for targeting). */
export function segmentForConcept(m: KitManifest, conceptIdOrName: string): ManifestSegment | null {
  const want = norm(conceptIdOrName);
  if (!want) return null;
  const c = m.concepts.find((x) => norm(x.concept_id) === want) ?? m.concepts.find((x) => norm(x.name) === want);
  const id = c ? c.concept_id : conceptIdOrName;
  const hits = m.segments.filter((s) => s.concept.availability === "available" && s.concept.concept_id === id).sort((a, b) => a.k - b.k);
  if (hits.length) return hits[0];
  // Secondary links as a last resort, still only on available segments.
  const sec = m.segments.filter((s) => s.concept.availability === "available" && s.concept.secondary.includes(id)).sort((a, b) => a.k - b.k);
  return sec[0] ?? null;
}

/** Items that teach/assess what `segmentKeyOrId` teaches. Accepts a full key
 * ("p1:s003") or a bare segment id ("s003", any part). Only available items. */
export function itemsForSegment(m: KitManifest, segmentKeyOrId: string): ManifestItem[] {
  const want = segmentKeyOrId.trim();
  if (!want) return [];
  const keys = new Set(
    want.includes(":") ? [want] : m.segments.filter((s) => s.segment_id === want).map((s) => s.key),
  );
  if (!keys.size) return [];
  return m.items.filter((i) => i.availability === "available" && i.segment_ids.some((k) => keys.has(k)));
}

/** Kit-wide `k` → the part it is in and its index within that part. */
export function segmentIndexFor(m: KitManifest, k: number): { part: number; index: number; key: string } | null {
  const s = m.segments.find((x) => x.k === k);
  if (!s) return null;
  const index = segmentsOfPart(m, s.part).findIndex((x) => x.k === k);
  return index < 0 ? null : { part: s.part, index, key: s.key };
}

export function segmentByKey(m: KitManifest, key: string): ManifestSegment | null {
  return m.segments.find((s) => s.key === key) ?? null;
}
