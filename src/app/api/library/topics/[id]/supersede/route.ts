import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { canQueueSupersede } from "@/utils/catalogue/format";
import { PUBLICATION_COLUMNS_0122 } from "@/utils/catalogue/format-server";
import type { TopicPublication } from "@/utils/catalogue/types";
import { audit, bad, conflict, dbError, notFound, readJson, uuid } from "../../../lib";

export const runtime = "nodejs";

// One topic's SUPERSEDE (0122): POST {kitId, oldPublicationId} — ADMIN ONLY,
// the same `publish` action the publish route asks for, because it changes a
// video on the company's channel.
//
// A YouTube video's file cannot be replaced, so a re-rendered lesson is a new
// upload. This route enqueues ONE `topic_supersede` observer job; the WORKER
// (sketchcast-ai catalogue/supersede.py) then gives the OLDER video — another
// kit's publication of the same part on this topic — a first description line
// pointing at THIS kit's posted video, makes a public old video unlisted, and
// records superseded_by on the old row. Nothing is deleted; the old video
// keeps its views, likes and comments. The founder's manual step after a
// re-render, never automatic: the dashboard, the topic list and the topic's
// publish block only show which videos predate the current video format.
//
// THIS ROUTE WRITES ONE ROW: the job. The pair is checked here
// (canQueueSupersede) and again by the worker (check_pair) with the same
// sentences, so a refusal reads the same in the portal and on the job.

const SUPERSEDE_JOB_TYPE = "topic_supersede";

const PUBLICATION_COLUMNS =
  "id, topic_kit_id, part, channel_language, youtube_video_id, privacy, playlist_ids, captions_uploaded, thumbnail_set, published_at, error, created_at, updated_at" +
  PUBLICATION_COLUMNS_0122;

type Body = { kitId?: unknown; oldPublicationId?: unknown };

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const m = await isLibraryMemberRequest();
  if (!m) return notFound();
  const { id: rawId } = await ctx.params;
  const id = uuid(rawId);
  if (!id) return notFound();
  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  if (!libraryAllows(m.role, "publish")) return notFound();

  const kitId = uuid(body.kitId);
  const oldId = uuid(body.oldPublicationId);
  if (!kitId) return bad("kitId is required.");
  if (!oldId) return bad("oldPublicationId is required.");

  const admin = createAdminClient();
  const { data: kitRow, error: kErr } = await admin.from("topic_kits").select("id, topic_id").eq("id", kitId).eq("topic_id", id).maybeSingle();
  if (kErr) return dbError(kErr);
  if (!kitRow) return NextResponse.json({ error: "Kit not found on this topic." }, { status: 404 });

  const { data: oldRow, error: oErr } = await admin.from("topic_publications").select(PUBLICATION_COLUMNS).eq("id", oldId).maybeSingle();
  if (oErr) return dbError(oErr);
  const old = (oldRow ?? null) as unknown as TopicPublication | null;
  if (!old) return NextResponse.json({ error: "Older publication not found." }, { status: 404 });
  const { data: oldKit, error: okErr } = await admin.from("topic_kits").select("id, topic_id").eq("id", old.topic_kit_id).maybeSingle();
  if (okErr) return dbError(okErr);
  if (!oldKit || (oldKit as { topic_id: string }).topic_id !== id) return NextResponse.json({ error: "Older publication is not on this topic." }, { status: 404 });
  if (old.topic_kit_id === kitId) return conflict("A kit cannot supersede its own video.");

  const { data: mineRows, error: mErr } = await admin
    .from("topic_publications")
    .select(PUBLICATION_COLUMNS)
    .eq("topic_kit_id", kitId)
    .eq("channel_language", old.channel_language)
    .eq("part", old.part)
    .limit(1);
  if (mErr) return dbError(mErr);
  const replacement = ((mineRows ?? [])[0] ?? null) as unknown as TopicPublication | null;
  const pair = canQueueSupersede(old, replacement);
  if (!pair.ok) return conflict(pair.why, { oldPublicationId: old.id, part: old.part });

  const live = () =>
    admin
      .from("jobs")
      .select("id, status")
      .eq("type", SUPERSEDE_JOB_TYPE)
      .eq("params->>old_publication_id", old.id)
      .in("status", ["queued", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  const { data: running, error: lErr } = await live();
  if (lErr) return dbError(lErr);
  if (running) return conflict(`A supersede is already ${running.status} for that video.`, { jobId: running.id });

  const { data: job, error: jErr } = await admin
    .from("jobs")
    .insert({
      type: SUPERSEDE_JOB_TYPE,
      params: {
        old_publication_id: old.id,
        new_publication_id: replacement!.id,
        kit_id: kitId,
        old_kit_id: old.topic_kit_id,
        topic_id: id,
        language: old.channel_language,
        part: old.part,
      },
      book_id: null,
      generation_id: null,
      status: "queued",
    })
    .select("id")
    .single();
  if (jErr) return dbError(jErr);

  await audit(admin, m.id, "supersede", "topic", id, {
    kit_id: kitId,
    old_kit_id: old.topic_kit_id,
    old_publication_id: old.id,
    new_publication_id: replacement!.id,
    old_video_id: old.youtube_video_id,
    new_video_id: replacement!.youtube_video_id,
    part: old.part,
    job_id: job.id,
  });
  return NextResponse.json({ ok: true, jobId: job.id, part: old.part, oldVideoId: old.youtube_video_id, newVideoId: replacement!.youtube_video_id });
}
