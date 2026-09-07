import type { Admin } from "../../../lib";

// The question-bank job the kit route enqueues when a kit is made (Phase 3,
// decision 8): ONE `topic_questions` observer job per (topic, language) —
// generation_id and book_id NULL, its input in jobs.params (0113).
//
// It lives in its own module, not in route.ts, because of a repo invariant:
// a file that inserts a `generations` row must never also insert a `jobs`
// row (pipeline-universal.test.ts — the on_generation_created trigger owns
// the job of a generation, uniformly for every role). The kit route inserts
// generations; this job is a DIFFERENT job for a different thing (the bank),
// so the invariant is honoured by keeping the two inserts in two files rather
// than by re-shaping the query to slip past a regex. catalogue-routes.test.ts
// lists this file among the jobs inserters.

// Not exported as a constant the route re-uses: a route module may only
// export Next's handler names, and this module is the one place the type is
// spelled on the kit side.
const QUESTIONS_JOB_TYPE = "topic_questions";

export type EnqueueQuestions =
  | { ok: true; jobId: string; existing: false }
  | { ok: true; jobId: string | null; existing: true }
  | { ok: false; error: { code?: string; message?: string } };

/** Enqueue the bank job, or report the live one. The live pre-check is keyed
 *  exactly like 0115's jobs_one_live_questions index — (params->>'topic_id',
 *  coalesce(params->>'language','en')) — and a 23505 from the insert is read
 *  back the same way: the bank job already runs, which is not a failure of
 *  the kit (the kit route audits `questions_job: existing`). */
export async function enqueueQuestionsJob(admin: Admin, opts: { topicId: string; articleId: string; language: string }): Promise<EnqueueQuestions> {
  const live = () =>
    admin
      .from("jobs")
      .select("id, status")
      .eq("type", QUESTIONS_JOB_TYPE)
      .eq("params->>topic_id", opts.topicId)
      .eq("params->>language", opts.language)
      .in("status", ["queued", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

  const { data: running, error: lErr } = await live();
  if (lErr) return { ok: false, error: lErr };
  if (running) return { ok: true, jobId: running.id as string, existing: true };

  const { data: job, error: jErr } = await admin
    .from("jobs")
    .insert({
      type: QUESTIONS_JOB_TYPE,
      params: { topic_id: opts.topicId, article_id: opts.articleId, language: opts.language },
      book_id: null,
      generation_id: null,
      status: "queued",
    })
    .select("id")
    .single();
  if (jErr) {
    if (jErr.code === "23505") {
      // Lost the race to another enqueue (the questions page, or a second
      // kit click): jobs_one_live_questions refused the second row.
      const { data: winner } = await live();
      return { ok: true, jobId: (winner?.id as string | undefined) ?? null, existing: true };
    }
    return { ok: false, error: jErr };
  }
  return { ok: true, jobId: job.id as string, existing: false };
}
