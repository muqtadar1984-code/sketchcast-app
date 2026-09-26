// The video FORMAT VERSION on the portal side: which published videos were
// rendered by an older generation of the pipeline than the one the worker
// runs now, and which older video a re-rendered kit may supersede.
//
// Nothing here decides anything. A YouTube video's file cannot be replaced,
// so re-rendering a published lesson means a new upload and the founder
// choosing, video by video, whether the change is worth resetting its
// counters (2026-09-26: "leave it for me to decide when and which"). The
// portal's job is to make the facts impossible to miss — on the dashboard,
// in the topic list and on the topic — and to offer the one manual step,
// Supersede, which the worker's topic_supersede job carries out.

import type { TopicPublication, VideoFormatSetting } from "./types";

/** platform_settings.video_format as the worker wrote it, or null when the
 *  row is missing or malformed (the portal then shows no format facts). */
export function parseVideoFormat(value: unknown): VideoFormatSetting | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const version = Number(v.version);
  if (!Number.isInteger(version) || version < 1) return null;
  const changes: Record<string, string> = {};
  if (v.changes && typeof v.changes === "object") {
    for (const [k, line] of Object.entries(v.changes as Record<string, unknown>)) if (typeof line === "string") changes[k] = line;
  }
  return { version, changes, recorded_at: typeof v.recorded_at === "string" ? v.recorded_at : null };
}

/** A row posted before the stamp existed is, by definition, the oldest format. */
export function formatVersionOf(row: Pick<TopicPublication, "format_version">): number {
  const v = row.format_version;
  return Number.isInteger(v) && (v as number) >= 1 ? (v as number) : 1;
}

/** Live on the channel: it has a video id and nothing has superseded it. */
export function isLivePublication(row: TopicPublication): boolean {
  return !!row.youtube_video_id && !row.superseded_by;
}

/** Live AND rendered by an older format than the worker runs now. */
export function isOutdatedPublication(row: TopicPublication, current: number): boolean {
  return isLivePublication(row) && formatVersionOf(row) < current;
}

export function outdatedPublications<T extends TopicPublication>(rows: readonly T[], current: number): T[] {
  return rows.filter((r) => isOutdatedPublication(r, current));
}

/** "format v1 · current v2" for the chip beside a published part; "format
 *  v2" when it is current; null when the worker has not recorded a format. */
export function formatLabel(row: TopicPublication, current: number | null): string | null {
  if (!row.youtube_video_id) return null;
  const v = formatVersionOf(row);
  if (current === null) return `format v${v}`;
  return v < current ? `format v${v} · current v${current}` : `format v${v}`;
}

/** The changelog lines for every version AFTER `from` up to `current` — what
 *  a viewer of the old video is missing. */
export function changesSince(setting: VideoFormatSetting, from: number): string[] {
  const out: string[] = [];
  for (let v = from + 1; v <= setting.version; v++) {
    const line = setting.changes[String(v)];
    if (line) out.push(`v${v}: ${line}`);
  }
  return out;
}

export type SupersedeCandidate = {
  part: number;
  /** the older video: another kit's live publication of the same part */
  old: TopicPublication;
  /** this kit's publication of that part */
  replacement: TopicPublication;
};

/** For each part THIS kit has posted, the older live videos of the same part
 *  (and channel) posted by the topic's other kits — the ones Supersede may
 *  point at this kit's video. Refuses nothing itself: the route and the
 *  worker re-check the pair (worker catalogue/supersede.py check_pair). */
export function supersedeCandidates(mine: readonly TopicPublication[], others: readonly TopicPublication[], kitId: string): SupersedeCandidate[] {
  const out: SupersedeCandidate[] = [];
  for (const replacement of mine) {
    if (replacement.topic_kit_id !== kitId || !replacement.youtube_video_id) continue;
    for (const old of others) {
      if (old.topic_kit_id === kitId) continue;
      if (old.part !== replacement.part || old.channel_language !== replacement.channel_language) continue;
      if (!isLivePublication(old) || old.youtube_video_id === replacement.youtube_video_id) continue;
      out.push({ part: replacement.part, old, replacement });
    }
  }
  return out.sort((a, b) => a.part - b.part || (a.old.published_at ?? "").localeCompare(b.old.published_at ?? ""));
}

export type SupersedeAcceptance = { ok: true } | { ok: false; why: string };

/** The pair the route accepts — the same sentences the worker's check_pair
 *  answers with, so a refusal reads the same on both sides. */
export function canQueueSupersede(old: TopicPublication | null, replacement: TopicPublication | null): SupersedeAcceptance {
  if (!old) return { ok: false, why: "The older publication no longer exists." };
  if (!replacement) return { ok: false, why: "This kit has not posted that part yet — post it first." };
  if (old.id === replacement.id) return { ok: false, why: "A publication cannot supersede itself." };
  if (!old.youtube_video_id) return { ok: false, why: "The older publication has no YouTube video to point away from." };
  if (!replacement.youtube_video_id) return { ok: false, why: "The newer publication has no YouTube video yet — post it first." };
  if (old.youtube_video_id === replacement.youtube_video_id) return { ok: false, why: "Both publications are the same YouTube video." };
  if (old.part !== replacement.part) return { ok: false, why: `The parts differ (old part ${old.part}, new part ${replacement.part}).` };
  if (old.channel_language !== replacement.channel_language) return { ok: false, why: "The two videos are on different channels." };
  if (old.superseded_by && old.superseded_by !== replacement.id) return { ok: false, why: "The older video was already superseded by another publication." };
  if (old.superseded_by === replacement.id) return { ok: false, why: "The older video already points at this one." };
  return { ok: true };
}
