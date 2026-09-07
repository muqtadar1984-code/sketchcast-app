// Pure logic for PUBLISHING an approved kit to YouTube (Phase 4 of the
// topic-catalogue plan). No I/O anywhere, so the publish route, the kit panel
// and the worker share one answer and the rules are unit-tested without a
// database — the same stance as kit.ts and article.ts.
//
// Two things live here and nowhere else:
//
//   1. THE REFUSALS (canPublish). The worker re-checks every one of them
//      before its first network call (plan §1.3: enforced twice, nothing
//      auto-publishes). Spelling them once means the panel's disabled button,
//      the route's 409 and the worker's refusal say the SAME sentence, so an
//      operator never has to guess which layer stopped them.
//   2. THE DESCRIPTION (buildDescriptionPreview). The reviewer must be able to
//      read what will be posted BEFORE it is posted — a wrong curriculum code
//      or a broken timestamp list is cheap to fix now and public afterwards.
//      The worker's build_description() produces the same shape from the same
//      inputs; this is the preview of that, not a second design.
//
// Nothing here can publish anything: it decides and it formats. The upload
// itself is the worker's `topic_publish` job, and the whole path is dark
// behind FEATURE_CATALOGUE_PUBLISH until the channel exists and the YouTube
// API project has passed its compliance audit.

import { fmtTimestamp } from "./kit";
import type { BankMaturity, ChapterMark, PublishPrivacy, TopicPublication } from "./types";

// ── Privacy ──────────────────────────────────────────────────────────────────

/** youtube's own privacy statuses (0112's topic_publications check list). */
export const PRIVACY = ["private", "unlisted", "public"] as const;

export function isPrivacy(v: unknown): v is PublishPrivacy {
  return typeof v === "string" && (PRIVACY as readonly string[]).includes(v);
}

/** Uploads land private and stay private: an API project that has not passed
 *  YouTube's compliance audit CANNOT create an unlisted or public video (the
 *  API forces private), and a video whose privacy is flipped later is flipped
 *  by a deliberate human step, not by a checkbox on the queue form. Widening
 *  this list is the audit's reward, not a workaround for it. */
export const PUBLISHABLE_PRIVACY = ["private"] as const;

export const DEFAULT_PRIVACY: PublishPrivacy = "private";

export const PRIVACY_LABEL: Record<PublishPrivacy, string> = {
  private: "Private (only the channel owner)",
  unlisted: "Unlisted (anyone with the link)",
  public: "Public (listed and searchable)",
};

// ── Acceptance ───────────────────────────────────────────────────────────────

export type PublishAcceptance = { ok: true } | { ok: false; why: string };

const label = (s: string) => s.replace(/_/g, " ");

/** The privacy a publish may be queued with today. */
export function publishPrivacyAccepts(privacy: PublishPrivacy): PublishAcceptance {
  if ((PUBLISHABLE_PRIVACY as readonly string[]).includes(privacy)) return { ok: true };
  return {
    ok: false,
    why: `Uploads land private: the YouTube API project has not passed the compliance audit, so it cannot create a ${privacy} video. Publish it private, then flip the privacy once the audit is through.`,
  };
}

/** The topic statuses a publish is accepted in. `video_approved` is the state
 *  gate 2 leaves the topic in; `published` is accepted too because ONE run
 *  does not always finish a kit — the per-run upload cap
 *  (YOUTUBE_MAX_PARTS_PER_RUN, ~7 fully captioned videos a day fit the quota)
 *  can leave later parts for the next run, and finishing them must not need
 *  the topic dragged backwards. */
export const PUBLISH_TOPIC_STATUSES = ["video_approved", "published"] as const;

/**
 * May THIS kit be published right now? Four things must agree, and the WORKER
 * re-checks all four before any network call (plan §1.3):
 *   • the kit is `approved` — gate 2, a named reviewer's act;
 *   • the TOPIC is video approved (or already published, see above) — a kit
 *     whose topic went back to generating is history, not the kit to publish;
 *   • the kit's ARTICLE is still the approved version — the article is the
 *     kit's source of truth (plan §1.7), and a video built from superseded
 *     text must be regenerated, not published;
 *   • the question bank is not empty — a published video's description links
 *     to its worksheet, and a link into an empty bank damages trust with the
 *     first teacher who follows it (plan §1.7 maturity ladder).
 */
