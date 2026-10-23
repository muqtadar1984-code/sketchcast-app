import "server-only";
import { readChunks, type Admin } from "@/app/api/library/lib";
import { catalogueColumnMissing } from "@/utils/catalogue/status";
import type { SweepCurrentKit, SweepKit, SweepPublication, SweepTopic } from "@/utils/catalogue/translate-sweep";
import { FIX_QUEUED_STATUSES, type MatrixFixCase, type MatrixInput, type MatrixJob } from "@/utils/catalogue/translation-matrix";
import type { TranslationClockData } from "@/utils/catalogue/translation-eta";
import { loadTranslationTiming } from "@/utils/catalogue/translation-timing-server";

// The Translations tab's reads — the translate sweep's five reads
// (/api/library/translate), widened from "the current English kits and one
// language" to every topic and every language, so one page load answers all
// the columns. Read-only; every id list is chunked at IN_CHUNK (readChunks).
//
//   catalogue_current_kits()  the current kit per (topic, language)
//   topics                    every topic but the retired ones
//   topic_kits                every kit of those topics, every language
//   topic_publications        the publications of those kits
//   jobs                      the newest kit_translate jobs, live and finished
//   fix_cases                 the Fix Agent's approved / applied cases (0151) —
//                             a failed cell with one reads "fix queued"; a
//                             failed read (or no 0151) only leaves them failed

const KIT_COLUMNS = "id, topic_id, language, status, source_kit_id, judge_score, created_at";
const KIT_COLUMNS_0134 = `${KIT_COLUMNS}, translation_status, supersede_reason`;
const PUBLICATION_COLUMNS = "topic_kit_id, part, privacy, youtube_video_id";
const PUBLICATION_COLUMNS_0122 = `${PUBLICATION_COLUMNS}, superseded_by`;

/** Enough history for "the newest attempt failed" on every pair: a sweep
 *  queues at most 100 at once and a retry adds one row per attempt. */
const JOB_LIMIT = 2000;
/** Approved / applied fix cases at once — the lane runs one at a time. */
const FIX_LIMIT = 1000;

export type MatrixLoad =
  | { ok: true; input: MatrixInput; retired: number; translationsMissing: boolean; clocks: TranslationClockData }
  | { ok: false; error: string };

export async function loadTranslationMatrix(admin: Admin): Promise<MatrixLoad> {
  const fail = (e: { message?: string } | null) => ({ ok: false as const, error: e?.message ?? "unknown database error" });

  const [currentQ, topicsQ, jobsQ, clocks, fixesQ] = await Promise.all([
    admin.rpc("catalogue_current_kits"),
    admin.from("topics").select("id, title, subject, status, bank_maturity"),
    admin.from("jobs").select("id, status, params, error, created_at, claimed_at, progress").eq("type", "kit_translate").order("created_at", { ascending: false }).limit(JOB_LIMIT),
    loadTranslationTiming(admin),
    admin.from("fix_cases").select("topic_id, language, status").in("status", [...FIX_QUEUED_STATUSES]).limit(FIX_LIMIT),
  ]);
  if (currentQ.error) return fail(currentQ.error);
  if (topicsQ.error) return fail(topicsQ.error);
  if (jobsQ.error) return fail(jobsQ.error);

  const allTopics = (topicsQ.data ?? []) as SweepTopic[];
  const topics = allTopics.filter((t) => t.status !== "retired");
  const topicIds = topics.map((t) => t.id);

  // 0134's translation columns; a database without them still shows the
  // English column and every kit by its own status
  let translationsMissing = false;
  let kits = await readChunks<SweepKit>(topicIds, (chunk) => admin.from("topic_kits").select(KIT_COLUMNS_0134).in("topic_id", chunk));
  if (kits.error && catalogueColumnMissing(kits.error)) {
    translationsMissing = true;
    kits = await readChunks<SweepKit>(topicIds, (chunk) => admin.from("topic_kits").select(KIT_COLUMNS).in("topic_id", chunk));
  }
  if (kits.error) return fail(kits.error);

  const kitIds = kits.rows.map((k) => k.id);
  let publications = await readChunks<SweepPublication>(kitIds, (chunk) => admin.from("topic_publications").select(PUBLICATION_COLUMNS_0122).in("topic_kit_id", chunk));
  if (publications.error && catalogueColumnMissing(publications.error)) {
    publications = await readChunks<SweepPublication>(kitIds, (chunk) => admin.from("topic_publications").select(PUBLICATION_COLUMNS).in("topic_kit_id", chunk));
  }
  if (publications.error) return fail(publications.error);

  return {
    ok: true,
    input: {
      current: (currentQ.data ?? []) as SweepCurrentKit[],
      topics,
      kits: kits.rows,
      publications: publications.rows,
      jobs: (jobsQ.data ?? []) as MatrixJob[],
      // the service role reads fix_cases; a missing table or a failed read
      // is not worth an error banner — the cells just stay failed
      fixCases: fixesQ.error ? [] : ((fixesQ.data ?? []) as MatrixFixCase[]),
    },
    retired: allTopics.length - topics.length,
    translationsMissing,
    clocks,
  };
}
