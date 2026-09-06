import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { audit, bad, conflict, dbError, notFound, readJson, uuid } from "../lib";

export const runtime = "nodejs";

// POST {curriculumId} — enqueue ONE `topic_derive` job for a curriculum (curate).
//
// The worker's topic_derive reads {curriculum_id} from jobs.params (0113) and
// files GROUPED curriculum candidates: one proposed topic per group of
// objectives ("Cells" for 7Bs.01–7Bs.05), with node_ids and a rationale, for a
// curator to approve on /library/candidates. The job row is inserted directly
// with the service role: it is an OBSERVER job (owns no generation and no
// book — generation_id and book_id NULL) so nothing here touches
// `generations`, no credit moves, and the on_generation_created trigger is not
// involved. One live derive per curriculum: a queued or processing one refuses
// a second with 409. The read-then-insert below is the friendly answer (it can
// name the live job); the partial unique index jobs_one_live_derive (0113, on
// params->>'curriculum_id') is the rule the database enforces when two clicks
// race it, and its 23505 is mapped to the same 409. A missing `params` column
// (0113 not applied) is a 409 with the migration hint (dbError).

// Not exported: a route module may only export Next's handler names.
const DERIVE_JOB_TYPE = "topic_derive";

type Body = { curriculumId?: unknown };

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("curate");
  if (!m) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const curriculumId = uuid(body.curriculumId);
  if (!curriculumId) return bad("curriculumId is required.");

  const admin = createAdminClient();
  const { data: curriculum, error: cErr } = await admin
    .from("curricula")
    .select("id, code, name")
    .eq("id", curriculumId)
    .maybeSingle();
  if (cErr) return dbError(cErr);
  if (!curriculum) return NextResponse.json({ error: "Curriculum not found." }, { status: 404 });

  const { count: nodeCount, error: nErr } = await admin
    .from("curriculum_nodes")
    .select("id", { count: "exact", head: true })
    .eq("curriculum_id", curriculumId);
  if (nErr) return dbError(nErr);
  if (!nodeCount) return bad("That curriculum has no nodes yet; seed it before deriving topics.");

  const liveDerive = () =>
    admin
      .from("jobs")
      .select("id, status, created_at")
      .eq("type", DERIVE_JOB_TYPE)
      .eq("params->>curriculum_id", curriculumId)
      .in("status", ["queued", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

  const { data: live, error: lErr } = await liveDerive();
  if (lErr) return dbError(lErr);
  if (live) return conflict(`A derive is already ${live.status} for this curriculum.`, { jobId: live.id });

  const { data: job, error: jErr } = await admin
    .from("jobs")
    .insert({
      type: DERIVE_JOB_TYPE,
      params: { curriculum_id: curriculumId },
      book_id: null,
      generation_id: null,
      status: "queued",
    })
    .select("id")
    .single();
  if (jErr) {
    if (jErr.code === "23505") {
      // Lost the race to another click: jobs_one_live_derive refused the second
      // row. Answer as the check above would have, naming the job that won.
      const { data: winner } = await liveDerive();
      return conflict(`A derive is already ${winner?.status ?? "queued"} for this curriculum.`, { jobId: winner?.id ?? null });
    }
    return dbError(jErr);
  }

  await audit(admin, m.id, "derive_enqueue", "curriculum", curriculumId, {
    job_id: job.id,
    code: curriculum.code,
    name: curriculum.name,
    nodes: nodeCount,
  });
  return NextResponse.json({ ok: true, jobId: job.id });
}
