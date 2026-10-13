// The Overview's two audience cards — YouTube and website traffic — folded
// from the SAME rows and the SAME helpers the YouTube and Traffic tabs use,
// so the one-page number can never disagree with the tab it summarises.
// Pure, so the card arithmetic is unit-tested without a database.

import { latestChannel, type ChannelSnap } from "./youtube-stats";
import { dailySeries, lifetime, sumPoints, type DailyRow } from "./cloudflare-stats";

export type OverviewAudience = {
  /** The channel's latest snapshot; null until the worker has polled once. */
  subscribers: number | null;
  /** Lifetime channel views from that same snapshot. */
  channelViews: number | null;
  /** Cloudflare's per-day unique visitors to sketchcast.app, summed over the
   * last 30 UTC days (the Traffic tab's "Last 30 days"); null with no rows. */
  visitors30: number | null;
  /** The same, over every day on record (the Traffic tab's "All time"). */
  visitorsAll: number | null;
};

export function overviewAudience(
  channelSnaps: ChannelSnap[],
  trafficRows: DailyRow[],
  now: Date = new Date(),
): OverviewAudience {
  const channel = latestChannel(channelSnaps);
  const last30 = sumPoints(dailySeries(trafficRows, 30, now));
  const all = lifetime(trafficRows);
  return {
    subscribers: channel ? channel.subscribers ?? 0 : null,
    channelViews: channel ? channel.views ?? 0 : null,
    visitors30: trafficRows.length ? last30.uniques : null,
    visitorsAll: trafficRows.length ? all.uniques : null,
  };
}
