// The Kit Translator's SWEEP (plan §5.8 + decision D7, T2 — 2026-10-17): which
// of the catalogue's current English kits are ready to be translated into one
// language, and why the others are not. Pure — the route
// (/api/library/translate) reads the rows and hands them in; the review
// inbox's Translate… drawer shows the answer; the tests pass rows in. Keep it
// free of I/O, like kit.ts and publish.ts.
//
// A kit enters the sweep only if (plan §5.8, adapted to today's data):
//   • it is the topic's CURRENT approved English kit — a row of
//     catalogue_current_kits() with language 'en' (0128/0134: the newest
//     approved kit whose own video is public, on a non-retired topic with an
//     approved bank);
//   • its part-1 video is public on YouTube and not superseded;
//   • the topic's bank maturity is not 'none';
//   • it is not itself superseded (supersede_reason, 0134);
//   • its judge score, where present, is at or above JUDGE_REVIEW_THRESHOLD
//     (judge_score is null on every kit today, so the gate is inert until the
//     judge writes one — null passes);
//   • no translation of this topic in the language is live: generating /
//     staged, in review, or approved. A stale, blocked or failed one does not
//     block — that is what the sweep is for;
//   • no kit_translate job for (this kit, the language) is queued or
//     processing (reported as `queued`, so the drawer can say so).
//
// The ready list alternates subjects (Mathematics, Science, …) and takes the
// oldest kit of each first, so a "five kits first" sweep mixes kit types
// rather than running five maths kits in a row.

export type SweepCurrentKit = { topic_id: string; language: string; topic_kit_id: string; approved_at?: string | null };

export type SweepTopic = { id: string; title: string; subject: string | null; status: string; bank_maturity: string | null };

export type SweepKit = {
  id: string;
  topic_id: string;
  language: string;
  status: string;
  source_kit_id: string | null;
  /** 0134; absent before the migration */
  translation_status?: string | null;
  /** 0134; absent before the migration */
  supersede_reason?: string | null;
  judge_score?: Record<string, unknown> | number | null;
  created_at: string;
};

export type SweepPublication = {
  topic_kit_id: string;
  part: number;
  privacy: string;
  youtube_video_id: string | null;
  /** 0122; absent before the migration */
  superseded_by?: string | null;
};

export type SweepJob = { status: string; params: Record<string, unknown> | null };

export type SweepInput = {
  /** catalogue_current_kits() — every language; the sweep keeps 'en' */
  current: readonly SweepCurrentKit[];
  topics: readonly SweepTopic[];
  /** the current English kits and every kit of their topics in the target language */
  kits: readonly SweepKit[];
  /** the current English kits' publications */
  publications: readonly SweepPublication[];
  /** live (queued / processing) kit_translate jobs */
  jobs: readonly SweepJob[];
};

/** A kit the sweep looked at: what the drawer lists. */
export type SweepCandidate = {
  kitId: string;
  topicId: string;
  title: string;
  subject: string | null;
  bankMaturity: string | null;
  /** when the English kit was created (the sweep's "oldest first") */
  createdAt: string | null;
};

export type NotReadyCode =
  | "topic_missing"
  | "topic_retired"
  | "bank_none"
  | "kit_missing"
  | "kit_not_approved"
  | "kit_superseded"
  | "video_missing"
  | "video_not_public"
  | "video_superseded"
  | "judge_below_threshold"
  | "translation_live"
  | "queued";

export type SweepNotReady = SweepCandidate & { code: NotReadyCode; reason: string };

export type SweepResult = { ready: SweepCandidate[]; notReady: SweepNotReady[] };

/** A judge score below this is held back from the sweep (plan §5.8: "at or
 *  above the review threshold"). Scale 0–10. No kit carries a score yet
 *  (judge_score is null everywhere, 2026-10-17); when the judge lands, the
 *  threshold is tuned on measured scores, not guessed here. */
export const JUDGE_REVIEW_THRESHOLD = 7;

/** The subjects a sweep alternates, in this order; any other subject follows
 *  alphabetically, a missing subject last. */
export const SWEEP_SUBJECT_ORDER: readonly string[] = ["Mathematics", "Science"];

/** The most a sweep queues in one click; the route caps `limit` here. */
export const SWEEP_MAX_LIMIT = 100;
export const SWEEP_DEFAULT_LIMIT = 5;

const LIVE_JOB = new Set(["queued", "processing"]);

/** The number inside judge_score, or null when there is none. The judge's
 *  row shape is not fixed yet: a bare number, or an object with `score`,
 *  `overall` or `total`. Anything else reads as no score (passes). */
