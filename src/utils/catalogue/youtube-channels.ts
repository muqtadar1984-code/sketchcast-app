// Which lesson languages have a YouTube channel of their OWN (2026-10-20).
//
// The worker posts a translation on its language's channel when
// YOUTUBE_REFRESH_TOKEN_<LANG> is set, and otherwise falls back to the
// English channel (catalogue/publish.py channel_for). The founder decided
// against that fallback: a translation is posted only on its own language's
// channel, and a language without one waits ("block until the channel
// exists", Translated Videos YouTube Tab plan §10 decision 4).
//
// The app cannot read the worker's environment, so "the channel exists" is
// read from what the worker's hourly stats poll writes: a
// youtube_channel_stats row for that channel_language, captured recently. A
// token that is set but whose poll keeps failing does not count — the
// channel is not known to work. Pure; the reads live in
// youtube-channels-server.ts.

import type { PublishAcceptance } from "./publish";

/** A channel counts as live while its newest snapshot is younger than this:
 *  a day of hourly polls, so one failed poll (or a redeploy) never blocks
 *  posting, and a channel whose token was removed stops counting by tomorrow. */
export const CHANNEL_FRESH_HOURS = 24;

/** The worker's poll interval when YOUTUBE_STATS_POLL_MINUTES is unset
 *  (catalogue/youtube_stats.py POLL_DEFAULT_MINUTES). */
export const POLL_DEFAULT_MINUTES = 60;

export type ChannelStatRow = { channel_language: string | null; title?: string | null; captured_at: string | null };

export type YouTubeChannel = {
  language: string;
  title: string | null;
  /** the newest snapshot of the channel — when the worker last polled it */
  lastPoll: string;
  /** polled within CHANNEL_FRESH_HOURS */
  live: boolean;
};

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** The portal is English-only (library/layout.tsx), so languages are named
 *  in English here — the registry's labels are native ("Bahasa Melayu"). */
const ENGLISH_NAME: Record<string, string> = {
  en: "English",
  ar: "Arabic",
  ms: "Malay",
  hi: "Hindi",
  te: "Telugu",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  ur: "Urdu",
  mr: "Marathi",
  "ms-arab": "Jawi",
};
export const shortLanguageName = (code: string): string => ENGLISH_NAME[code] ?? code;

/** One entry per channel the worker has polled, newest snapshot each. */
export function channelsFromStats(rows: readonly ChannelStatRow[], nowMs: number): YouTubeChannel[] {
  const newest = new Map<string, { at: string; title: string | null }>();
  for (const r of rows) {
    const lang = norm(r.channel_language);
    if (!lang || !r.captured_at) continue;
    const prior = newest.get(lang);
    if (!prior || r.captured_at > prior.at) newest.set(lang, { at: r.captured_at, title: r.title ?? prior?.title ?? null });
  }
  const freshMs = CHANNEL_FRESH_HOURS * 3600_000;
  return [...newest.entries()]
    .map(([language, v]) => ({ language, title: v.title, lastPoll: v.at, live: nowMs - Date.parse(v.at) <= freshMs }))
    .sort((a, b) => (a.language === "en" ? -1 : b.language === "en" ? 1 : a.language.localeCompare(b.language)));
}

/** The language codes that have a live channel of their own. */
export const liveChannelLanguages = (channels: readonly YouTubeChannel[]): string[] => channels.filter((c) => c.live).map((c) => c.language);

export function hasOwnChannel(language: string | null | undefined, liveLanguages: readonly string[]): boolean {
  const lang = norm(language);
  return !!lang && liveLanguages.includes(lang);
}

/** The refusal a translation without its own channel gets — the same sentence
 *  on the Post button, the publish route's 409 and the YouTube view's row. */
export function noChannelWhy(languageName: string): string {
  return `There is no ${languageName} YouTube channel yet — a translation is posted only on its own language's channel, never on the English one. Set up the ${languageName} channel (and its refresh token on the worker) first.`;
}

/** May a kit in `language` be uploaded, as far as channels go? English always
 *  has its channel; a translation needs its own. Re-wording what is already
 *  on a channel is not an upload and is never refused here. */
export function channelAccepts(language: string | null | undefined, languageName: string, liveLanguages: readonly string[]): PublishAcceptance {
  const lang = norm(language) || "en";
  if (lang === "en" || hasOwnChannel(lang, liveLanguages)) return { ok: true };
  return { ok: false, why: noChannelWhy(languageName) };
}

/** The poll interval the worker uses, read from the same variable. */
export function pollMinutes(raw: string | null | undefined = process.env.YOUTUBE_STATS_POLL_MINUTES): number {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : POLL_DEFAULT_MINUTES;
}

/** A channel's status is stale when its last poll is older than two intervals. */
export function pollIsLate(lastPoll: string | null | undefined, nowMs: number, minutes: number = POLL_DEFAULT_MINUTES): boolean {
  if (!lastPoll) return true;
  return nowMs - Date.parse(lastPoll) > 2 * minutes * 60_000;
}