export function canPublish(
  kitStatus: string,
  topicStatus: string,
  articleStatus: string | null | undefined,
  bankMaturity: BankMaturity | string | null | undefined,
): PublishAcceptance {
  if (kitStatus !== "approved") {
    return {
      ok: false,
      why: `This kit is ${label(kitStatus)}, not approved — a video reaches YouTube only after a reviewer approves it (gate 2).`,
    };
  }
  if (!(PUBLISH_TOPIC_STATUSES as readonly string[]).includes(topicStatus)) {
    return {
      ok: false,
      why:
        topicStatus === "generating"
          ? "The topic is generating a newer kit — this one is history; publish the kit that comes out of review."
          : `The topic is ${label(topicStatus)}, not video approved — approve this kit's video first.`,
    };
  }
  if (articleStatus !== "approved") {
    return {
      ok: false,
      why: articleStatus
        ? `The article this kit was built from is ${label(articleStatus)}, not the approved version — regenerate the kit from the approved article and have it approved before publishing.`
        : "The article this kit was built from no longer exists — regenerate the kit before publishing.",
    };
  }
  if (!bankMaturity || bankMaturity === "none") {
    return {
      ok: false,
      why: "The question bank is empty — a published video links teachers to its worksheet, and a link into an empty bank is worse than no video. Fill the bank first.",
    };
  }
  return { ok: true };
}

// ── What is already on YouTube ───────────────────────────────────────────────

export type PublishAction = "publish" | "retry";

export type PublicationState = "published" | "failed" | "waiting";

export type PublicationPart = {
  part: number;
  /** the topic_publications row for this part, or null when no run reached it */
  row: TopicPublication | null;
  state: PublicationState;
};

export type PublicationSummary = {
  parts: PublicationPart[];
  /** how many parts the kit has (or how many rows exist when the plan is unknown) */
  total: number;
  published: number;
  failed: number;
  waiting: number;
  /** parts a run has already touched (a row exists), published or not */
  attempted: number;
  /** true when the number of parts is KNOWN (part_plan is written) */
  known: boolean;
  /** every known part carries a youtube_video_id */
  complete: boolean;
  label: string;
};

/** A row counts as published when it holds a video id — the id, not the
 *  status, is the fact. A caption or thumbnail failure is recorded on a row
 *  that HAS an id (the video is up; the extra failed), so `error` alone never
 *  demotes a published part. */
function stateOf(row: TopicPublication | null): PublicationState {
  if (!row) return "waiting";
  if (row.youtube_video_id) return "published";
  return row.error ? "failed" : "waiting";
}

/**
 * The per-part publication state of one kit. `parts` is how many video parts
 * the kit has (part_plan.length); 0 means UNKNOWN — the plan is not written
 * yet, or 0115 is not applied — and the summary then describes only the parts
 * that already have a row and never claims the kit is complete. Rows for a
 * part outside a known plan are still listed: the truth is what is on the
 * channel, not what the plan expected.
 */
export function publicationSummary(rows: readonly TopicPublication[], parts: number): PublicationSummary {
  const known = Number.isInteger(parts) && parts > 0;
  const byPart = new Map<number, TopicPublication>();
  for (const r of rows) {
    if (!r || !Number.isInteger(r.part)) continue;
    const prior = byPart.get(r.part);
    // one row per (kit, part, language) by construction; if two ever arrive,
    // the published one is the truth
    if (!prior || (!prior.youtube_video_id && r.youtube_video_id)) byPart.set(r.part, r);
  }
  const numbers = new Set<number>(byPart.keys());
  if (known) for (let p = 1; p <= parts; p++) numbers.add(p);
  const list: PublicationPart[] = [...numbers]
    .sort((a, b) => a - b)
    .map((part) => {
      const row = byPart.get(part) ?? null;
      return { part, row, state: stateOf(row) };
    });
  const published = list.filter((p) => p.state === "published").length;
  const failed = list.filter((p) => p.state === "failed").length;
  const waiting = list.filter((p) => p.state === "waiting").length;
  const attempted = list.filter((p) => p.row !== null).length;
  const total = list.length;
  const parts_ = [`${published}/${total} published`];
  if (failed) parts_.push(`${failed} failed`);
  if (waiting) parts_.push(`${waiting} not yet`);
  return {
    parts: list,
    total,
    published,
    failed,
    waiting,
    attempted,
    known,
    complete: known && total > 0 && published === total,
    label: total === 0 ? "nothing published yet" : parts_.join(" · "),
  };
}

/** Which button the panel offers: Retry once a run has touched a part (it
 *  finishes what the cap or a failure left), Publish before that. */
export function publishActionFor(summary: PublicationSummary): PublishAction {
  return summary.attempted > 0 ? "retry" : "publish";
}

/** May this action be queued against what is already on the channel? The job
 *  itself is idempotent (a part with a video id is skipped), so these refusals
 *  exist to stop a pointless run, not to protect the channel. */
