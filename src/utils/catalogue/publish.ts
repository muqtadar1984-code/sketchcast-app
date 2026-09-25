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
//   2. THE TITLE AND THE DESCRIPTION (publishTitle, buildDescriptionPreview).
//      ONE structure for every video (founder, 2026-09-21, after hand-writing
//      three): "<Topic> Explained | <key terms> | <audience>" and a description
//      of fixed blocks — the hook paragraph, "Aligned to" + the curriculum
//      lines, "Chapters" + the timestamps, the key terms, the part pointer,
//      the SketchCast line and link, the hashtags. The WORDS (the hook, the
//      terms, the tags, the title) are written once by the worker from the
//      narration into topic_kits.youtube_meta (0121) and EDITED here before
//      Post; the composers treat a missing field as "use the default", so a
//      video is never held up by a paragraph. The worker's
//      catalogue/youtube_meta.py composes the same shape from the same inputs;
//      keep the two in step.
//
// Nothing here can publish anything: it decides and it formats. The upload
// itself is the worker's `topic_publish` job, dark behind
// FEATURE_CATALOGUE_PUBLISH until the channel exists; public and unlisted
// uploads need YOUTUBE_COMPLIANCE_AUDIT_PASSED (Google forces every upload
// from an unaudited API project private).

import { fmtTimestamp, type HeaderMapping } from "./kit";
import type { BankMaturity, ChapterMark, PublishPrivacy, TopicPublication, YouTubeMeta } from "./types";

// ── Privacy ──────────────────────────────────────────────────────────────────

/** youtube's own privacy statuses (0112's topic_publications check list). */
export const PRIVACY = ["private", "unlisted", "public"] as const;

export function isPrivacy(v: unknown): v is PublishPrivacy {
  return typeof v === "string" && (PRIVACY as readonly string[]).includes(v);
}

/** The privacies a publish may be queued with. Without the compliance audit,
 *  YouTube forces every upload from the API project private, so only
 *  `private` is honest; with it (YOUTUBE_COMPLIANCE_AUDIT_PASSED on the app
 *  AND the worker), a reviewed kit goes up public directly from the library. */
export function publishablePrivacies(auditPassed: boolean): readonly PublishPrivacy[] {
  return auditPassed ? PRIVACY : (["private"] as const);
}

/** Public once the audit is through — the library is the review, Post is the
 *  release — and private until then. */
export function defaultPrivacy(auditPassed: boolean): PublishPrivacy {
  return auditPassed ? "public" : "private";
}

/** Kept for readers of the old constant: the audit-less list. */
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

