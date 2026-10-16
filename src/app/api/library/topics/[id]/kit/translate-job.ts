import type { Admin } from "../../../lib";

// The Kit Translator's job (plan revision 3, T0 — 2026-10-16): ONE
// `kit_translate` observer job per (source English kit, language) —
// generation_id and book_id NULL, its input in jobs.params. The WORKER does
// everything else: it creates the translated topic_kits row, translates the
// glossary, the article and the scripts, checks them, and queues the
// translated presentation and deck (catalogue/translate.py).
//
// Its own module for the same repo invariant kit/questions-job.ts explains:
// a file that inserts `generations` must never also insert `jobs`
// (pipeline-universal.test.ts). The kit route inserts generations; this is a
// different job for a different thing. catalogue-routes.test.ts lists this
// file among the jobs inserters.

const TRANSLATE_JOB_TYPE = "kit_translate";

export type EnqueueTranslate =
  | { ok: true; jobId: string; existing: false }
  | { ok: true; jobId: string | null; existing: true }
  | { ok: false; error: { code?: string; message?: string } };

/** Enqueue the translation, or report the live one. The live pre-check is
 *  keyed exactly like 0134's jobs_one_live_translate index —
 *  (params->>'source_kit_id', params->>'language') — and a 23505 from the
 *  insert is read back the same way. */
export async function enqueueTranslateJob(admin: Admin, opts: { sourceKitId: string; topicId: string; language: string }): Promise<EnqueueTranslate> {
  const live = () =>
    admin
      .from("jobs")
      .select("id, status")
      .eq("type", TRANSLATE_JOB_TYPE)
      .eq("params->>source_kit_id", opts.sourceKitId)
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
      type: TRANSLATE_JOB_TYPE,
      params: { source_kit_id: opts.sourceKitId, topic_id: opts.topicId, language: opts.language },
      book_id: null,
      generation_id: null,
      status: "queued",
    })
    .select("id")
    .single();
  if (jErr) {
    if (jErr.code === "23505") {
      const { data: winner } = await live();
      return { ok: true, jobId: (winner?.id as string | undefined) ?? null, existing: true };
    }
    return { ok: false, error: jErr };
  }
  return { ok: true, jobId: job.id as string, existing: false };
}
