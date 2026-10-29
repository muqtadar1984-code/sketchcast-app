// SK S3 slice B — the Kit Manifest as the student player sees it. Pure.
//
// What leaves the server: each section's times, heading, points and the
// visual verdict (caption_only passed through untouched), and a COUNT of its
// practice items. Never the narration (the explain turn reads it server-side)
// and never an item's answer.

import type { KitManifest, ManifestSegment } from "./manifest/derive";
import { itemsForSegment } from "./manifest/board";
import type { KitListEntry, KitSegmentView, KitView } from "./kit-player";
import type { ProductKit } from "./product-kits";

/** Practice items the student path can serve: mapped to the section, available,
 *  and traced to a bank row (topic_questions) the bank can mark. Book-path
 *  worksheet items with no bank trace are left out until slice C's ladder
 *  reads the worksheet file. Bank ids, in the manifest's order, each once. */
export function practiseItemIds(m: KitManifest, segmentKey: string): string[] {
  const out: string[] = [];
  for (const i of itemsForSegment(m, segmentKey)) {
    if (i.bank_item_id && !out.includes(i.bank_item_id)) out.push(i.bank_item_id);
  }
  return out;
}

/** Every bank id mapped to ANY section of the kit (the answer route checks an
 *  item belongs to the kit before marking it). */
export function kitItemIds(m: KitManifest): Set<string> {
  return new Set(m.items.filter((i) => i.availability === "available" && i.bank_item_id).map((i) => i.bank_item_id as string));
}

function visualOf(s: ManifestSegment): KitSegmentView["visual"] {
  const v = s.visual;
  if (v?.show === "frame") return { kind: "frame", caption_only: false };
  if (v?.show === "fallback_frame" && typeof v.fallback_k === "number") return { kind: "fallback_frame", caption_only: false, fallback: v.fallback_k };
  // caption_only, a fallback without a target, or no verdict at all: the card.
  return { kind: "caption_only", caption_only: true };
}

export function kitSegments(m: KitManifest): KitSegmentView[] {
  return m.segments
    .slice()
    .sort((a, b) => a.k - b.k)
    .map((s) => ({
      index: s.k,
      key: s.key,
      part: s.part,
      start: s.start_s,
      end: s.end_s,
      slide_t: s.slide_t,
      heading: s.heading ?? "",
      points: (s.points ?? []).filter((p): p is string => typeof p === "string" && !!p.trim()),
      visual: visualOf(s),
      practise: practiseItemIds(m, s.key).length,
    }));
}

export function kitList(kits: readonly ProductKit[]): KitListEntry[] {
  return kits.map((k) => ({ generationId: k.generationId, label: k.label, title: k.title }));
}

export function kitView(m: KitManifest, kit: ProductKit, videos: { part: number; url: string }[]): KitView {
  return {
    generationId: kit.generationId,
    title: kit.title,
    chapterRef: kit.chapterRef,
    language: m.language,
    videoUrl: videos.find((v) => v.part === 1)?.url ?? videos[0]?.url ?? null,
    videos,
    segments: kitSegments(m),
  };
}