export function canQueuePublish(action: PublishAction, summary: PublicationSummary): PublishAcceptance {
  if (summary.complete) {
    return { ok: false, why: "Every part of this kit is already on YouTube — there is nothing left to upload." };
  }
  if (action === "retry" && summary.attempted === 0) {
    return { ok: false, why: "Nothing has been uploaded for this kit yet — use Publish." };
  }
  return { ok: true };
}

// ── What will be posted ──────────────────────────────────────────────────────

/** `"<Topic>"` for a single part, `"<Topic> — Part k of N"` beyond one. The
 *  worker titles the uploads with exactly this. */
export function publishTitle(topicTitle: string, part: number, parts: number): string {
  const title = (topicTitle ?? "").trim() || "Untitled topic";
  if (!Number.isInteger(parts) || parts <= 1) return title;
  return `${title} — Part ${part} of ${parts}`;
}

/** The link every description ends with. UTM tagged so the catalogue's traffic
 *  is separable in analytics from organic arrivals (there is no other way to
 *  tell a YouTube viewer from a search visitor). */
export const SKETCHCAST_LINK = "https://sketchcast.app/?utm_source=youtube&utm_medium=video_description&utm_campaign=topic_catalogue";

/** YouTube reads a description's timestamp list as chapters ONLY when the
 *  first is 0:00 and there are at least three; a malformed list is silently
 *  ignored, which reads to a viewer as "the chapters are broken". So the block
 *  is all-or-nothing. */
export const MIN_CHAPTER_MARKS = 3;

/** The chapter lines for one part, or [] when they would not form a valid
 *  YouTube chapter list. Marks with no label are dropped first — an unlabelled
 *  chapter is worse than none — and the rule is re-applied to what is left. */
export function chapterLines(marks: readonly ChapterMark[] | null | undefined): string[] {
  const usable = (marks ?? [])
    .filter((m) => m && typeof m.t === "number" && Number.isFinite(m.t) && m.t >= 0 && (m.label ?? "").trim() !== "")
    .sort((a, b) => a.t - b.t);
  if (usable.length < MIN_CHAPTER_MARKS) return [];
  if (usable[0].t !== 0) return [];
  return usable.map((m) => `${fmtTimestamp(m.t)} ${m.label.trim()}`);
}

export type DescriptionInput = {
  topicTitle: string;
  /** topics.summary — the one-line description of what the lesson teaches */
  summary: string | null;
  /** the same lines every catalogue document's header carries (curriculumHeaderLines) */
  curriculumHeader: readonly string[];
  /** THIS part's chapter marks, seconds from the part's start */
  chapters: readonly ChapterMark[];
  part: number;
  parts: number;
};

/**
 * The description the worker will post, built from the same inputs it uses, so
 * a reviewer approves the words that go up rather than a paraphrase of them.
 * Blocks, in order, each omitted when it would be empty:
 *   1. the one-line summary
 *   2. the curriculum codes (identical to the documents' header block)
 *   3. the chapter timestamps for THIS part (all-or-nothing, see chapterLines)
 *   4. a pointer to the next part, for a multi-part kit
 *   5. the sketchcast.app link with its UTM parameters
 * Never a fabricated credit, a hashtag wall or a call to subscribe: the
 * description is for the teacher who found the video, not for the algorithm.
 */
export function buildDescriptionPreview(input: DescriptionInput): string {
  const blocks: string[] = [];
  const title = (input.topicTitle ?? "").trim() || "Untitled topic";
  const summary = (input.summary ?? "").trim();
  blocks.push(summary || `${title} — a SketchCast lesson.`);

  const header = input.curriculumHeader.map((l) => l.trim()).filter(Boolean);
  if (header.length) blocks.push(header.join("\n"));

  const chapters = chapterLines(input.chapters);
  if (chapters.length) blocks.push(chapters.join("\n"));

  if (Number.isInteger(input.parts) && input.parts > 1 && input.part < input.parts) {
    blocks.push(`Part ${input.part + 1} of ${input.parts} continues this lesson.`);
  }

  blocks.push(`Lesson plan, worksheet and question bank for this topic: ${SKETCHCAST_LINK}`);
  return blocks.join("\n\n");
}

// ── Migration + the dark note ────────────────────────────────────────────────

/** 0116: jobs_one_live_publish. */
export const CATALOGUE_PUBLISH_MIGRATION = "supabase/migrations/0116_catalogue_publish.sql";

/** Why the button is dark, in the words the route's 409 uses. Shown by the
 *  panel so nobody files a bug about a disabled button. */
export const PUBLISH_OFF_NOTE =
  "Publishing is switched off (FEATURE_CATALOGUE_PUBLISH) — the YouTube channel is not created and the API project has not passed the compliance audit yet.";
