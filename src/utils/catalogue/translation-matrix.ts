// The Translations tab (/library/translations, 2026-10-18): every topic
// against every lesson language, one cell per (topic, language) saying where
// that translation stands. The founder's ask: "it's going to be a hassle to
// track which one was done and which was not and which language was missed."
//
// Pure, like translate-sweep.ts: the page reads the rows (the sweep's reads,
// widened to every topic and every language), this module decides. The
// readiness of a cell with nothing in it comes from readyForTranslation(), so
// the matrix and the sweep drawer never disagree about why a kit is held back.
//
// A translation cell, first rule that applies wins:
//   1. a live kit_translate job for the pair — processing reads "translating",
//      queued reads "queued" (a live job beats any kit, failed or not);
//   2. a LIVE translation kit (translationIsLive: generating / staged /
//      in review / approved) — generating or staged → translating, in review →
//      in review, approved → approved, or "posted" once a publication of that
//      kit carries a YouTube video id;
//   3. the newest attempt failed — a kit_translate job in error newer than the
//      newest kit of the pair → failed, with the job's error as the detail;
//   4. the newest (not live) kit — stale / blocked as the translation column
//      says, a failed or rejected kit → failed;
//   5. nothing at all — "not started" when the sweep would take it, else
//      "not ready" with the sweep's reason.

import { LANGUAGES } from "@/utils/narration";
import { inboxHref } from "./review-queue";
import { readyForTranslation, translationIsLive, type SweepInput, type SweepKit, type SweepNotReady } from "./translate-sweep";

export type MatrixJob = {
  status: string;
  params: Record<string, unknown> | null;
  error?: string | null;
  created_at?: string | null;
};

/** The sweep's input, widened: every topic, every kit of every topic in every
 *  language, the publications of all those kits, and every kit_translate job
 *  (live and finished — a finished error is what a failed cell shows). */
export type MatrixInput = Omit<SweepInput, "jobs"> & { jobs: readonly MatrixJob[] };

export type CellState = "none" | "not_ready" | "queued" | "translating" | "in_review" | "approved" | "posted" | "stale" | "blocked" | "failed";

export type MatrixCell = {
  language: string;
  state: CellState;
  label: string;
  /** the hover text: the readiness reason, the job error, … */
  detail: string | null;
  kitId: string | null;
  href: string;
};

export type MatrixRow = {
  topicId: string;
  title: string;
  subject: string | null;
  english: MatrixCell;
  cells: MatrixCell[];
};

export type LanguageTotals = {
  language: string;
  approved: number;
  inReview: number;
  translating: number;
  failed: number;
  notStarted: number;
  /** stale + blocked */
  attention: number;
};

/** The translation order (Kit Translator plan): Arabic first, then Malay,
 *  Hindi, Telugu, French, Spanish, Portuguese, Urdu, Marathi, Jawi. Only the
 *  codes the lesson-language registry carries become columns (Urdu joins when
 *  narration.ts / the worker's languages.py gains it). */
export const TRANSLATION_ORDER: readonly string[] = ["ar", "ms", "hi", "te", "fr", "es", "pt", "ur", "mr", "ms-arab"];

export const translationLanguages = (): string[] => TRANSLATION_ORDER.filter((code) => LANGUAGES.some((l) => l.value === code));

export const CELL_LABEL: Record<CellState, string> = {
  none: "Not started",
  not_ready: "Not ready",
  queued: "Queued",
  translating: "Translating",
  in_review: "In review",
  approved: "Approved",
  posted: "Posted",
  stale: "Stale",
  blocked: "Blocked",
  failed: "Failed",
};

/** Nothing done and nothing in flight — what "missing a language" means. */
export const isMissing = (state: CellState): boolean => state === "none" || state === "not_ready" || state === "failed" || state === "stale" || state === "blocked";

const LIVE_JOB = new Set(["queued", "processing"]);

const newestFirst = <T extends { created_at?: string | null }>(a: T, b: T): number => (b.created_at ?? "").localeCompare(a.created_at ?? "");

function group<T>(rows: readonly T[], key: (r: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    (out.get(k) ?? out.set(k, []).get(k)!).push(r);
  }
  return out;
}

const pairKey = (topicId: string, language: string) => `${topicId}|${language}`;

