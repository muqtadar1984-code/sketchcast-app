import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { audit, bad, conflict, dbError, notFound, readJson, uuid } from "../lib";

export const runtime = "nodejs";

// Demo videos (the /library/demos page). A DEMO is a generation the worker
// drew under a pinned setting to validate a rendering change before it goes
// live — params.demo names the experiment (e.g. "board_colour_phase1") and
// params.board_colour (or whichever pin) says what was tried. It names a kit
// so the worker can prepare it from the kit's article, but it is never the
// kit's presentation_generation_id, so the kit's lifecycle records nothing
// from it (catalogue/kit.py record_presentation) and the topic page never
// shows it. Queued by hand (SQL) for now; this route only removes them.
//
//   POST {action: "delete", generationId}  (generate: editor, admin)
//     the storage objects behind its artifacts, then the generation row —
//     jobs and artifacts rows cascade (FK). Refused for a row without
//     params.demo (never a way to delete a real lesson) and for a row some
//     kit still points at. Audited as library_demo_delete on the generation.
//
// Non-members and reviewers get 404: the portal is not probeable.

type Body = { action?: unknown; generationId?: unknown };

const BUCKET = "artifacts";

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("generate");
  if (!m) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  if (body.action !== "delete") return bad("Unknown action.");
  const id = uuid(body.generationId);
  if (!id) return bad("generationId is required.");

  const admin = createAdminClient();
  // Only a DEMO row is reachable through this route: the filter is on the
  // read AND on the delete, so a real lesson's id answers 404 here and is
  // never removed even if the read is raced.
  const { data: gen, error: gErr } = await admin
    .from("generations")
    .select("id, kind, status, params")
    .eq("id", id)
    .not("params->>demo", "is", null)
    .maybeSingle();
  if (gErr) return dbError(gErr);
  if (!gen) return NextResponse.json({ error: "Demo not found." }, { status: 404 });

  const { data: pointing, error: kErr } = await admin.from("topic_kits").select("id").eq("presentation_generation_id", id).limit(1);
  if (kErr) return dbError(kErr);
  if (pointing?.length) {
    return conflict("A kit points at this video as its presentation; it is not a demo any more. Point the kit elsewhere first.", { kitId: pointing[0].id });
  }

  const { data: artifacts, error: aErr } = await admin.from("artifacts").select("storage_path").eq("generation_id", id);
  if (aErr) return dbError(aErr);
  const paths = (artifacts ?? []).map((a) => a.storage_path as string).filter(Boolean);
  if (paths.length) {
    // The files first: a row without files is a dead link the page hides; a
    // file without a row is storage nobody can find again.
    const { error: sErr } = await admin.storage.from(BUCKET).remove(paths);
    if (sErr) return NextResponse.json({ error: `Could not remove the files: ${sErr.message}` }, { status: 500 });
  }

  const { data: removed, error: dErr } = await admin.from("generations").delete().eq("id", id).not("params->>demo", "is", null).select("id");
  if (dErr) return dbError(dErr);
  if (!removed?.length) return conflict("The demo changed while you were looking; reload.", {});

  const params = (gen.params ?? {}) as Record<string, unknown>;
  await audit(admin, m.id, "demo_delete", "generation", id, {
    demo: params.demo ?? null,
    kind: gen.kind,
    status: gen.status,
    topic_id: params.topic_id ?? null,
    kit_id: params.kit_id ?? null,
    files: paths.length,
  });
  return NextResponse.json({ ok: true, files: paths.length });
}
