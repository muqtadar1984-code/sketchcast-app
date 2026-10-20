// The Translations tab's YouTube view (/library/translations/youtube,
// 2026-10-20): every translated video and where it stands on YouTube, in one
// list. The founder's ask: "all the translated videos with youtube posting
// status in 1 place categorized as posted, not posted, public/private."
// Plan: Edtech/SketchCast Feature Plan - Translated Videos YouTube Tab.md.
//
// Pure, like translation-matrix.ts: the page reads the rows (./load.ts),
// this module decides. ONE ROW PER TRANSLATED KIT — the posting unit: one
// topic_publish job uploads every part of a kit — with its parts inside.
//
// Which kits are rows:
//   • a CURRENT approved translation (catalogue_current_kits);
//   • a translation in review — "awaiting approval", never selectable;
//   • any other translation that still has a video on YouTube (a stale or
//     superseded kit) — flagged "superseded".
//   Rejected, failed, generating and staged translations are not rows (no
//   video a reviewer passed), and English kits are not (translated only —
//   founder, decision 2).
//
// A row's state, first rule that applies wins:
//   1. posting      a topic_publish job for the kit is queued or processing;
//   2. removed      a posted part's video was missing from its channel's
//                   newest poll, while that poll is on time and ran after the
//                   upload — YouTube no longer lists it;
//   3. partial      some parts are on YouTube, some not;
//   4. public / unlisted / private — every part is up; the LEAST public part
//                   names the row (topic_publications.privacy is the live
//                   privacy: the hourly poll copies YouTube's back onto it);
//   5. post_failed  a part's last upload failed (error, no video id);
//   6. awaiting_approval  the translation is in review;
//   7. no_channel   approved, nothing posted, and the language has no channel
//                   of its own — posting is blocked (decision 4);
//   8. ready        approved, nothing posted, its channel exists.
// A scheduled video reads "private" (YouTube says private until it goes
// out) until Y2 stores publishAt.
//
// selectableForPost() is the ONE rule bulk posting (plan-yt-bulk-post) uses
// to decide which rows get a checkbox. It must not be copied.

import { PUBLISH_TOPIC_STATUSES, canQueuePublish, publicationSummary, publishActionFor, type PublishAcceptance, type PublicationSummary } from "./publish";
import { inboxHref } from "./review-queue";
import { TRANSLATION_ORDER } from "./translation-matrix";
import type { SweepCurrentKit } from "./translate-sweep";
import type { TopicPublication } from "./types";
import { channelAccepts, hasOwnChannel, pollIsLate, POLL_DEFAULT_MINUTES, shortLanguageName, type YouTubeChannel } from "./youtube-channels";

export { shortLanguageName };

// ── input ────────────────────────────────────────────────────────────────────

export type VideoTopic = { id: string; title: string; subject: string | null; status: string; bank_maturity: string | null };

export type VideoKit = {
  id: string;
  topic_id: string;
  language: string;
  status: string;
  translation_status: string | null;
  created_at: string;
  /** 0115; absent or [] when the part count is unknown */
  part_plan?: unknown[] | null;
};

export type VideoPublication = Pick<TopicPublication, "topic_kit_id" | "part" | "channel_language" | "youtube_video_id" | "privacy" | "thumbnail_set" | "published_at" | "error"> & {
  superseded_by?: string | null;
};

/** One youtube_video_stats row — the loader passes only each channel's
 *  NEWEST poll, so "absent" means "YouTube did not list it last time". */
export type VideoStat = { video_id: string; channel_language: string; captured_at: string; privacy?: string | null; views?: number | null };

export type VideoJob = { id: string; status: string; params: Record<string, unknown> | null };

export type VideoInput = {
  current: readonly SweepCurrentKit[];
  topics: readonly VideoTopic[];
  kits: readonly VideoKit[];
  publications: readonly VideoPublication[];
  stats: readonly VideoStat[];
  channels: readonly YouTubeChannel[];
  /** live topic_publish jobs (queued / processing) */
  jobs: readonly VideoJob[];
  nowMs: number;
  pollMinutes?: number;
};

// ── output ───────────────────────────────────────────────────────────────────

export type VideoState = "posting" | "removed" | "partial" | "public" | "unlisted" | "private" | "post_failed" | "awaiting_approval" | "no_channel" | "ready";
export type VideoCategory = "posted" | "not_posted";

export type VideoPart = {
  part: number;
  videoId: string | null;
  privacy: string | null;
  channelLanguage: string | null;
  /** when the newest poll of its channel saw it; null = never seen */
  checkedAt: string | null;
  views: number | null;
  /** missing from its channel's newest (on-time) poll */
  missing: boolean;
  error: string | null;
  thumbnailSet: boolean | null;
  publishedAt: string | null;
};

export type VideoFlag = "thumbnail_missing" | "status_stale" | "superseded" | "posted_with_notes";

