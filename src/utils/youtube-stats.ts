// The YouTube tracker — the pure half. The worker writes SNAPSHOTS (one row
// per video per poll, one per channel per poll; sketchcast-ai
// catalogue/youtube_stats.py, migration 0118); everything a person reads on
// /console/youtube is arithmetic over those rows, done here so the stored
// numbers stay exactly what YouTube said and the vitest suite can pin the
// arithmetic without a database.

export type VideoSnap = {
  video_id: string;
  captured_at: string;
  title: string | null;
  privacy: string | null;
  published_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
};

export type ChannelSnap = {
  channel_id: string;
  captured_at: string;
  title: string | null;
  subscribers: number | null;
  views: number | null;
  videos: number | null;
};

const ms = (iso: string) => new Date(iso).getTime();

/** The newest snapshot per video. */
export function latestPerVideo(snaps: VideoSnap[]): Map<string, VideoSnap> {
  const out = new Map<string, VideoSnap>();
  for (const s of snaps) {
    const cur = out.get(s.video_id);
    if (!cur || ms(s.captured_at) > ms(cur.captured_at)) out.set(s.video_id, s);
  }
  return out;
}

/** The newest snapshot taken AT OR BEFORE `at` for a video, else null. */
export function snapshotAt(snaps: VideoSnap[], videoId: string, at: Date): VideoSnap | null {
  let best: VideoSnap | null = null;
  for (const s of snaps) {
    if (s.video_id !== videoId || ms(s.captured_at) > at.getTime()) continue;
    if (!best || ms(s.captured_at) > ms(best.captured_at)) best = s;
  }
  return best;
}

/** How much a video's counters moved since `since`. When no snapshot is
 *  that old (the video is younger than the window, or polling started
 *  later), the EARLIEST snapshot stands in and `partial` says so — a number
 *  a reader can trust exactly as far as it goes. Null when there is only
 *  one snapshot, because a delta needs two. */
export function deltaSince(snaps: VideoSnap[], videoId: string, since: Date):
  { views: number; likes: number; comments: number; partial: boolean } | null {
  const mine = snaps.filter((s) => s.video_id === videoId).sort((a, b) => ms(a.captured_at) - ms(b.captured_at));
  if (mine.length < 2) return null;
  const now = mine[mine.length - 1];
  let base = snapshotAt(mine, videoId, since);
  let partial = false;
  if (!base) {
    base = mine[0];
    partial = true;
  }
  if (base === now) return null;
  const d = (a: number | null, b: number | null) => Math.max(0, (a ?? 0) - (b ?? 0));
  return { views: d(now.views, base.views), likes: d(now.likes, base.likes), comments: d(now.comments, base.comments), partial };
}

/** The last `days` UTC days, oldest first. */
function lastDays(days: number, now: Date): string[] {
  const out: string[] = [];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = days - 1; i >= 0; i--) out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Views gained per day across ALL videos, oldest first, for a sparkline.
 *  Each day's value is (the last snapshot of that day) minus (the last
 *  snapshot of the day before), per video, summed; a video with no earlier
 *  snapshot contributes nothing for that day (its first day is a partial
 *  we do not pretend to know). Days with no polls at all read 0. */
export function viewsPerDay(snaps: VideoSnap[], days: number, now: Date = new Date()): Array<{ day: string; views: number }> {
  const daysList = lastDays(days, now);
  const byVideo = new Map<string, VideoSnap[]>();
  for (const s of snaps) {
    const list = byVideo.get(s.video_id) ?? [];
    list.push(s);
    byVideo.set(s.video_id, list);
  }
  for (const list of byVideo.values()) list.sort((a, b) => ms(a.captured_at) - ms(b.captured_at));
  const totals = new Map<string, number>(daysList.map((d) => [d, 0]));
  for (const list of byVideo.values()) {
    // the last snapshot per day for this video
    const lastOfDay = new Map<string, VideoSnap>();
    for (const s of list) lastOfDay.set(s.captured_at.slice(0, 10), s);
    let prev: VideoSnap | null = null;
    // walk every day the video has snapshots on, in order, so a gap day carries the last known value
    const seenDays = [...lastOfDay.keys()].sort();
    for (const d of seenDays) {
      const cur = lastOfDay.get(d)!;
      if (prev && totals.has(d)) totals.set(d, (totals.get(d) ?? 0) + Math.max(0, (cur.views ?? 0) - (prev.views ?? 0)));
      prev = cur;
    }
  }
  return daysList.map((day) => ({ day, views: totals.get(day) ?? 0 }));
}

/** The newest channel snapshot, else null. */
export function latestChannel(snaps: ChannelSnap[]): ChannelSnap | null {
  return snaps.reduce<ChannelSnap | null>((best, s) => (!best || ms(s.captured_at) > ms(best.captured_at) ? s : best), null);
}

/** Subscribers gained since `since` (earliest snapshot stands in, flagged). */
export function channelDelta(snaps: ChannelSnap[], since: Date): { subscribers: number; views: number; partial: boolean } | null {
  const list = [...snaps].sort((a, b) => ms(a.captured_at) - ms(b.captured_at));
  if (list.length < 2) return null;
  const now = list[list.length - 1];
  let base = [...list].reverse().find((s) => ms(s.captured_at) <= since.getTime()) ?? null;
  let partial = false;
  if (!base) {
    base = list[0];
    partial = true;
  }
  if (base === now) return null;
  return { subscribers: (now.subscribers ?? 0) - (base.subscribers ?? 0), views: Math.max(0, (now.views ?? 0) - (base.views ?? 0)), partial };
}

export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}
