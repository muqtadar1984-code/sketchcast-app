import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { libraryAllows, type LibraryAction } from "@/utils/library-routing";
import { cataloguePublishEnabled } from "@/utils/flags";
import { catalogueColumnMissing } from "@/utils/catalogue/status";
import {
  DEFAULT_PRIVACY,
  canPublish,
  canQueuePublish,
  isPrivacy,
  publicationSummary,
  publishPrivacyAccepts,
} from "@/utils/catalogue/publish";
import type { PartPlanRow, PublishPrivacy, TopicPublication } from "@/utils/catalogue/types";
import { audit, bad, conflict, dbError, notFound, readJson, uuid } from "../../../lib";

export const runtime = "nodejs";

// One topic's PUBLISH to YouTube (Phase 4). POST {action, kitId, privacy?} —
// audited as library_publish on the TOPIC (target_kind 'topic'), so the topic
// page's trail shows the publish history next to the kit's and the article's.
//
//   publish (ADMIN ONLY — libraryAllows grants the `publish` action to admins
//   and nobody else, plan §7.1: an outside subject reviewer may approve a
//   video and must not be able to put it on the company's channel):
//     publish  {kitId, privacy?}  enqueue ONE `topic_publish` observer job for
//              an APPROVED kit. The worker uploads every video part in order,
//              writing a topic_publications row per (kit, part, language).
//     retry    {kitId, privacy?}  the same job for a kit a previous run
//              already touched: it finishes the parts the per-run upload cap
//              (YOUTUBE_MAX_PARTS_PER_RUN) or a failure left behind. The job
//              is idempotent — a part that already holds a youtube_video_id is
//              skipped — so a retry never double-uploads.
//
// THIS ROUTE WRITES ONE ROW: the job. It does NOT write topic_kits.status
// (gate 2 is the kit's `approved` status, which 0115's RPC owns and this route
// only reads), it does not insert `generations` (no model call is made — the
// video already exists as the kit's artifact) and it does not write
// topic_publications (the worker owns those: only the worker knows what
// YouTube actually accepted).
//
// FOUR REFUSALS, checked here and re-checked by the WORKER before its first
// network call (plan §1.3 — publishing is enforced twice, exactly like
// approval): the kit is approved, the topic is video approved (or already
// published, so a capped run can be finished), the kit's article is still the
// approved version, and the question bank is not empty. They live in the pure
// module (utils/catalogue/publish.ts canPublish) so the panel's disabled
// button, this 409 and the worker's refusal say one sentence.
//
// TWO MORE LOCKS in front of the insert:
//   • privacy — only `private` is queueable (publishPrivacyAccepts): an API
//     project that has not passed YouTube's compliance audit cannot create an
//     unlisted or public video, and a privacy flip is a later, deliberate step.
//   • FEATURE_CATALOGUE_PUBLISH (cataloguePublishEnabled) — the whole phase is
//     dark until the channel exists and the audit is through. Answered as a
//     409 with a plain sentence, never a 500, and checked AFTER the four
//     refusals so an operator reads the real blocker rather than the flag.
//
// The live-job pre-check is keyed exactly like 0116's jobs_one_live_publish
// index (params->>'kit_id') and a 23505 from the insert is read back the same
// way: two concurrent publishes of one kit would upload the same part twice to
// a channel with a ~100 uploads/day quota, and a duplicate public video cannot
// be taken back quietly. A kit id from another topic is a 404.

type Action = "publish" | "retry";

const NEEDS: Record<Action, LibraryAction> = {
  publish: "publish",
  retry: "publish",
};

type Body = {
  action?: unknown;
  kitId?: unknown;
  privacy?: unknown;
};

// Not exported as a constant the handler re-uses from elsewhere: a route
// module may only export Next's handler names.
const PUBLISH_JOB_TYPE = "topic_publish";

/** Phase 4 publishes the English channel; a language gets its own channel,
 *  its own refresh token and its own kit with the translate phase. */
const LANGUAGE = "en";

/** Without part_plan (0115): read separately, so a database where 0115 is not
 *  applied still publishes — the part count is then unknown and the summary
 *  describes only the parts that already have a publication row. */
const KIT_COLUMNS = "id, topic_id, article_id, language, status";

