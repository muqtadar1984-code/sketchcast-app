import type { Admin } from "../../../lib";

// Take a generation's job OUT of the queue before the worker claims it. Used
// by the kit route's Retry when repoint_kit_generation() refuses: the new
// generation is queued and nothing points at it, and built it would be an
// orphan — for a presentation a whole video's worth of Vertex image calls no
// kit ever shows. Lives beside the route (like questions-job.ts) because the
// kit route itself never touches `jobs`: jobs are made by the
// create_job_for_generation() trigger, never by hand, and
// catalogue-routes.test.ts pins that the route has no `.from("jobs")` at all.
//
// Guarded on `queued` and read back: a job the worker has already claimed is
// `processing` and cannot be recalled — the caller then leaves its lock in
// place (a second Retry would double-build) and says so. The catalogue lane
// runs off-peak with no user builder live, so in practice the job sits for
// hours and the cancel lands.

export type CancelJobResult = { cancelled: boolean; error: { code?: string; message?: string } | null };

export async function cancelQueuedJob(admin: Admin, generationId: string, reason: string): Promise<CancelJobResult> {
  const { data, error } = await admin
    .from("jobs")
    .update({ status: "error", error: `cancelled by the portal: ${reason}` })
    .eq("generation_id", generationId)
    .eq("status", "queued")
    .select("id");
  if (error) return { cancelled: false, error };
  return { cancelled: !!data?.length, error: null };
}
