import "server-only";
import { readChunks, type Admin } from "@/app/api/library/lib";
import { catalogueColumnMissing } from "@/utils/catalogue/status";
import type { SweepCurrentKit } from "@/utils/catalogue/translate-sweep";
import { loadYouTubeChannels } from "@/utils/catalogue/youtube-channels-server";
import { pollMinutes } from "@/utils/catalogue/youtube-channels";
import type { VideoInput, VideoJob, VideoKit, VideoPublication, VideoStat, VideoTopic } from "@/utils/catalogue/youtube-videos";

// The YouTube view's reads (/library/translations/youtube). Read-only, service
// role — every table here has RLS on and no policies — so the page calls
// requireLibraryMember() first. Two waves:
//
//   catalogue_current_kits()  the current kit per (topic, language)
//   topics                    titles, subjects, status, bank maturity
//   topic_kits                every TRANSLATION (translation_status set)
//   youtube_channel_stats     the channels the worker polled in two days
//   jobs                      live topic_publish jobs
// then
//   topic_publications        those kits' rows, chunked by kit id
//   youtube_video_stats       only each channel's NEWEST poll (≤ one row per
//                             video) — never the hourly history, which grows
//                             by ~one row per video per hour.

const KIT_COLUMNS = "id, topic_id, language, status, translation_status, created_at";
const PUBLICATION_COLUMNS = "topic_kit_id, part, channel_language, youtube_video_id, privacy, thumbnail_set, published_at, error";
const STATUS_COLUMNS_0148 = "youtube_publish_at, youtube_upload_status, youtube_missing_since";

export type VideosLoad = { ok: true; input: VideoInput } | { ok: false; error: string };

export async function loadTranslatedVideos(admin: Admin, nowMs: number = Date.now()): Promise<VideosLoad> {
  const fail = (e: { message?: string } | string | null) => ({ ok: false as const, error: typeof e === "string" ? e : (e?.message ?? "unknown database error") });

  const kitsRead = async () => {
    // part_plan (0115) read with the kit; a database without it still lists
    const withPlan = await admin.from("topic_kits").select(`${KIT_COLUMNS}, part_plan`).not("translation_status", "is", null);
    if (withPlan.error && catalogueColumnMissing(withPlan.error) && /part_plan/i.test(withPlan.error.message ?? "")) {
      return admin.from("topic_kits").select(KIT_COLUMNS).not("translation_status", "is", null);
    }
    return withPlan;
  };

  const [currentQ, topicsQ, kitsQ, channelsQ, jobsQ] = await Promise.all([
    admin.rpc("catalogue_current_kits"),
    admin.from("topics").select("id, title, subject, status, bank_maturity"),
    kitsRead(),
    loadYouTubeChannels(admin, nowMs),
    admin.from("jobs").select("id, status, params").eq("type", "topic_publish").in("status", ["queued", "processing"]),
  ]);
  if (currentQ.error) return fail(currentQ.error);
  if (topicsQ.error) return fail(topicsQ.error);
  if (kitsQ.error) {
    return fail(catalogueColumnMissing(kitsQ.error) ? "The translation columns are not in this database yet (migration 0134)." : kitsQ.error);
  }
  if (!channelsQ.ok) return fail(channelsQ.error);
  if (jobsQ.error) return fail(jobsQ.error);

  const kits = (kitsQ.data ?? []) as VideoKit[];
  const readPublications = (columns: string) =>
    readChunks<VideoPublication>(
      kits.map((k) => k.id),
      (chunk) => admin.from("topic_publications").select(columns).in("topic_kit_id", chunk),
    );
  // 0148's status columns (scheduled / rejected / removed, written by the
  // worker's poll); without them removal is inferred from the newest poll
  let publications = await readPublications(`${PUBLICATION_COLUMNS}, superseded_by, ${STATUS_COLUMNS_0148}`);
  if (publications.error && catalogueColumnMissing(publications.error)) {
    publications = await readPublications(`${PUBLICATION_COLUMNS}, superseded_by`);
  }
  if (publications.error) return fail(publications.error);

  // Each channel's newest poll writes every row with the same captured_at, so
  // reading from the OLDEST channel's newest poll onward is at most one poll
  // of each channel plus a few newer rows of the others.
  let stats: VideoStat[] = [];
  const polls = channelsQ.channels.map((c) => c.lastPoll).sort();
  if (polls.length) {
    const statsQ = await admin.from("youtube_video_stats").select("video_id, channel_language, captured_at, privacy, views").gte("captured_at", polls[0]).limit(10000);
    if (statsQ.error) return fail(statsQ.error);
    stats = (statsQ.data ?? []) as VideoStat[];
  }

  return {
    ok: true,
    input: {
      current: (currentQ.data ?? []) as SweepCurrentKit[],
      topics: (topicsQ.data ?? []) as VideoTopic[],
      kits,
      publications: publications.rows,
      stats,
      channels: channelsQ.channels,
      jobs: (jobsQ.data ?? []) as VideoJob[],
      nowMs,
      pollMinutes: pollMinutes(),
    },
  };
}