const PUBLICATION_COLUMNS =
  "id, topic_kit_id, part, channel_language, youtube_video_id, privacy, playlist_ids, captions_uploaded, thumbnail_set, published_at, error, created_at, updated_at";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const m = await isLibraryMemberRequest();
  if (!m) return notFound();

  const { id: rawId } = await ctx.params;
  const id = uuid(rawId);
  if (!id) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const action = body.action as Action;
  if (typeof action !== "string" || !(action in NEEDS)) return bad("Unknown action.");
  // Admin only. A reviewer or editor gets the same 404 a non-member gets: the
  // portal is not probeable (library-access.ts).
  if (!libraryAllows(m.role, NEEDS[action])) return notFound();

  const admin = createAdminClient();
  const { data: topic, error: tErr } = await admin
    .from("topics")
    .select("id, title, summary, status, bank_maturity")
    .eq("id", id)
    .maybeSingle();
  if (tErr) return dbError(tErr);
  if (!topic) return NextResponse.json({ error: "Topic not found." }, { status: 404 });

  // One of THIS topic's kits, or a 404.
  const kitId = uuid(body.kitId);
  if (!kitId) return bad("kitId is required.");
  const { data: kitRow, error: kErr } = await admin.from("topic_kits").select(KIT_COLUMNS).eq("id", kitId).eq("topic_id", id).maybeSingle();
  if (kErr) return dbError(kErr);
  if (!kitRow) return NextResponse.json({ error: "Kit not found on this topic." }, { status: 404 });
  const kit = kitRow as { id: string; article_id: string; language: string; status: string };

  // The kit's own article version — it must still be the approved one.
  const { data: article, error: aErr } = await admin.from("topic_articles").select("id, status").eq("id", kit.article_id).maybeSingle();
  if (aErr) return dbError(aErr);

  const accepts = canPublish(kit.status, topic.status as string, (article?.status as string | undefined) ?? null, (topic.bank_maturity as string | null) ?? null);
  if (!accepts.ok) {
    return conflict(accepts.why, {
      status: kit.status,
      topicStatus: topic.status,
      articleStatus: article?.status ?? null,
      bankMaturity: topic.bank_maturity ?? null,
    });
  }

  const raw = body.privacy === undefined || body.privacy === null || body.privacy === "" ? DEFAULT_PRIVACY : body.privacy;
  if (!isPrivacy(raw)) return bad("privacy must be private, unlisted or public.");
  const privacy: PublishPrivacy = raw;
  const allowed = publishPrivacyAccepts(privacy);
  if (!allowed.ok) return conflict(allowed.why, { privacy });

  // What a previous run already put on the channel, and how many parts the kit
  // has. The publish job is idempotent, so this decides only whether the run
  // would have anything to do — and gives the audit row its before-picture.
  const { data: pubRows, error: pErr } = await admin
    .from("topic_publications")
    .select(PUBLICATION_COLUMNS)
    .eq("topic_kit_id", kit.id)
    .eq("channel_language", LANGUAGE);
  if (pErr) return dbError(pErr);
  let plan: PartPlanRow[] = [];
  const { data: planRow, error: plErr } = await admin.from("topic_kits").select("part_plan").eq("id", kit.id).maybeSingle();
  if (plErr && !(catalogueColumnMissing(plErr) && /part_plan/i.test(plErr.message ?? ""))) return dbError(plErr);
  if (!plErr && Array.isArray(planRow?.part_plan)) plan = planRow.part_plan as PartPlanRow[];
  const summary = publicationSummary((pubRows ?? []) as unknown as TopicPublication[], plan.length);
  const queue = canQueuePublish(action, summary);
  if (!queue.ok) return conflict(queue.why, { parts: summary.total, published: summary.published, failed: summary.failed });

  // The dark lock, last: everything above is a fact about this kit, this is a
  // fact about the deployment, and the operator should read the former first.
  if (!cataloguePublishEnabled()) {
    return conflict(
      "Publishing is switched off (FEATURE_CATALOGUE_PUBLISH) — the YouTube channel is not created and the API project has not passed the compliance audit; nothing was queued.",
    );
  }

  const live = () =>
    admin
      .from("jobs")
      .select("id, status")
      .eq("type", PUBLISH_JOB_TYPE)
      .eq("params->>kit_id", kit.id)
      .in("status", ["queued", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

  const { data: running, error: lErr } = await live();
  if (lErr) return dbError(lErr);
  if (running) return conflict(`A publish is already ${running.status} for this kit.`, { jobId: running.id });

  const { data: job, error: jErr } = await admin
    .from("jobs")
    .insert({
      type: PUBLISH_JOB_TYPE,
      params: { kit_id: kit.id, topic_id: id, language: LANGUAGE, privacy },
      book_id: null,
      generation_id: null,
      status: "queued",
    })
    .select("id")
    .single();
  if (jErr) {
    if (jErr.code === "23505") {
      // Lost the race to another click: jobs_one_live_publish (0116) refused
      // the second row. Answer as the check above would have.
      const { data: winner } = await live();
      return conflict(`A publish is already ${winner?.status ?? "queued"} for this kit.`, { jobId: winner?.id ?? null });
    }
    return dbError(jErr);
  }

  await audit(admin, m.id, "publish", "topic", id, {
    kit_id: kit.id,
    job_id: job.id,
    action,
    language: LANGUAGE,
    privacy,
    parts: summary.total,
    parts_known: summary.known,
    already_published: summary.published,
    already_failed: summary.failed,
  });
  return NextResponse.json({ ok: true, jobId: job.id, action, privacy, parts: summary.total, alreadyPublished: summary.published });
}
