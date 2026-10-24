import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { STATE_LABEL, buildVideoRows } from "@/utils/catalogue/youtube-videos";
import { OPEN_STATUSES } from "@/utils/catalogue/youtube-agent";
import { loadTranslatedVideos } from "@/app/library/translations/youtube/load";
import { bad, dbError, notFound, uuid } from "../../lib";

export const runtime = "nodejs";

// One translated kit, for the Translations matrix's popup (founder
// 2026-10-24: "when i click on the approved button it opens up the
// translation in a popup window with info and towards the end it shows the
// option to post to youtube"). READ-ONLY. The popup posts through the YouTube
// Publishing Agent's own route (/api/library/youtube/agent, action "add"),
// which re-applies selectableForPost — this route only reports what that rule
// says (the same buildVideoRows row the YouTube view draws).
//
//   GET ?kitId=<uuid>  → the kit, its topic, the video and pieces (signed
//                         URLs, one hour), its YouTube row, and whether it is
//                         already in the posting queue.

const SIGN_TTL_SECONDS = 3600;
const KIT_COLUMNS =
  "id, topic_id, language, status, translation_status, source_kit_id, presentation_generation_id, doc_generation_ids, reviewed_at, reviewer_id, judge_score, notes, created_at, translation";

const PIECE_LABEL: Record<string, string> = {
  deck: "Slide deck",
  worksheet: "Worksheet",
  activity: "Activity",
  case_study: "Case study",
  lesson_plan: "Lesson plan",
  question_bank: "Question bank",
  quiz: "Online quiz",
};

type Artifact = { generation_id: string; kind: string; storage_path: string };

export async function GET(request: Request) {
  const m = await isLibraryMemberRequest();
  if (!m) return notFound();
  const kitId = uuid(new URL(request.url).searchParams.get("kitId"));
  if (!kitId) return bad("kitId must be a kit id.");
  const admin = createAdminClient();

  const kitQ = await admin.from("topic_kits").select(KIT_COLUMNS).eq("id", kitId).maybeSingle();
  if (kitQ.error) return dbError(kitQ.error);
  const kit = kitQ.data as Record<string, unknown> | null;
  if (!kit || !kit.translation_status) return notFound();

  const docIds = Object.entries((kit.doc_generation_ids ?? {}) as Record<string, string | null>).filter(
    (e): e is [string, string] => typeof e[1] === "string" && !!e[1],
  );
  const genIds = [kit.presentation_generation_id as string | null, ...docIds.map(([, id]) => id)].filter((x): x is string => !!x);

  const [topicQ, artQ, reviewerQ, queueQ, videos] = await Promise.all([
    admin.from("topics").select("id, title, subject").eq("id", kit.topic_id as string).maybeSingle(),
    genIds.length
      ? admin.from("artifacts").select("generation_id, kind, storage_path").in("generation_id", genIds)
      : Promise.resolve({ data: [] as Artifact[], error: null }),
    kit.reviewer_id ? admin.from("profiles").select("full_name").eq("id", kit.reviewer_id as string).maybeSingle() : Promise.resolve({ data: null, error: null }),
    admin.from("youtube_publish_queue").select("id, status").eq("kit_id", kitId).in("status", [...OPEN_STATUSES]).limit(1),
    loadTranslatedVideos(admin),
  ]);
  if (topicQ.error) return dbError(topicQ.error);
  if (artQ.error) return dbError(artQ.error);

  const sign = async (path: string): Promise<string | null> => {
    const { data } = await admin.storage.from("artifacts").createSignedUrl(path, SIGN_TTL_SECONDS);
    return data?.signedUrl ?? null;
  };
  const artifacts = (artQ.data ?? []) as Artifact[];
  const videoArt = artifacts
    .filter((a) => a.generation_id === kit.presentation_generation_id && a.kind === "video_mp4")
    .sort((a, b) => a.storage_path.localeCompare(b.storage_path));
  const video = await Promise.all(videoArt.map(async (a, i) => ({ part: i + 1, url: await sign(a.storage_path) })));
  const pieces = await Promise.all(
    docIds.map(async ([kind, gid]) => {
      // the piece's main file: the docx/pptx/pdf, never its answer key or script
      const files = artifacts.filter((a) => a.generation_id === gid && a.kind !== "script_json" && a.kind !== "thumbnail_png");
      const main = files.find((a) => !/answer|key/i.test(a.kind)) ?? files[0];
      return { kind, label: PIECE_LABEL[kind] ?? kind.replace(/_/g, " "), url: main ? await sign(main.storage_path) : null };
    }),
  );

  // the YouTube view's row for this kit: state, channel, parts, and the
  // posting rule (selectableForPost) — null when the kit is not in that list
  const row = videos.ok ? buildVideoRows(videos.input).find((r) => r.kitId === kitId) ?? null : null;
  const translation = (kit.translation ?? {}) as { cost?: { translation?: { usage?: { cost_usd?: number } } }; model?: string };

  return NextResponse.json({
    ok: true,
    kit: {
      id: kitId,
      language: kit.language,
      status: kit.status,
      translationStatus: kit.translation_status,
      sourceKitId: kit.source_kit_id,
      createdAt: kit.created_at,
      reviewedAt: kit.reviewed_at,
      reviewer: (reviewerQ.data as { full_name?: string } | null)?.full_name ?? null,
      notes: kit.notes ?? null,
      judgeScore: kit.judge_score ?? null,
      model: translation.model ?? null,
      translationCostUsd: translation.cost?.translation?.usage?.cost_usd ?? null,
    },
    topic: topicQ.data ?? null,
    video,
    pieces,
    youtube: row
      ? {
          state: row.state,
          stateLabel: STATE_LABEL[row.state],
          category: row.category,
          channel: row.channel,
          parts: row.parts.map((p) => ({ part: p.part, videoId: p.videoId, privacy: p.privacy, thumbnailSet: p.thumbnailSet, error: p.error })),
          liveJob: row.liveJob,
          postable: row.postable,
          inboxHref: row.inboxHref,
        }
      : null,
    youtubeError: videos.ok ? null : videos.error,
    queued: !queueQ.error && (queueQ.data ?? []).length > 0 ? (queueQ.data ?? [])[0] : null,
    canPost: libraryAllows(m.role, "publish"),
  });
}