/** The privacy a publish may be queued with, given whether the audit is passed. */
export function publishPrivacyAccepts(privacy: PublishPrivacy, auditPassed = false): PublishAcceptance {
  if ((publishablePrivacies(auditPassed) as readonly string[]).includes(privacy)) return { ok: true };
  return {
    ok: false,
    why: `Uploads land private: the YouTube API project has not passed the compliance audit, so it cannot create a ${privacy} video. Publish it private and flip it in YouTube Studio, or set YOUTUBE_COMPLIANCE_AUDIT_PASSED once the audit is through.`,
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
// Mirrors sketchcast-ai catalogue/youtube_meta.py line for line: the same
// inputs compose the same title and description on both sides, so the
// reviewer approves the words that go up rather than a paraphrase.

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
export const INTRO_MAX = 700;
export const MAX_KEY_TERMS = 12;
export const MAX_HASHTAGS = 12;
const TITLE_TERMS = 3;

/** The end screen's ask, in the description too (founder direction 2026-09-25).
 *  Mirrors shared/outro.py DESCRIPTION_CTA in the worker, word for word. */
export const DESCRIPTION_CTA =
  "If this lesson helped, please like, share and comment, and subscribe — we publish new lessons regularly.";

export const SKETCHCAST_LINE =
  "This lesson was generated with SketchCast. Upload a textbook chapter and get a whiteboard video, slide deck, lesson plan, activities, worksheet, test paper and case study in one click.";

const squash = (v: unknown) => String(v ?? "").split(/\s+/).filter(Boolean).join(" ");

/** `"CBSE Class 9"` / `"Cambridge Stage 7"` / `"Ontario Grade 8"`: the board is
 *  the curriculum name's first word, the level word the board's own idiom. */
export function boardLabel(curriculumName: string | null | undefined, grade: string | null | undefined): string {
  const name = squash(curriculumName);
  if (!name) return "";
  const board = name.split(" ")[0];
  const m = /\d+/.exec(squash(grade));
  if (!m) return board;
  const level = /\b(cbse|icse|ncert|class)\b/i.test(name) ? "Class" : /\b(cambridge|stage)\b/i.test(name) ? "Stage" : "Grade";
  return `${board} ${level} ${m[0]}`;
}

/** `[curriculum name, grade]` per mapped curriculum, in mapping order. */
export function boardsOf(mappings: readonly HeaderMapping[]): Array<[string, string]> {
  const seen = new Map<string, [string, string]>();
  for (const m of mappings) {
    const name = squash(m.curriculum?.name);
    if (!name || seen.has(name)) continue;
    seen.set(name, [name, squash(m.node?.grade)]);
  }
  return [...seen.values()];
}

/** `"CBSE Class 9 & Cambridge Stage 7 Science"` — the title's last block, the
 *  one a teacher types into search. */
export function audienceTag(boards: ReadonlyArray<readonly [string, string]>, subject: string | null | undefined): string {
  const labels: string[] = [];
  for (const [name, grade] of boards) {
    const l = boardLabel(name, grade);
    if (l && !labels.includes(l)) labels.push(l);
  }
  const subj = squash(subject);
  const head = labels.join(" & ");
  return head && subj ? `${head} ${subj}` : head || subj;
}

/** The vocabulary a summary ENUMERATES: the comma list before the first dash
 *  or colon, items of at most three words. */
export function termsFromSummary(summary: string | null | undefined): string[] {
  const head = squash(summary).split(/\s+[—–-]\s+|:\s|\.\s/)[0] ?? "";
  const out: string[] = [];
  for (const piece of head.split(/,\s*|\s+and\s+|;\s*|\s+or\s+/)) {
    const t = piece.replace(/^[\s.;:]+|[\s.;:]+$/g, "").toLowerCase();
    if (!t || t.split(" ").length > 3 || out.includes(t)) continue;
    out.push(t);
  }
  return out.slice(0, MAX_KEY_TERMS);
}

export function cleanTerms(values: unknown, limit = MAX_KEY_TERMS): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(values) ? values : []) {
    const t = squash(v).replace(/^[\s.;:#]+|[\s.;:#]+$/g, "").toLowerCase();
    if (!t || t.split(" ").length > 4 || t.length > 40 || out.includes(t)) continue;
    out.push(t);
  }
  return out.slice(0, limit);
}

const camel = (text: string) => (squash(text).match(/[A-Za-z0-9]+/g) ?? []).map((w) => w[0].toUpperCase() + w.slice(1)).join("");

/** CamelCase, alphanumeric, at least one letter, no '#', distinct. */
export function cleanHashtags(values: unknown, limit = MAX_HASHTAGS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of Array.isArray(values) ? values : []) {
    const tag = camel(squash(v).replace(/^#+/, ""));
    if (!tag || tag.length > 40 || seen.has(tag.toLowerCase()) || !/[A-Za-z]/.test(tag)) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out.slice(0, limit);
}

/** Terms, then the boards, then the subject and the channel. */
export function defaultHashtags(keyTerms: readonly string[], boards: ReadonlyArray<readonly [string, string]>, subject: string | null | undefined): string[] {
  const tags: string[] = [...keyTerms.slice(0, 6)];
  const subj = camel(squash(subject) || "Science");
  for (const [name, grade] of boards) {
    const l = boardLabel(name, grade);
    if (!l) continue;
    const words = l.split(" ");
    tags.push(words[0]);
    tags.push(words.length === 3 ? `${words[1]}${words[2]}${subj}` : `${words[0]}${subj}`);
  }
  tags.push(subj, "SketchCast");
  return cleanHashtags(tags);
}

/** `"<Topic> Explained"` unless the topic already ends on a participle. */
export function headline(topicTitle: string | null | undefined): string {
  const topic = squash(topicTitle) || "Topic";
  const last = (topic.split(" ").pop() ?? "").toLowerCase();
  return last.endsWith("ed") && last.length > 4 ? topic : `${topic} Explained`;
}

const titleCase = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

export type TitleInput = {
  topicTitle: string;
  meta?: YouTubeMeta | null;
  keyTerms?: readonly string[];
  audience?: string;
  part: number;
  parts: number;
};

/**
 * `<Topic> Explained | <terms> | <audience>` (` — Part k of N` beyond one
 * part): the stored title when the library holds one, else composed; a bare
 * topic when there are neither terms nor an audience. Over 100 characters the
 * terms go first (three, two, one, none), then the audience, and the part
 * label is never cut. The worker titles the uploads with exactly this.
 */
export function composeTitle(input: TitleInput): string {
  const topic = squash(input.topicTitle) || "Topic";
  const stored = squash(input.meta?.title);
  const suffix = Number.isInteger(input.parts) && input.parts > 1 ? ` — Part ${input.part} of ${input.parts}` : "";
  const room = TITLE_MAX - suffix.length;
  let base = "";
  if (stored) {
    base = stored;
  } else {
    const terms = (input.keyTerms ?? []).filter((t) => squash(t)).slice(0, TITLE_TERMS);
    const aud = squash(input.audience);
    if (!terms.length && !aud) {
      base = topic;
    } else {
      outer: for (const withAud of [true, false]) {
        if (withAud && !aud) continue;
        for (let n = terms.length; n >= 0; n--) {
          const mid = terms.slice(0, n).map(titleCase).join(", ");
          const cand = [headline(topic), ...(mid ? [mid] : []), ...(withAud ? [aud] : [])].join(" | ");
          if (cand.length <= room) {
            base = cand;
            break outer;
          }
        }
      }
      if (!base) base = headline(topic);
    }
  }
  if (base.length > room) base = base.slice(0, room).trimEnd();
  return (base + suffix).trim();
}

/** The title as the worker posts it; `parts <= 1` is a single video. */
export function publishTitle(topicTitle: string, part: number, parts: number, opts: Omit<TitleInput, "topicTitle" | "part" | "parts"> = {}): string {
  return composeTitle({ topicTitle, part, parts, ...opts });
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
  /** topics.summary — the hook paragraph's fallback and the key terms' source */
  summary: string | null;
  /** topics.subject — the audience tag's last word and a hashtag */
  subject?: string | null;
  /** the same lines every catalogue document's header carries (curriculumHeaderLines) */
  curriculumHeader: readonly string[];
  /** the curriculum mappings, for the boards (audience tag, hashtags) */
  mappings?: readonly HeaderMapping[];
  /** topic_kits.youtube_meta — the words written by the worker / edited here */
  meta?: YouTubeMeta | null;
  /** THIS part's chapter marks, seconds from the part's start */
  chapters: readonly ChapterMark[];
  part: number;
  parts: number;
};

/** The terms the listing uses: the stored ones, else the summary's. */
export function effectiveTerms(meta: YouTubeMeta | null | undefined, summary: string | null | undefined): string[] {
  const stored = cleanTerms(meta?.key_terms);
  return stored.length ? stored : termsFromSummary(summary);
}

export function effectiveHashtags(meta: YouTubeMeta | null | undefined, keyTerms: readonly string[], boards: ReadonlyArray<readonly [string, string]>, subject: string | null | undefined): string[] {
  const stored = cleanHashtags(meta?.hashtags);
  return stored.length ? stored : defaultHashtags(keyTerms, boards, subject);
}

/**
 * The description the worker will post, block by block, each omitted when it
 * would be empty and never a fabricated one:
 *   1. the hook paragraph (youtube_meta.intro, else the summary)
 *   2. "Aligned to" + the curriculum lines (identical to the documents' header)
 *   3. "Chapters" + the timestamps for THIS part (all-or-nothing, see chapterLines)
 *   4. "Key terms:" the vocabulary
 *   5. the part pointer, for a multi-part kit
 *   6. the end screen's ask (like, share, comment, subscribe)
 *   7. the SketchCast line and the UTM-tagged link
 *   8. the hashtag line
 */
export function buildDescriptionPreview(input: DescriptionInput): string {
  const blocks: string[] = [];
  const title = squash(input.topicTitle) || "Untitled topic";
  const boards = boardsOf(input.mappings ?? []);
  const terms = effectiveTerms(input.meta, input.summary);
  const intro = squash(input.meta?.intro) || squash(input.summary) || `${title} — a SketchCast lesson.`;
  blocks.push(intro);

  const header = input.curriculumHeader.map((l) => l.trim()).filter(Boolean);
  if (header.length) blocks.push(["Aligned to", ...header].join("\n"));

  const chapters = chapterLines(input.chapters);
  if (chapters.length) blocks.push(["Chapters", ...chapters].join("\n"));

  if (terms.length) blocks.push(`Key terms: ${terms.join(", ")}.`);

  if (Number.isInteger(input.parts) && input.parts > 1) {
    const line = `Part ${input.part} of ${input.parts}.`;
    const next =
      input.part < input.parts
        ? publishTitle(title, input.part + 1, input.parts, { meta: input.meta, keyTerms: terms, audience: audienceTag(boards, input.subject) })
        : null;
    blocks.push(next ? `${line} Next: ${next}` : line);
  }

  blocks.push(DESCRIPTION_CTA);
  blocks.push(`${SKETCHCAST_LINE}\n${SKETCHCAST_LINK}`);

  const tags = effectiveHashtags(input.meta, terms, boards, input.subject);
  if (tags.length) blocks.push(tags.map((t) => `#${t}`).join(" "));

  const text = blocks.join("\n\n");
  if (text.length <= DESCRIPTION_MAX) return text;
  const cut = text.slice(0, DESCRIPTION_MAX);
  return cut.includes("\n") ? cut.slice(0, cut.lastIndexOf("\n")).trimEnd() : cut.trimEnd();
}

// ── The editable words ───────────────────────────────────────────────────────

export type YouTubeMetaEdit = { title: string; intro: string; key_terms: string[]; hashtags: string[] };
export type YouTubeMetaValidation = { ok: true; meta: YouTubeMetaEdit } | { ok: false; errors: string[] };

/** A comma- or newline-separated field as a list. */
export function splitList(raw: unknown): string[] {
  return String(raw ?? "")
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The publish block's edit, validated for the kit route: a blank field means
 * "use the default" (it is stored blank and the composers fall back), a title
 * over 100 characters, an intro over 700, or a term/tag that is not one are
 * refused with a sentence each. `key_terms` / `hashtags` accept a list or a
 * comma-separated string.
 */
export function validateYouTubeMeta(body: unknown): YouTubeMetaValidation {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const title = squash(b.title);
  if (title.length > TITLE_MAX) errors.push(`The title is ${title.length} characters; YouTube allows ${TITLE_MAX}.`);
  const intro = String(b.intro ?? "").replace(/\s+/g, " ").trim();
  if (intro.length > INTRO_MAX) errors.push(`The intro is ${intro.length} characters; keep it under ${INTRO_MAX}.`);
  const rawTerms = Array.isArray(b.key_terms) ? b.key_terms : splitList(b.key_terms);
  const badTerms = rawTerms.filter((t) => cleanTerms([t]).length === 0);
  if (badTerms.length) errors.push(`Not a key term (one to four words, at most 40 characters): ${badTerms.map((t) => JSON.stringify(String(t))).join(", ")}.`);
  const rawTags = Array.isArray(b.hashtags) ? b.hashtags : splitList(b.hashtags);
  const badTags = rawTags.filter((t) => cleanHashtags([t]).length === 0);
  if (badTags.length) errors.push(`Not a hashtag (letters and digits, up to 40 characters): ${badTags.map((t) => JSON.stringify(String(t))).join(", ")}.`);
  const terms = cleanTerms(rawTerms);
  const tags = cleanHashtags(rawTags);
  if (errors.length) return { ok: false, errors };
  return { ok: true, meta: { title, intro, key_terms: terms, hashtags: tags } };
}

// ── Migration + the dark note ────────────────────────────────────────────────

/** 0116: jobs_one_live_publish. */
export const CATALOGUE_PUBLISH_MIGRATION = "supabase/migrations/0116_catalogue_publish.sql";

/** 0121: topic_kits.youtube_meta and the thumbnail_png artifact kind. */
export const YOUTUBE_META_MIGRATION = "supabase/migrations/0121_youtube_meta_and_thumbnails.sql";

/** Why the button is dark, in the words the route's 409 uses. Shown by the
 *  panel so nobody files a bug about a disabled button. */
export const PUBLISH_OFF_NOTE =
  "Publishing is switched off (FEATURE_CATALOGUE_PUBLISH) — the YouTube channel is not created and the API project has not passed the compliance audit yet.";

/** Shown while the audit is not passed: why Post cannot go public yet. */
export const AUDIT_NOTE =
  "YouTube forces every upload from an API project that has not passed its compliance audit to private, so Post uploads private and you flip it public in YouTube Studio. Once Google confirms the audit, set YOUTUBE_COMPLIANCE_AUDIT_PASSED on the app and the worker and Post goes up public directly.";