/** Every topic × every language in `languages`, sorted by subject then title. */
export function buildTranslationMatrix(input: MatrixInput, languages: readonly string[] = translationLanguages()): MatrixRow[] {
  const kitsById = new Map(input.kits.map((k) => [k.id, k]));
  const kitsByPair = group(input.kits, (k) => pairKey(k.topic_id, k.language));
  for (const list of kitsByPair.values()) list.sort(newestFirst);
  const postedKits = new Set(input.publications.filter((p) => p.youtube_video_id && !p.superseded_by).map((p) => p.topic_kit_id));
  const currentEnglish = new Map(input.current.filter((c) => c.language === "en").map((c) => [c.topic_id, c.topic_kit_id]));

  // a job names its topic; an older job may only name its source kit
  const jobTopic = (j: MatrixJob): string | null => {
    const t = j.params?.topic_id;
    if (typeof t === "string") return t;
    const s = j.params?.source_kit_id;
    return typeof s === "string" ? (kitsById.get(s)?.topic_id ?? null) : null;
  };
  const jobsByPair = group(input.jobs, (j) => {
    const topic = jobTopic(j);
    const language = j.params?.language;
    return topic && typeof language === "string" ? pairKey(topic, language) : null;
  });
  for (const list of jobsByPair.values()) list.sort(newestFirst);

  // the sweep's own verdict per language, for the cells with nothing in them
  const sweepJobs = input.jobs.filter((j) => LIVE_JOB.has(j.status)).map((j) => ({ status: j.status, params: j.params }));
  const readiness = new Map<string, { ready: Set<string>; notReady: Map<string, SweepNotReady> }>();
  for (const language of languages) {
    const r = readyForTranslation({ ...input, jobs: sweepJobs }, language);
    readiness.set(language, { ready: new Set(r.ready.map((c) => c.topicId)), notReady: new Map(r.notReady.map((n) => [n.topicId, n])) });
  }

  const cell = (topicId: string, language: string, state: CellState, detail: string | null, kitId: string | null, label?: string): MatrixCell => ({
    language,
    state,
    label: label ?? CELL_LABEL[state],
    detail,
    kitId,
    href: inboxHref(topicId, { lang: language }),
  });

  const englishCell = (topicId: string): MatrixCell => {
    const current = currentEnglish.get(topicId);
    if (current) return cell(topicId, "en", "posted", "The current English kit — approved, part 1 public on YouTube.", current);
    const kits = kitsByPair.get(pairKey(topicId, "en")) ?? [];
    const k = kits.find((x) => x.status !== "failed" && x.status !== "rejected") ?? kits[0];
    if (!k) return cell(topicId, "en", "none", "No English kit yet.", null, "No kit");
    if (k.status === "generating") return cell(topicId, "en", "translating", "The English kit is generating.", k.id, "Generating");
    if (k.status === "in_review") return cell(topicId, "en", "in_review", "The English kit awaits review.", k.id);
    if (k.status === "approved") return cell(topicId, "en", "approved", "Approved, but part 1 is not public on YouTube yet — the sweep waits for it.", k.id);
    return cell(topicId, "en", "failed", k.status === "rejected" ? "The newest English kit was rejected." : "The newest English kit failed.", k.id, k.status === "rejected" ? "Rejected" : "Failed");
  };

  const translationCell = (topicId: string, language: string): MatrixCell => {
    const jobs = jobsByPair.get(pairKey(topicId, language)) ?? [];
    const kits = kitsByPair.get(pairKey(topicId, language)) ?? [];

    // 1. a live job beats every kit
    const liveJob = jobs.find((j) => LIVE_JOB.has(j.status));
    if (liveJob) {
      return liveJob.status === "processing"
        ? cell(topicId, language, "translating", "A translate job is running.", kits[0]?.id ?? null)
        : cell(topicId, language, "queued", "A translate job is queued — the worker takes one kit at a time.", kits[0]?.id ?? null);
    }

    // 2. a live translation kit
    const live = kits.find((k) => translationIsLive(k));
    if (live) {
      const older = live.source_kit_id && currentEnglish.get(topicId) && live.source_kit_id !== currentEnglish.get(topicId) ? " It translates an older English kit." : "";
      if (live.status === "generating" || live.translation_status === "staged") return cell(topicId, language, "translating", `The translation kit is being built.${older}`, live.id);
      if (live.translation_status === "in_review" || (live.translation_status == null && live.status === "in_review")) {
        return cell(topicId, language, "in_review", `The translation awaits review.${older}`, live.id);
      }
      return postedKits.has(live.id)
        ? cell(topicId, language, "posted", `Approved and on YouTube.${older}`, live.id)
        : cell(topicId, language, "approved", `Approved — not posted to YouTube yet.${older}`, live.id);
    }

    // 3. the newest attempt failed: an error job newer than the newest kit
    const newestKit: SweepKit | undefined = kits[0];
    const lastError = jobs.find((j) => j.status === "error");
    const newestFinished = jobs[0];
    if (lastError && newestFinished === lastError && (!newestKit || (lastError.created_at ?? "") > (newestKit.created_at ?? ""))) {
      return cell(topicId, language, "failed", lastError.error?.trim() || "The translate job failed.", newestKit?.id ?? null);
    }

    // 4. the newest kit, not live
    if (newestKit) {
      if (newestKit.translation_status === "stale") return cell(topicId, language, "stale", "The English kit was replaced since — the translation is stale.", newestKit.id);
      if (newestKit.translation_status === "blocked") return cell(topicId, language, "blocked", "The translation is blocked (the English kit was corrected).", newestKit.id);
      const why = newestKit.status === "rejected" ? "Rejected in review." : (lastError?.error?.trim() || "The translation failed.");
      return cell(topicId, language, "failed", why, newestKit.id, newestKit.status === "rejected" ? "Rejected" : undefined);
    }

    // 5. nothing yet: the sweep's verdict
    const r = readiness.get(language);
    if (r?.ready.has(topicId)) return cell(topicId, language, "none", "Ready — the next Translate… sweep can take it.", null);
    const hold = r?.notReady.get(topicId);
    if (hold) return cell(topicId, language, "not_ready", hold.reason, null);
    return cell(topicId, language, "not_ready", "No current English kit — the topic needs an approved English kit with part 1 public on YouTube.", null);
  };

  const rows: MatrixRow[] = input.topics.map((t) => ({
    topicId: t.id,
    title: t.title,
    subject: t.subject,
    english: englishCell(t.id),
    cells: languages.map((language) => translationCell(t.id, language)),
  }));
  return rows.sort(
    (a, b) => (a.subject == null ? 1 : 0) - (b.subject == null ? 1 : 0) || (a.subject ?? "").localeCompare(b.subject ?? "") || a.title.localeCompare(b.title),
  );
}