export type VideoRow = {
  kitId: string;
  topicId: string;
  title: string;
  subject: string | null;
  language: string;
  languageName: string;
  kitStatus: string;
  translationStatus: string | null;
  /** the current kit of its (topic, language) */
  current: boolean;
  state: VideoState;
  category: VideoCategory;
  parts: VideoPart[];
  /** where the video IS (posted) or WOULD go (not posted): the language's own channel */
  channel: { language: string; exists: boolean; lastPoll: string | null };
  liveJob: { id: string; status: string } | null;
  flags: VideoFlag[];
  /** the selection rule (selectableForPost) */
  postable: PublishAcceptance;
  inboxHref: string;
};

export const STATE_LABEL: Record<VideoState, string> = {
  posting: "Posting…",
  removed: "Removed on YouTube?",
  partial: "Partly posted",
  public: "Public",
  unlisted: "Unlisted",
  private: "Private",
  post_failed: "Post failed",
  awaiting_approval: "Awaiting approval",
  no_channel: "No channel yet",
  ready: "Ready to post",
};

export const FLAG_LABEL: Record<VideoFlag, string> = {
  thumbnail_missing: "no thumbnail",
  status_stale: "status may be old",
  superseded: "superseded",
  posted_with_notes: "posted with notes",
};

const POSTED: ReadonlySet<VideoState> = new Set(["removed", "partial", "public", "unlisted", "private"]);
export const categoryOf = (state: VideoState): VideoCategory => (POSTED.has(state) ? "posted" : "not_posted");

/** The states the Attention chip collects: something a person should look at. */
export const ATTENTION: ReadonlySet<VideoState> = new Set(["removed", "partial", "post_failed", "no_channel"]);
export const needsAttention = (r: Pick<VideoRow, "state" | "flags">): boolean => ATTENTION.has(r.state) || r.flags.includes("thumbnail_missing") || r.flags.includes("status_stale");

const PRIVACY_RANK: Record<string, number> = { private: 0, unlisted: 1, public: 2 };

const LIVE_JOB = new Set(["queued", "processing"]);
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();


function isRowKit(k: VideoKit, current: boolean, hasVideo: boolean): boolean {
  if (norm(k.language) === "en" || !k.translation_status) return false;
  if (hasVideo) return true;
  if (k.status === "in_review" && k.translation_status === "in_review") return true;
  return current && k.status === "approved" && k.translation_status === "approved";
}

/**
 * The selection rule for bulk posting, and the reason a row cannot be posted.
 * Mirrors the publish route's refusals in its order as far as the rows allow
 * (the route re-checks the article itself): an approved translation of the
 * current kit, a topic that may publish, a non-empty bank, its own channel,
 * no live job, something left to upload.
 */
export function selectableForPost(
  row: Pick<VideoRow, "kitStatus" | "translationStatus" | "current" | "language" | "languageName" | "liveJob">,
  ctx: { topicStatus: string; bankMaturity: string | null; summary: PublicationSummary; liveChannels: readonly string[] },
): PublishAcceptance {
  if (row.kitStatus !== "approved" || row.translationStatus !== "approved") {
    return { ok: false, why: "Only an approved translation can be posted — approve it in the review inbox first." };
  }
  if (!row.current) return { ok: false, why: "A newer translation of this topic replaced this kit — post the current one." };
  if (!(PUBLISH_TOPIC_STATUSES as readonly string[]).includes(ctx.topicStatus)) {
    return { ok: false, why: "The topic is not video approved — its English kit must be approved first." };
  }
  if (!ctx.bankMaturity || ctx.bankMaturity === "none") return { ok: false, why: "The question bank is empty — fill it before posting." };
  const channel = channelAccepts(row.language, row.languageName, ctx.liveChannels);
  if (!channel.ok) return channel;
  if (row.liveJob) return { ok: false, why: `A post is already ${row.liveJob.status} for this kit.` };
  return canQueuePublish(publishActionFor(ctx.summary), ctx.summary);
}

/** Every translated video row, in the translator's language order, then
 *  subject, then title. */