export function judgeScoreOf(v: SweepKit["judge_score"]): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (!v || typeof v !== "object") return null;
  for (const key of ["score", "overall", "total"]) {
    const n = (v as Record<string, unknown>)[key];
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

/** Is this translation kit live — building, awaiting review, or serving?
 *  stale / blocked / failed (and a rejected or failed kit) do not block a new
 *  translation. Without 0134 the kit status decides. */
export function translationIsLive(k: Pick<SweepKit, "status" | "translation_status">): boolean {
  // a rejected or failed kit is history whatever its translation column
  // still says (the Translations panel's "taken" rule keys on kit status too)
  if (k.status === "rejected" || k.status === "failed") return false;
  if (k.status === "generating") return true;
  const ts = k.translation_status;
  if (ts === "staged" || ts === "in_review" || ts === "approved") return true;
  if (ts == null) return k.status === "in_review" || k.status === "approved";
  return false;
}

const subjectRank = (subject: string | null): number => {
  if (!subject) return Number.MAX_SAFE_INTEGER;
  const i = SWEEP_SUBJECT_ORDER.indexOf(subject);
  return i === -1 ? SWEEP_SUBJECT_ORDER.length : i;
};

const bySubjectThenTitle = (a: SweepCandidate, b: SweepCandidate): number =>
  subjectRank(a.subject) - subjectRank(b.subject) || (a.subject ?? "").localeCompare(b.subject ?? "") || a.title.localeCompare(b.title);

/** Alternate subjects — Mathematics, Science, the rest — taking the oldest
 *  kit of each subject in turn, so a short sweep mixes kit types. */
export function orderForSweep(ready: readonly SweepCandidate[]): SweepCandidate[] {
  const groups = new Map<string, SweepCandidate[]>();
  for (const c of ready) {
    const key = c.subject ?? "";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  const keys = [...groups.keys()].sort((a, b) => subjectRank(a || null) - subjectRank(b || null) || a.localeCompare(b));
  const queues = keys.map((k) => groups.get(k)!.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.title.localeCompare(b.title)));
  const out: SweepCandidate[] = [];
  let left = ready.length;
  while (left > 0) {
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        left--;
      }
    }
  }
  return out;
}

/** The sweep's answer for `language`: every current English kit, as ready
 *  (in sweep order) or not ready with the reason. */
export function readyForTranslation(input: SweepInput, language: string): SweepResult {
  const topics = new Map(input.topics.map((t) => [t.id, t]));
  const kits = new Map(input.kits.map((k) => [k.id, k]));
  const translationsByTopic = new Map<string, SweepKit[]>();
  for (const k of input.kits) {
    if (k.language !== language) continue;
    (translationsByTopic.get(k.topic_id) ?? translationsByTopic.set(k.topic_id, []).get(k.topic_id)!).push(k);
  }
  const pubsByKit = new Map<string, SweepPublication[]>();
  for (const p of input.publications) (pubsByKit.get(p.topic_kit_id) ?? pubsByKit.set(p.topic_kit_id, []).get(p.topic_kit_id)!).push(p);
  const queuedFor = new Set(
    input.jobs
      .filter((j) => LIVE_JOB.has(j.status) && j.params?.language === language && typeof j.params?.source_kit_id === "string")
      .map((j) => j.params!.source_kit_id as string),
  );

  const ready: SweepCandidate[] = [];
  const notReady: SweepNotReady[] = [];
  const seen = new Set<string>();
  for (const cur of input.current) {
    if (cur.language !== "en" || seen.has(cur.topic_kit_id)) continue;
    seen.add(cur.topic_kit_id);
    const topic = topics.get(cur.topic_id) ?? null;
    const kit = kits.get(cur.topic_kit_id) ?? null;
    const candidate: SweepCandidate = {
      kitId: cur.topic_kit_id,
      topicId: cur.topic_id,
      title: topic?.title ?? cur.topic_id,
      subject: topic?.subject ?? null,
      bankMaturity: topic?.bank_maturity ?? null,
      createdAt: kit?.created_at ?? cur.approved_at ?? null,
    };
    const hold = (code: NotReadyCode, reason: string) => notReady.push({ ...candidate, code, reason });

    if (!topic) {
      hold("topic_missing", "The topic row was not found.");
      continue;
    }
    if (topic.status === "retired") {
      hold("topic_retired", "The topic is retired.");
      continue;
    }
    if (!topic.bank_maturity || topic.bank_maturity === "none") {
      hold("bank_none", "The question bank has no approved items (maturity none).");
      continue;
    }
    if (!kit) {
      hold("kit_missing", "The current kit row was not found.");
      continue;
    }
    if (kit.status !== "approved") {
      hold("kit_not_approved", `The English kit is ${kit.status.replace(/_/g, " ")}, not approved.`);
      continue;
    }
    if (kit.supersede_reason) {
      hold("kit_superseded", `The English kit was superseded (${kit.supersede_reason}).`);
      continue;
    }
    const part1 = (pubsByKit.get(kit.id) ?? []).filter((p) => p.part === 1 && p.youtube_video_id);
    if (!part1.length) {
      hold("video_missing", "Part 1 is not on YouTube.");
      continue;
    }
    const live = part1.filter((p) => !p.superseded_by);
    if (!live.length) {
      hold("video_superseded", "The part-1 video on YouTube was superseded.");
      continue;
    }
    if (!live.some((p) => p.privacy === "public")) {
      hold("video_not_public", `The part-1 video is ${live[0].privacy}, not public.`);
      continue;
    }
    const score = judgeScoreOf(kit.judge_score);
    if (score !== null && score < JUDGE_REVIEW_THRESHOLD) {
      hold("judge_below_threshold", `The judge scored the English kit ${score}, below the review threshold of ${JUDGE_REVIEW_THRESHOLD}.`);
      continue;
    }
    const existing = (translationsByTopic.get(topic.id) ?? []).find(translationIsLive);
    if (existing) {
      const state = existing.status === "generating" || existing.translation_status === "staged" ? "being built" : existing.translation_status === "in_review" || (existing.translation_status == null && existing.status === "in_review") ? "in review" : "approved";
      const older = existing.source_kit_id && existing.source_kit_id !== kit.id ? " (of an older English kit — supersede it to mark the translation stale)" : "";
      hold("translation_live", `A translation is already ${state}${older}.`);
      continue;
    }
    if (queuedFor.has(kit.id)) {
      hold("queued", "A translate job is already queued or running.");
      continue;
    }
    ready.push(candidate);
  }
  return { ready: orderForSweep(ready), notReady: notReady.sort(bySubjectThenTitle) };
}
