import { InkUnderline } from "@/components/ink-mark";
import Sparkline from "@/components/sparkline";
import { createAdminClient } from "@/utils/supabase/admin";
import { compact } from "@/utils/traffic";
import {
  channelDelta, deltaSince, latestChannel, latestPerVideo, viewsPerDay, youtubeUrl,
  type ChannelSnap, type VideoSnap,
} from "@/utils/youtube-stats";

export const dynamic = "force-dynamic";

// The YouTube tracker. Reads the snapshots the worker writes (migration
// 0118; sketchcast-ai catalogue/youtube_stats.py polls hourly) and does the
// arithmetic in utils/youtube-stats.ts. Nothing here calls YouTube: every
// credential lives in the worker, and a page that could not load would
// otherwise take the whole console down with it.

const SNAPSHOT_DAYS = 45; // enough for a 30-day sparkline with a day of slack

type PubRow = { topic_kit_id: string; part: number; youtube_video_id: string | null; privacy: string; published_at: string | null; topic_kits: { topic_id: string; topics: { title: string } | null } | null };

const th = "px-5 py-2 text-xs text-[#5B6470] font-medium";
const td = "px-5 py-2.5 text-sm";
const grid = "grid grid-cols-[2.6fr_0.8fr_0.9fr_0.8fr_0.7fr_0.7fr_0.7fr_0.7fr] gap-2 min-w-[900px] items-center";

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function ago(iso: string, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export default async function ConsoleYouTubePage() {
  const admin = createAdminClient();
  const now = new Date();
  const since = new Date(now.getTime() - SNAPSHOT_DAYS * 86_400_000).toISOString();
  const [snapsQ, chanQ, pubsQ] = await Promise.all([
    admin.from("youtube_video_stats").select("video_id, captured_at, title, privacy, published_at, views, likes, comments")
      .gte("captured_at", since).order("captured_at", { ascending: true }).limit(20_000),
    admin.from("youtube_channel_stats").select("channel_id, captured_at, title, subscribers, views, videos")
      .gte("captured_at", since).order("captured_at", { ascending: true }).limit(2_000),
    admin.from("topic_publications").select("topic_kit_id, part, youtube_video_id, privacy, published_at, topic_kits(topic_id, topics(title))")
      .not("youtube_video_id", "is", null).order("published_at", { ascending: false }).limit(500),
  ]);

  const snaps = (snapsQ.data ?? []) as VideoSnap[];
  const chans = (chanQ.data ?? []) as ChannelSnap[];
  const pubs = (pubsQ.data ?? []) as unknown as PubRow[];
  const tablesMissing = snapsQ.error?.code === "42P01" || chanQ.error?.code === "42P01";

  const latest = latestPerVideo(snaps);
  const channel = latestChannel(chans);
  const day = new Date(now.getTime() - 86_400_000);
  const week = new Date(now.getTime() - 7 * 86_400_000);
  const month = new Date(now.getTime() - 30 * 86_400_000);
  const perDay = viewsPerDay(snaps, 30, now);
  const views7 = perDay.slice(-7).reduce((a, p) => a + p.views, 0);
  const views30 = perDay.reduce((a, p) => a + p.views, 0);
  const subs7 = channelDelta(chans, week);
  const lastPoll = [...snaps, ...chans].reduce<string | null>((b, s) => (!b || s.captured_at > b ? s.captured_at : b), null);
  const live = pubs.filter((p) => (latest.get(p.youtube_video_id ?? "")?.privacy ?? p.privacy) === "public").length;

  const tiles: Array<{ label: string; value: string; hint?: string }> = [
    { label: "Subscribers", value: channel ? compact(channel.subscribers ?? 0) : "—",
      hint: subs7 ? `${subs7.subscribers >= 0 ? "+" : ""}${subs7.subscribers} in 7 days${subs7.partial ? " (partial)" : ""}` : undefined },
    { label: "Channel views, lifetime", value: channel ? compact(channel.views ?? 0) : "—",
      hint: channel?.title ? channel.title : undefined },
    { label: "Views, last 7 days", value: snaps.length ? compact(views7) : "—", hint: `${compact(views30)} in 30 days` },
    { label: "Videos published", value: String(pubs.length), hint: `${live} public · ${pubs.length - live} private or unlisted` },
  ];

  const rows = pubs.map((p) => {
    const vid = p.youtube_video_id ?? "";
    const s = latest.get(vid) ?? null;
    return {
      vid,
      topic: p.topic_kits?.topics?.title ?? "(topic)",
      part: p.part,
      title: s?.title ?? null,
      privacy: s?.privacy ?? p.privacy,
      published: s?.published_at ?? p.published_at,
      views: s?.views ?? null,
      likes: s?.likes ?? null,
      comments: s?.comments ?? null,
      d1: deltaSince(snaps, vid, day),
      d7: deltaSince(snaps, vid, week),
      d30: deltaSince(snaps, vid, month),
    };
  }).sort((a, b) => (b.views ?? -1) - (a.views ?? -1));

  const chip = (privacy: string) =>
    privacy === "public"
      ? "chip bg-[#E2F4F1] text-[#0C8175] normal-case tracking-normal"
      : "chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal";

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">YouTube</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-xs text-[#98A0A9] mb-7">
        {lastPoll ? `Snapshots from the worker, hourly. Last poll ${ago(lastPoll, now)}.` : "No snapshots yet — the worker polls hourly once the channel credentials are set (YOUTUBE_STATS_POLL_MINUTES)."}
      </p>

      {tablesMissing && (
        <div className="card px-5 py-4 mb-8 text-sm text-[#8A6100]">
          The statistics tables are not in this database yet — apply migration 0118.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {tiles.map((m) => (
          <div key={m.label} className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
            <div className="text-xs text-[#5B6470]">{m.label}</div>
            <div className="text-2xl tabular mt-0.5">{m.value}</div>
            {m.hint && <div className="text-[11px] text-[#98A0A9] mt-0.5">{m.hint}</div>}
          </div>
        ))}
      </div>

      <section className="mb-10">
        <div className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3 flex items-center gap-5">
          <div>
            <div className="text-xs text-[#5B6470]">Views per day, last 30 days</div>
            <div className="text-[11px] text-[#98A0A9] mt-0.5">Across every published video. A video&apos;s first polled day is not counted.</div>
          </div>
          <Sparkline values={perDay.map((p) => p.views)} width={420} height={48} className="w-full max-w-[420px] h-12" title="Views per day, last 30 days" />
          <div className="text-sm tabular text-[#5B6470] whitespace-nowrap">today {perDay[perDay.length - 1]?.views ?? 0}</div>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-xl mb-3">Videos</h2>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className={`${grid} ${th}`}>
            <span>Video</span><span>Status</span><span>Published</span><span className="text-end">Views</span>
            <span className="text-end">24 h</span><span className="text-end">7 d</span><span className="text-end">Likes</span><span className="text-end">Comments</span>
          </div>
          {rows.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No videos published yet.</div>}
          {rows.map((r) => (
            <div key={`${r.vid}-${r.part}`} className={grid}>
              <span className={`${td} min-w-0`}>
                <a href={youtubeUrl(r.vid)} target="_blank" rel="noreferrer" className="font-medium text-[#0C8175] hover:underline block truncate">
                  {r.title ?? r.topic}
                </a>
                <span className="block text-[11px] text-[#98A0A9] truncate">{r.topic}{r.part > 1 ? ` · Part ${r.part}` : ""} · {r.vid}</span>
              </span>
              <span className={td}><span className={chip(r.privacy)}>{r.privacy}</span></span>
              <span className={`${td} tabular`}>{fmtDate(r.published)}</span>
              <span className={`${td} tabular text-end`}>{r.views ?? "—"}</span>
              <span className={`${td} tabular text-end`}>{r.d1 ? `+${r.d1.views}${r.d1.partial ? "*" : ""}` : "—"}</span>
              <span className={`${td} tabular text-end`}>{r.d7 ? `+${r.d7.views}${r.d7.partial ? "*" : ""}` : "—"}</span>
              <span className={`${td} tabular text-end`}>{r.likes ?? "—"}</span>
              <span className={`${td} tabular text-end`}>{r.comments ?? "—"}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-[#98A0A9] mt-2">
          Views, likes and comments are YouTube&apos;s own counts at the last poll. The 24 h and 7 d columns are the change between two polls; an asterisk means the earlier poll is younger than the window, so the figure is a lower bound. Watch time and retention need the Analytics API scope the channel has not consented to yet.
        </p>
      </section>
    </main>
  );
}