export function buildVideoRows(input: VideoInput): VideoRow[] {
  const minutes = input.pollMinutes ?? POLL_DEFAULT_MINUTES;
  const topics = new Map(input.topics.map((t) => [t.id, t]));
  const currentIds = new Set(input.current.map((c) => c.topic_kit_id));
  const liveChannels = input.channels.filter((c) => c.live).map((c) => c.language);
  const channelPoll = new Map(input.channels.map((c) => [c.language, c.lastPoll]));
  const pubsByKit = new Map<string, VideoPublication[]>();
  for (const p of input.publications) (pubsByKit.get(p.topic_kit_id) ?? pubsByKit.set(p.topic_kit_id, []).get(p.topic_kit_id)!).push(p);
  const seen = new Map<string, VideoStat>();
  for (const s of input.stats) {
    const key = `${norm(s.channel_language)}|${s.video_id}`;
    const prior = seen.get(key);
    if (!prior || s.captured_at > prior.captured_at) seen.set(key, s);
  }
  const jobByKit = new Map<string, VideoJob>();
  for (const j of input.jobs) {
    const kitId = j.params?.kit_id;
    // a re-word rewrites the words of parts already up; it uploads nothing
    if (j.params?.action === "rewords") continue;
    if (typeof kitId === "string" && LIVE_JOB.has(j.status) && !jobByKit.has(kitId)) jobByKit.set(kitId, j);
  }

  const rows: VideoRow[] = [];
  for (const k of input.kits) {
    const topic = topics.get(k.topic_id);
    if (!topic) continue;
    const pubs = pubsByKit.get(k.id) ?? [];
    const hasVideo = pubs.some((p) => !!p.youtube_video_id);
    const current = currentIds.has(k.id);
    if (!isRowKit(k, current, hasVideo)) continue;
    if (topic.status === "retired" && !hasVideo) continue;

    const language = norm(k.language);
    const languageName = shortLanguageName(language);
    const planLength = Array.isArray(k.part_plan) ? k.part_plan.length : 0;
    const summary = publicationSummary(pubs as unknown as TopicPublication[], planLength);

    const parts: VideoPart[] = summary.parts.map(({ part, row }) => {
      const pub = row as unknown as VideoPublication | null;
      const ch = norm(pub?.channel_language) || language;
      const vid = pub?.youtube_video_id ?? null;
      const stat = vid ? seen.get(`${ch}|${vid}`) : undefined;
      const lastPoll = channelPoll.get(ch) ?? null;
      const onTime = !pollIsLate(lastPoll, input.nowMs, minutes);
      // missing = the channel's newest poll ran on time, AFTER the upload, and did not list it
      const uploadedBeforePoll = !!lastPoll && (!pub?.published_at || pub.published_at < lastPoll);
      const missing = !!vid && onTime && uploadedBeforePoll && (!stat || stat.captured_at < lastPoll!);
      return {
        part,
        videoId: vid,
        privacy: pub?.privacy ?? null,
        channelLanguage: pub?.channel_language ?? null,
        checkedAt: stat?.captured_at ?? null,
        views: stat?.views ?? null,
        missing,
        error: pub?.error ?? null,
        thumbnailSet: pub ? pub.thumbnail_set : null,
        publishedAt: pub?.published_at ?? null,
      };
    });

    const posted = parts.filter((p) => p.videoId);
    const liveJob = jobByKit.get(k.id) ?? null;
    const awaiting = k.status === "in_review" && k.translation_status === "in_review";
    const own = hasOwnChannel(language, liveChannels);
    let state: VideoState;
    if (liveJob) state = "posting";
    else if (posted.some((p) => p.missing)) state = "removed";
    else if (posted.length > 0 && posted.length < parts.length) state = "partial";
    else if (posted.length > 0) {
      const least = posted.reduce((m, p) => Math.min(m, PRIVACY_RANK[norm(p.privacy)] ?? 0), 2);
      state = least === 2 ? "public" : least === 1 ? "unlisted" : "private";
    } else if (summary.failed > 0) state = "post_failed";
    else if (awaiting) state = "awaiting_approval";
    else if (!own) state = "no_channel";
    else state = "ready";

    const postedChannel = norm(posted[0]?.channelLanguage);
    const channelLanguage = postedChannel || language;
    const lastPoll = channelPoll.get(channelLanguage) ?? null;
    const flags: VideoFlag[] = [];
    if (posted.some((p) => p.thumbnailSet === false)) flags.push("thumbnail_missing");
    if (posted.length > 0 && pollIsLate(lastPoll, input.nowMs, minutes)) flags.push("status_stale");
    // an in-review kit is not current yet by design — "superseded" is for a
    // passed-over approved kit, or a publication the worker replaced
    if ((!current && !awaiting) || pubs.some((p) => p.superseded_by)) flags.push("superseded");
    if (posted.some((p) => p.error)) flags.push("posted_with_notes");

    const base = {
      kitStatus: k.status,
      translationStatus: k.translation_status,
      current,
      language,
      languageName,
      liveJob: liveJob ? { id: liveJob.id, status: liveJob.status } : null,
    };
    rows.push({
      ...base,
      kitId: k.id,
      topicId: k.topic_id,
      title: topic.title,
      subject: topic.subject,
      state,
      category: categoryOf(state),
      parts,
      channel: { language: channelLanguage, exists: channelLanguage === language ? own : hasOwnChannel(channelLanguage, liveChannels), lastPoll },
      flags,
      postable: selectableForPost(base, { topicStatus: topic.status, bankMaturity: topic.bank_maturity, summary, liveChannels }),
      inboxHref: inboxHref(k.topic_id, { lang: language }),
    });
  }

  const order = (l: string) => {
    const i = TRANSLATION_ORDER.indexOf(l);
    return i < 0 ? TRANSLATION_ORDER.length : i;
  };
  return rows.sort((a, b) => order(a.language) - order(b.language) || (a.subject ?? "").localeCompare(b.subject ?? "") || a.title.localeCompare(b.title));
}

