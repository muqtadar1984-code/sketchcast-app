import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CHANNEL_FRESH_HOURS, channelsFromStats, type ChannelStatRow, type YouTubeChannel } from "./youtube-channels";

// The read behind youtube-channels.ts: the worker's channel snapshots of the
// last two days (two channels × hourly ≈ 100 rows), service role only —
// youtube_channel_stats has RLS on and no policies. Callers authenticate
// first (requireLibraryMember / isLibraryMemberRequest).

export type ChannelsLoad = { ok: true; channels: YouTubeChannel[] } | { ok: false; error: string };

export async function loadYouTubeChannels(admin: SupabaseClient, nowMs: number = Date.now()): Promise<ChannelsLoad> {
  const since = new Date(nowMs - 2 * CHANNEL_FRESH_HOURS * 3600_000).toISOString();
  const { data, error } = await admin
    .from("youtube_channel_stats")
    .select("channel_language, title, captured_at")
    .gte("captured_at", since)
    .order("captured_at", { ascending: false })
    .limit(2000);
  if (error) return { ok: false, error: error.message ?? "could not read the YouTube channels" };
  return { ok: true, channels: channelsFromStats((data ?? []) as ChannelStatRow[], nowMs) };
}
