import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogueMissing } from "./status";
import { isOutdatedPublication, parseVideoFormat } from "./format";
import type { TopicPublication, VideoFormatSetting } from "./types";

// Server-side reads for the video-format facts (0122). Every reader degrades
// to "unknown" when the table or the columns are not applied yet: a portal
// page must never fail over a notice.

export const PUBLICATION_COLUMNS_0122 = ", format_version, superseded_by, superseded_at";

export async function loadVideoFormat(admin: SupabaseClient): Promise<VideoFormatSetting | null> {
  const { data, error } = await admin.from("platform_settings").select("value").eq("key", "video_format").maybeSingle();
  if (error || !data) return null;
  return parseVideoFormat((data as { value: unknown }).value);
}

export type OutdatedVideo = {
  publication: TopicPublication;
  topicId: string;
  topicTitle: string;
  kitId: string;
};

type LiveRow = TopicPublication & { topic_kits: { id: string; topic_id: string; topics: { id: string; title: string } | null } | null };

/** Every live publication rendered by an older format than `current`, with
 *  its topic — the dashboard's list. Empty when the format is unknown. */
export async function loadOutdatedVideos(admin: SupabaseClient, current: number | null): Promise<{ rows: OutdatedVideo[]; error: string | null }> {
  if (current === null) return { rows: [], error: null };
  const { data, error } = await admin
    .from("topic_publications")
    .select("*, topic_kits!inner(id, topic_id, topics(id, title))")
    .not("youtube_video_id", "is", null)
    .is("superseded_by", null)
    .or(`format_version.is.null,format_version.lt.${current}`)
    .order("published_at", { ascending: true })
    .limit(500);
  if (error) return { rows: [], error: catalogueMissing(error) ? null : (error.message ?? "unknown error") };
  const rows: OutdatedVideo[] = [];
  for (const r of (data ?? []) as unknown as LiveRow[]) {
    if (!isOutdatedPublication(r, current) || !r.topic_kits) continue;
    rows.push({ publication: r, topicId: r.topic_kits.topic_id, kitId: r.topic_kits.id, topicTitle: r.topic_kits.topics?.title ?? "(untitled topic)" });
  }
  return { rows, error: null };
}

/** The topic ids (of the given ones) that have at least one outdated live
 *  video — the topic list's chip. */
export async function outdatedTopicIds(admin: SupabaseClient, topicIds: readonly string[], current: number | null): Promise<Set<string>> {
  const out = new Set<string>();
  if (current === null || topicIds.length === 0) return out;
  const { data, error } = await admin
    .from("topic_publications")
    .select("id, part, channel_language, youtube_video_id, format_version, superseded_by, topic_kits!inner(topic_id)")
    .in("topic_kits.topic_id", [...topicIds])
    .not("youtube_video_id", "is", null)
    .is("superseded_by", null);
  if (error) return out;
  for (const r of (data ?? []) as unknown as (TopicPublication & { topic_kits: { topic_id: string } | null })[]) {
    if (r.topic_kits && isOutdatedPublication(r, current)) out.add(r.topic_kits.topic_id);
  }
  return out;
}