// ── filters and totals ───────────────────────────────────────────────────────

export const VIEWS = ["all", "posted", "public", "unlisted", "private", "not_posted", "ready", "posting", "failed", "awaiting", "attention"] as const;
export type VideoView = (typeof VIEWS)[number];

export const VIEW_LABEL: Record<VideoView, string> = {
  all: "All",
  posted: "Posted",
  public: "Public",
  unlisted: "Unlisted",
  private: "Private",
  not_posted: "Not posted",
  ready: "Ready",
  posting: "Posting",
  failed: "Failed",
  awaiting: "Awaiting approval",
  attention: "Attention",
};

export type VideoFilters = { view: VideoView; lang: string; subject: string; q: string };

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();

export function parseVideoFilters(sp: Record<string, string | string[] | undefined> | null | undefined, languages: readonly string[]): VideoFilters {
  const view = first(sp?.view) as VideoView;
  const lang = first(sp?.lang).toLowerCase();
  return {
    view: (VIEWS as readonly string[]).includes(view) ? view : "all",
    lang: languages.includes(lang) ? lang : "",
    subject: first(sp?.subject).slice(0, 80),
    q: first(sp?.q).slice(0, 80),
  };
}

export function videoFiltersHref(f: Partial<VideoFilters>): string {
  const p = new URLSearchParams();
  if (f.view && f.view !== "all") p.set("view", f.view);
  if (f.lang) p.set("lang", f.lang);
  if (f.subject) p.set("subject", f.subject);
  if (f.q) p.set("q", f.q);
  const qs = p.toString();
  return `/library/translations/youtube${qs ? `?${qs}` : ""}`;
}

export function inView(r: VideoRow, view: VideoView): boolean {
  switch (view) {
    case "all":
      return true;
    case "posted":
    case "not_posted":
      return r.category === view;
    case "public":
    case "unlisted":
    case "private":
    case "ready":
    case "posting":
      return r.state === view;
    case "failed":
      return r.state === "post_failed";
    case "awaiting":
      return r.state === "awaiting_approval";
    case "attention":
      return needsAttention(r);
  }
}

/** Subject, language and the find box — everything but the category, so the
 *  chips can count what each category would show. */
export function scopeRows(rows: readonly VideoRow[], f: Pick<VideoFilters, "lang" | "subject" | "q">): VideoRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => (!f.lang || r.language === f.lang) && (!f.subject || (r.subject ?? "") === f.subject) && (!q || r.title.toLowerCase().includes(q)));
}

export const filterVideoRows = (rows: readonly VideoRow[], f: VideoFilters): VideoRow[] => scopeRows(rows, f).filter((r) => inView(r, f.view));

export const viewCounts = (rows: readonly VideoRow[]): Record<VideoView, number> =>
  Object.fromEntries(VIEWS.map((v) => [v, rows.filter((r) => inView(r, v)).length])) as Record<VideoView, number>;

export type LanguageVideoTotals = {
  language: string;
  name: string;
  total: number;
  posted: number;
  public: number;
  unlisted: number;
  private: number;
  notPosted: number;
  ready: number;
  awaiting: number;
  attention: number;
  channel: boolean;
};

/** One line per language that has rows, in the translator's order. */
export function videoTotals(rows: readonly VideoRow[], channels: readonly YouTubeChannel[]): LanguageVideoTotals[] {
  const live = channels.filter((c) => c.live).map((c) => c.language);
  const langs = [...new Set(rows.map((r) => r.language))];
  const order = (l: string) => {
    const i = TRANSLATION_ORDER.indexOf(l);
    return i < 0 ? TRANSLATION_ORDER.length : i;
  };
  return langs
    .sort((a, b) => order(a) - order(b))
    .map((language) => {
      const rs = rows.filter((r) => r.language === language);
      const count = (s: VideoState) => rs.filter((r) => r.state === s).length;
      return {
        language,
        name: shortLanguageName(language),
        total: rs.length,
        posted: rs.filter((r) => r.category === "posted").length,
        public: count("public"),
        unlisted: count("unlisted"),
        private: count("private"),
        notPosted: rs.filter((r) => r.category === "not_posted").length,
        ready: count("ready"),
        awaiting: count("awaiting_approval"),
        attention: rs.filter(needsAttention).length,
        channel: hasOwnChannel(language, live),
      };
    });
}