/** The counts above the matrix, one per language column, over `rows`. */
export function totalsByLanguage(rows: readonly MatrixRow[], languages: readonly string[]): LanguageTotals[] {
  return languages.map((language, i) => {
    const t: LanguageTotals = { language, approved: 0, inReview: 0, translating: 0, failed: 0, notStarted: 0, attention: 0 };
    for (const r of rows) {
      const s = r.cells[i]?.state;
      if (s === "approved" || s === "posted") t.approved++;
      else if (s === "in_review") t.inReview++;
      else if (s === "translating" || s === "queued") t.translating++;
      else if (s === "failed") t.failed++;
      else if (s === "none" || s === "not_ready") t.notStarted++;
      else if (s === "stale" || s === "blocked") t.attention++;
    }
    return t;
  });
}

export type MatrixFilters = { subject: string; missing: string };

export function parseMatrixFilters(sp: Record<string, string | string[] | undefined> | null | undefined, languages: readonly string[]): MatrixFilters {
  const one = (v: string | string[] | undefined) => ((Array.isArray(v) ? v[0] : v) ?? "").trim();
  const missing = one(sp?.missing);
  return { subject: one(sp?.subject).slice(0, 60), missing: missing === "any" || languages.includes(missing) ? missing : "" };
}

/** The subject filter, then "missing": `any` keeps a topic missing at least
 *  one language, a language code keeps the topics missing that one. */
export function filterMatrixRows(rows: readonly MatrixRow[], f: MatrixFilters): MatrixRow[] {
  return rows.filter((r) => {
    if (f.subject && (r.subject ?? "") !== f.subject) return false;
    if (f.missing === "any") return r.cells.some((c) => isMissing(c.state));
    if (f.missing) return r.cells.some((c) => c.language === f.missing && isMissing(c.state));
    return true;
  });
}
