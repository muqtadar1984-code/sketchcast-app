"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  KIT_KINDS,
  KIT_KIND_LABEL,
  KIT_REJECT_REASONS,
  KIT_REJECT_REASON_LABEL,
  canApproveKit,
  canEditClips,
  canRejectKit,
  canRetryKit,
  chaptersByPart,
  fmtTimestamp,
  hasLiveKit,
  kitAcceptsApprove,
  kitAcceptsGenerate,
  kitAcceptsRegenerate,
  kitAcceptsReject,
  kitGenerationIdFor,
  kitProgress,
  kitStatusLabel,
  nextTeacherAvatar,
  partDurationsOf,
  validateClips,
  type KitKind,
} from "@/utils/catalogue/kit";
import {
  AUDIT_NOTE,
  INTRO_MAX,
  PRIVACY,
  PRIVACY_LABEL,
  PUBLISH_OFF_NOTE,
  TITLE_MAX,
  audienceTag,
  boardsOf,
  buildDescriptionPreview,
  canPublish,
  canQueuePublish,
  defaultPrivacy,
  effectiveTerms,
  publicationSummary,
  publishActionFor,
  publishPrivacyAccepts,
  publishTitle,
  publishablePrivacies,
} from "@/utils/catalogue/publish";
import { isLiveJobStatus, stageLabel } from "@/utils/catalogue/status";
import type { HeaderMapping } from "@/utils/catalogue/kit";
import type { ClipRow, KitGenerationRow, KitRejectReason, PublishPrivacy, TeacherAvatar, TopicKit, TopicPublication, VideoFormatSetting, YouTubeMeta } from "@/utils/catalogue/types";
import { canQueueSupersede, changesSince, formatLabel, formatVersionOf, supersedeCandidates } from "@/utils/catalogue/format";
import { GenStatusChip, KitStatusChip, fmtDate } from "../../catalogue-ui";
import type { JobRow } from "./article-panel";

// The topic page's Kit panel (Phase 3): Generate kit (teacher avatar, default
// alternating), the current kit — status, per-piece rows with the worker's
// job progress and error, the video parts inline, the documents as downloads,
// the part plan, the chapter timestamps, the editable clip list — the review
// box (Approve video / Reject with a reason), Retry for a failed piece,
// Regenerate kit, and the older kits as collapsed history. Every control
// POSTs /api/library/topics/[id]/kit with {action, …} and then
// router.refresh() (the article-panel.tsx pattern). `can*` flags and the two
// env locks come from the server; the route re-checks them, these only decide
// what renders and what the disabled button says.
//
// Phase 4 adds the PUBLISH block, shown only for an approved kit and posting
// to /api/library/topics/[id]/publish. It is the one block that renders in
// full for people who cannot use it: publishing is admin-only (plan §7.1), and
// a reviewer or editor still needs to see what reached the channel. It is also
// dark — no channel, no compliance audit — so the button is disabled with the
// reason under it and the description preview is the useful part today.

export type KitArtifactView = {
  kind: string;
  /** signed for an hour by the page; null when signing failed */
  url: string | null;
  /** the download name (docDownloadName), or null for a video */
  name: string | null;
  /** the video part (lesson.mp4 = 1); 1 for a document */
  part: number;
};
export type KitGenerationView = { gen: KitGenerationRow; job: JobRow | null; artifacts: KitArtifactView[] };
/** `publications` is what reached YouTube for THIS kit (0112
 *  topic_publications, this language) — empty until Phase 4 runs. */
export type KitView = {
  kit: TopicKit;
  generations: KitGenerationView[];
  publications: TopicPublication[];
  /** the topic's OTHER kits' publications — the older videos this kit's may supersede (0122) */
  otherPublications: TopicPublication[];
  /** the format the worker renders now, or null when it has not recorded one */
  videoFormat: VideoFormatSetting | null;
};

/** The kit's actions and the publish action share one busy / error / notice
 *  surface, so `route` picks which handler the payload goes to. */
type Post = (payload: Record<string, unknown>, label: string, route?: "kit" | "publish" | "supersede") => Promise<Record<string, unknown> | null>;

function useKitPost(topicId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const post: Post = async (payload, label, route = "kit") => {
    setBusy(label);
    setError(null);
    setErrors([]);
    setNotice(null);
    const res = await fetch(`/api/library/topics/${topicId}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    setBusy(null);
    if (!res.ok) {
      setError((json.error as string) ?? "Something went wrong.");
      if (Array.isArray(json.errors)) setErrors(json.errors.filter((e): e is string => typeof e === "string"));
      return null;
    }
    router.refresh();
    return json;
  };
  const clear = () => {
    setError(null);
    setErrors([]);
    setNotice(null);
  };
  return { post, busy, error, errors, notice, setNotice, setErrors, clear };
}

function Messages({ error, errors, notice }: { error: string | null; errors: string[]; notice: string | null }) {
  return (
    <>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {errors.length > 1 && (
        <ul className="text-xs text-red-600 list-disc pl-5 space-y-0.5">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {notice && <p className="text-sm text-[#0F7A68]">{notice}</p>}
    </>
  );
}

const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

export function KitPanel({
  topicId,
  topicTitle,
  topicSummary,
  topicStatus,
  bankMaturity,
  curriculumHeader,
  headerMappings,
  topicSubject,
  auditPassed,
  articleStatus,
  articleStatuses,
  kits,
  names,
  canGenerate,
  canApprove,
  canPublish: canPublishRole,
  generateEnabled,
  publishEnabled,
  ownerConfigured,
  migrationNote,
}: {
  topicId: string;
  topicTitle: string;
  /** topics.summary — the first line of every YouTube description */
  topicSummary: string | null;
  topicStatus: string;
  /** topics.bank_maturity — 'none' blocks publishing (canPublish) */
  bankMaturity: string | null;
  /** the same header lines the catalogue documents carry, for the description
   *  preview (curriculumHeaderLines, composed on the server) */
  curriculumHeader: string[];
  /** the curriculum mappings the header was composed from — the title's
   *  audience block and the hashtags read the boards off them */
  headerMappings: HeaderMapping[];
  /** topics.subject — the audience tag's last word */
  topicSubject: string | null;
  /** YOUTUBE_COMPLIANCE_AUDIT_PASSED on the app: public/unlisted allowed, public the default */
  auditPassed: boolean;
  /** the approved English article's status, or null when there is none */
  articleStatus: string | null;
  /** every article version's status by id — a kit whose own article is no
   *  longer the approved version is not approved (kitAcceptsApprove) */
  articleStatuses: Record<string, string>;
  /** newest first */
  kits: KitView[];
  names: Record<string, string>;
  canGenerate: boolean;
  canApprove: boolean;
  /** the `publish` action — admins only (plan §7.1) */
  canPublish: boolean;
  generateEnabled: boolean;
  publishEnabled: boolean;
  ownerConfigured: boolean;
  migrationNote: string | null;
}) {
  const { post, busy, error, errors, notice, setNotice, setErrors, clear } = useKitPost(topicId);
  const current = kits[0] ?? null;
  const history = kits.slice(1);
  const liveKit = hasLiveKit(kits.map((k) => k.kit));
  const [avatar, setAvatar] = useState<TeacherAvatar>(nextTeacherAvatar(kits.map((k) => k.kit)));
  const personName = (id: string | null) => (id ? (names[id] ?? shortId(id)) : "—");

  // The two env locks read like the route's 409s so the member sees the same
  // sentence before and after the click.
  const lockWhy = !generateEnabled
    ? "Catalogue generation is switched off (FEATURE_CATALOGUE_GENERATE)."
    : !ownerConfigured
      ? "The catalogue owner is not configured (CATALOGUE_OWNER_ID)."
      : null;
  const accepts = kitAcceptsGenerate(topicStatus, articleStatus, liveKit);
  const generateWhy = lockWhy ?? (accepts.ok ? null : accepts.why);
  // Generate belongs to a topic that has no kit yet (or is back at
  // article_approved); a topic with a kit regenerates it from the kit.
  const showGenerate = canGenerate && (!current || topicStatus === "article_approved");

  const generate = async () => {
    if (!window.confirm(`Generate the kit with a ${avatar} teacher? Five pieces are queued for the worker's off-peak lane; the lesson plan follows the video.`)) return;
    const r = await post({ action: "generate", teacherAvatar: avatar }, "generate");
    if (r) setNotice(r.questionsJobExisting ? "Kit queued. The question bank was already being written." : "Kit queued — the worker builds it in its off-peak window; the question bank fills alongside.");
  };

  return (
    <div className="card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">
            Kit <span className="text-sm text-[#5B6470] font-normal">({kits.length} {kits.length === 1 ? "build" : "builds"})</span>
          </h2>
          <p className="text-xs text-[#5B6470] mt-1">
            The video lesson, slide deck, lesson plan, activities, case study and worksheet generated from the <span className="font-medium">approved</span> article.
            Approving the video is a named reviewer&apos;s act (gate 2) and is recorded; nothing reaches YouTube before it.
          </p>
        </div>
        {showGenerate && (
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className="flex items-center gap-3 text-sm">
              <fieldset className="flex items-center gap-2" aria-label="Teacher avatar">
                {(["female", "male"] as TeacherAvatar[]).map((g) => (
                  <label key={g} className="inline-flex items-center gap-1 text-xs">
                    <input type="radio" name="teacher-avatar" value={g} checked={avatar === g} onChange={() => setAvatar(g)} disabled={!!busy || !!generateWhy} />
                    {g} teacher
                  </label>
                ))}
              </fieldset>
              <button type="button" disabled={!!busy || !!generateWhy} title={generateWhy ?? undefined} onClick={generate} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
                {busy === "generate" ? "Queuing…" : "Generate kit"}
              </button>
            </div>
            <span className="text-xs text-[#98A0A9]">
              Default alternates with the previous kit&apos;s teacher; the student speaks in the other voice.
            </span>
            {generateWhy && <span className="text-xs text-[#9A6400] max-w-md text-right">{generateWhy}</span>}
          </div>
        )}
      </div>

      {migrationNote && <p className="text-xs text-[#9A6400] bg-[#FFF9EE] rounded-lg px-3 py-2">{migrationNote}</p>}

      {!current ? (
        <p className="text-sm text-[#98A0A9]">No kit yet.</p>
      ) : (
        <CurrentKit
          key={current.kit.id}
          view={current}
          topicTitle={topicTitle}
          topicSummary={topicSummary}
          topicStatus={topicStatus}
          bankMaturity={bankMaturity}
          curriculumHeader={curriculumHeader}
          headerMappings={headerMappings}
          topicSubject={topicSubject}
          auditPassed={auditPassed}
          kitArticleStatus={articleStatuses[current.kit.article_id] ?? null}
          liveKit={liveKit}
          canGenerate={canGenerate}
          canApprove={canApprove}
          canPublish={canPublishRole}
          publishEnabled={publishEnabled}
          lockWhy={lockWhy}
          busy={busy}
          post={post}
          setNotice={setNotice}
          setErrors={setErrors}
          clear={clear}
          personName={personName}
        />
      )}

      {history.length > 0 && (
        <details className="rounded-lg border border-[#EEF0EC] p-3">
          <summary className="text-sm cursor-pointer">
            Earlier kits <span className="text-xs text-[#5B6470]">({history.length})</span>
          </summary>
          <ul className="mt-2 divide-y divide-[#EEF0EC] text-sm">
            {history.map(({ kit, generations }) => (
              <li key={kit.id} className="py-2 flex flex-wrap items-center gap-2">
                <KitStatusChip status={kit.status} label={kit.status === "rejected" && kit.reject_reason ? `rejected · ${KIT_REJECT_REASON_LABEL[kit.reject_reason]}` : undefined} />
                <span className="text-xs text-[#5B6470]">
                  {kit.teacher_avatar ?? "—"} teacher · {kitProgress(generations.map((g) => g.gen)).label} · {fmtDate(kit.created_at)}
                  {kit.reviewed_at && (
                    <>
                      {" "}
                      · reviewed by {personName(kit.reviewer_id)} {fmtDate(kit.reviewed_at)}
                    </>
                  )}
                </span>
                {kit.notes && (
                  <span className="text-xs text-[#5B6470] basis-full truncate" title={kit.notes}>
                    {kit.notes}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <Messages error={error} errors={errors} notice={notice} />
    </div>
  );
}

// ── The current kit ─────────────────────────────────────────────────────────

function CurrentKit({
  view,
  topicTitle,
  topicSummary,
  topicStatus,
  bankMaturity,
  curriculumHeader,
  headerMappings,
  topicSubject,
  auditPassed,
  kitArticleStatus,
  liveKit,
  canGenerate,
  canApprove,
  canPublish: canPublishRole,
  publishEnabled,
  lockWhy,
  busy,
  post,
  setNotice,
  setErrors,
  clear,
  personName,
}: {
  view: KitView;
  topicTitle: string;
  topicSummary: string | null;
  topicStatus: string;
  bankMaturity: string | null;
  curriculumHeader: string[];
  headerMappings: HeaderMapping[];
  topicSubject: string | null;
  auditPassed: boolean;
  /** the status of THIS kit's article version (null when it is gone) */
  kitArticleStatus: string | null;
  liveKit: boolean;
  canGenerate: boolean;
  canApprove: boolean;
  canPublish: boolean;
  publishEnabled: boolean;
  lockWhy: string | null;
  busy: string | null;
  post: Post;
  setNotice: (v: string | null) => void;
  setErrors: (v: string[]) => void;
  clear: () => void;
  personName: (id: string | null) => string;
}) {
  const { kit, generations } = view;
  const [reason, setReason] = useState<KitRejectReason | "">("");
  const [notes, setNotes] = useState("");
  const byId = new Map(generations.map((g) => [g.gen.id, g]));
  const progress = kitProgress(generations.map((g) => g.gen));
  const videos = generations
    .filter((g) => g.gen.kind === "presentation")
    .flatMap((g) => g.artifacts.filter((a) => a.kind === "video_mp4"))
    .sort((a, b) => a.part - b.part);
  const chapters = chaptersByPart(kit.chapters);
  const regen = kitAcceptsRegenerate(topicStatus, kit.status, liveKit);
  const regenWhy = lockWhy ?? (regen.ok ? null : regen.why);
  // The review box shows for a reviewable KIT status; the buttons themselves
  // follow the three-way agreement the RPCs enforce (kit, topic, article), so
  // a reviewer reads the reason here instead of the RPC's 409.
  const showReview = canApprove && (canApproveKit(kit.status) || canRejectKit(kit.status));
  const approveOk = kitAcceptsApprove(topicStatus, kit.status, kitArticleStatus);
  const rejectOk = kitAcceptsReject(topicStatus, kit.status);
  const approveWhy = approveOk.ok ? null : approveOk.why;
  const rejectWhy = rejectOk.ok ? null : rejectOk.why;

  const retry = async (kind: KitKind) => {
    const r = await post({ action: "retry", kitId: kit.id, kind }, `retry:${kind}`);
    if (r) setNotice(`${KIT_KIND_LABEL[kind]} queued again.`);
  };
  const regenerate = async () => {
    if (!window.confirm("Regenerate the kit? A new kit is queued with this kit's teacher; this one stays in the history and the topic goes back to generating.")) return;
    const r = await post({ action: "regenerate", kitId: kit.id }, "regenerate");
    if (r) setNotice("New kit queued — this one is kept as history.");
  };
  const approve = async () => {
    if (!window.confirm("Approve the video? This records your approval and moves the topic to video approved — the publish step comes next.")) return;
    const r = await post({ action: "approve", kitId: kit.id, notes: notes.trim() || undefined }, "approve");
    if (r) {
      setNotes("");
      setNotice("Video approved — the topic is now video approved.");
    }
  };
  const reject = async () => {
    if (!reason || !notes.trim()) return;
    if (!window.confirm(kit.status === "approved" ? "Pull this approval? The kit becomes rejected and the topic goes back to in review." : "Reject this kit? It stays in the history as rejected.")) return;
    const r = await post({ action: "reject", kitId: kit.id, reason, notes: notes.trim() }, "reject");
    if (r) {
      setNotes("");
      setReason("");
      setNotice("Kit rejected — regenerate it once the cause is fixed.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Current kit</span>
        <KitStatusChip status={kit.status} label={kit.status === "rejected" && kit.reject_reason ? `rejected · ${KIT_REJECT_REASON_LABEL[kit.reject_reason]}` : undefined} />
        <span className="text-xs text-[#5B6470]">
          {kit.teacher_avatar ?? "—"} teacher
          {kit.voice_pair && (
            <>
              {" "}
              (<span className="font-mono">{kit.voice_pair.teacher}</span> · student <span className="font-mono">{kit.voice_pair.student}</span>)
            </>
          )}{" "}
          · {progress.label} · {fmtDate(kit.created_at)}
          {kit.reviewed_at && (
            <>
              {" "}
              · reviewed by {personName(kit.reviewer_id)} {fmtDate(kit.reviewed_at)}
            </>
          )}
        </span>
        {canGenerate && (
          <span className="ml-auto flex items-center gap-2">
            <button type="button" disabled={!!busy || !!regenWhy} title={regenWhy ?? undefined} onClick={regenerate} className="btn-ghost h-8 px-3 text-xs disabled:opacity-50">
              {busy === "regenerate" ? "Queuing…" : "Regenerate kit"}
            </button>
          </span>
        )}
      </div>
      {kit.notes && (
        <p className="text-xs text-[#5B6470] whitespace-pre-wrap">
          <span className="font-medium">Review notes:</span> {kit.notes}
        </p>
      )}
      {kit.status === "failed" && <p className="text-xs text-[#B3401F]">A piece failed. Retry it below; the kit goes back to generating and the worker picks it up in its window.</p>}
      {kit.status === "generating" && (
        <p className="text-xs text-[#5B6470]">
          Built by the worker in its off-peak window only (never while a teacher&apos;s lesson is queued). The lesson plan is added after the video finishes, because it cites the clips.
        </p>
      )}

      {/* ── pieces ── */}
      <div className="overflow-x-auto rounded-lg border border-[#EEF0EC]">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[#5B6470] border-b border-[#EEF0EC]">
            <tr>
              <th className="px-3 py-2 font-medium">Piece</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Worker</th>
              <th className="px-3 py-2 font-medium">Files</th>
              <th className="px-3 py-2 font-medium text-right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EEF0EC]">
            {KIT_KINDS.map((kind) => {
              const genId = kitGenerationIdFor(kit, kind);
              const g = genId ? (byId.get(genId) ?? null) : null;
              const docs = g ? g.artifacts.filter((a) => a.kind !== "video_mp4" && a.kind !== "script_json") : [];
              return (
                <tr key={kind}>
                  <td className="px-3 py-2">
                    {KIT_KIND_LABEL[kind]}
                    {g?.gen.title && <span className="block text-xs text-[#98A0A9] truncate max-w-xs">{g.gen.title}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {g ? (
                      <GenStatusChip status={g.gen.status} />
                    ) : (
                      <span className="text-xs text-[#98A0A9]">{kind === "lesson_plan" ? (kit.status === "generating" ? "after the video" : "not made") : "—"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <JobLine job={g?.job ?? null} />
                  </td>
                  <td className="px-3 py-2">
                    {kind === "presentation" ? (
                      videos.length ? <span className="text-xs text-[#5B6470]">{videos.length} video part{videos.length === 1 ? "" : "s"} below</span> : <span className="text-xs text-[#98A0A9]">—</span>
                    ) : docs.length ? (
                      <span className="flex flex-wrap gap-2">
                        {docs.map((a) =>
                          a.url ? (
                            <a key={a.kind} href={a.url} className="text-xs underline text-[#1F5B99]" download={a.name ?? undefined}>
                              {a.name ?? a.kind}
                            </a>
                          ) : (
                            <span key={a.kind} className="text-xs text-[#98A0A9]">
                              {a.name ?? a.kind} (not signed)
                            </span>
                          ),
                        )}
                      </span>
                    ) : (
                      <span className="text-xs text-[#98A0A9]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canGenerate && g && g.gen.status === "error" && canRetryKit(kit.status) && (
                      <button type="button" disabled={!!busy || !!lockWhy} title={lockWhy ?? undefined} onClick={() => retry(kind)} className="btn-ghost h-8 px-3 text-xs disabled:opacity-50">
                        {busy === `retry:${kind}` ? "Queuing…" : "Retry"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── video parts + chapters ── */}
      {videos.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {videos.map((v) => (
            <div key={`${v.part}-${v.url ?? ""}`} className="space-y-2">
              <p className="text-sm font-medium">
                Part {v.part}
                {kit.part_plan.find((p) => p.part === v.part) && (
                  <span className="text-xs text-[#5B6470] font-normal"> · {kit.part_plan.find((p) => p.part === v.part)!.minutes} min</span>
                )}
              </p>
              {v.url ? (
                <video
                  controls
                  preload="metadata"
                  src={v.url}
                  controlsList="nodownload"
                  disablePictureInPicture
                  disableRemotePlayback
                  onContextMenu={(e) => e.preventDefault()}
                  className="w-full rounded-lg bg-black aspect-video"
                />
              ) : (
                <p className="text-xs text-[#98A0A9]">Could not sign the video URL.</p>
              )}
              {(chapters.get(v.part) ?? []).length > 0 && (
                <ol className="text-xs text-[#5B6470] space-y-0.5">
                  {chapters.get(v.part)!.map((c, i) => (
                    <li key={i}>
                      <span className="font-mono tabular">{fmtTimestamp(c.t)}</span> {c.label}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── part plan ── */}
      {kit.part_plan.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-1">Part plan</h3>
          <ul className="text-xs text-[#5B6470] space-y-0.5">
            {kit.part_plan.map((p) => (
              <li key={p.part}>
                <span className="font-medium">Part {p.part}</span> · {p.minutes} min · {p.sections.join(", ") || "—"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── clips ── */}
      <ClipEditor
        kit={kit}
        editable={canGenerate && canEditClips(kit.status)}
        busy={busy}
        onSave={async (clips) => {
          const r = await post({ action: "save_clips", kitId: kit.id, clips }, "clips");
          if (r) setNotice(`Saved ${clips.length} clip${clips.length === 1 ? "" : "s"}.`);
          return !!r;
        }}
        setErrors={setErrors}
        clear={clear}
      />

      {/* ── review ── */}
      {showReview && (
        <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-2">
          <p className="text-sm font-medium">Review</p>
          <p className="text-xs text-[#5B6470]">
            Watch every part and open every document. Approving records your name and moves the topic to video approved; rejecting needs a reason (it steers the regeneration) and notes.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select value={reason} onChange={(e) => setReason(e.target.value as KitRejectReason | "")} className="field h-9 px-2 text-sm" aria-label="Reject reason">
              <option value="">Reject reason…</option>
              {KIT_REJECT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {KIT_REJECT_REASON_LABEL[r]}
                </option>
              ))}
            </select>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} placeholder="Notes (required to reject; optional to approve)…" className="field flex-1 min-w-[16rem] px-3 py-2 text-sm" />
          </div>
          <div className="flex items-center gap-2">
            {canApproveKit(kit.status) && (
              <button type="button" disabled={!!busy || !!approveWhy} title={approveWhy ?? undefined} onClick={approve} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
                {busy === "approve" ? "Approving…" : "Approve video"}
              </button>
            )}
            {canRejectKit(kit.status) && (
              <button
                type="button"
                disabled={!!busy || !!rejectWhy || !reason || !notes.trim()}
                title={rejectWhy ?? (!reason ? "Pick a reason" : !notes.trim() ? "Notes are required" : undefined)}
                onClick={reject}
                className="btn-ghost h-9 px-4 text-sm disabled:opacity-50"
              >
                {busy === "reject" ? "Rejecting…" : kit.status === "approved" ? "Pull approval" : "Reject"}
              </button>
            )}
          </div>
          {(approveWhy || rejectWhy) && <p className="text-xs text-[#9A6400]">{approveWhy ?? rejectWhy}</p>}
        </div>
      )}
      {!canApprove && kit.status === "in_review" && <p className="text-xs text-[#9A6400]">Awaiting a reviewer&apos;s approval ({kitStatusLabel(kit.status)}).</p>}

      {/* ── publish (Phase 4) ── */}
      {kit.status === "approved" && (
        <PublishBlock
          kit={kit}
          publications={view.publications}
          otherPublications={view.otherPublications}
          videoFormat={view.videoFormat}
          topicTitle={topicTitle}
          topicSummary={topicSummary}
          topicStatus={topicStatus}
          bankMaturity={bankMaturity}
          curriculumHeader={curriculumHeader}
          headerMappings={headerMappings}
          topicSubject={topicSubject}
          auditPassed={auditPassed}
          thumbnails={view.generations.flatMap((g) => g.artifacts.filter((a) => a.kind === "thumbnail_png"))}
          kitArticleStatus={kitArticleStatus}
          canEditWords={canApprove}
          canPublish={canPublishRole}
          publishEnabled={publishEnabled}
          busy={busy}
          post={post}
          setNotice={setNotice}
        />
      )}
    </div>
  );
}

// ── Publish (Phase 4) ────────────────────────────────────────────────────────
// Shown only for an APPROVED kit, and shown to everyone who can see the kit —
// posting is admin-only, but a reviewer who approved the video should see
// whether it reached the channel, read what will be posted, and EDIT the
// words: the library is where everything that goes to YouTube is reviewed
// (founder, 2026-09-21) — the video above, and here the title, the
// description, the thumbnail card and the privacy — so that Post is the
// release, public directly once the compliance audit is through. The words
// (topic_kits.youtube_meta, 0121) are written by the worker from the
// narration when the video finishes and saved here through the kit route's
// save_youtube action; the title and description are COMPOSED from them by
// buildDescriptionPreview / publishTitle, which mirror the worker's
// composers, so the preview is the posting. Nothing here decides anything
// the route does not re-decide, and the worker decides a third time.

type WordsForm = { title: string; intro: string; terms: string; tags: string };

function wordsFormOf(meta: YouTubeMeta | null): WordsForm {
  return {
    title: meta?.title ?? "",
    intro: meta?.intro ?? "",
    terms: (meta?.key_terms ?? []).join(", "),
    tags: (meta?.hashtags ?? []).join(", "),
  };
}

function metaOfForm(f: WordsForm): YouTubeMeta {
  const list = (raw: string) =>
    raw
      .split(/[,\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  return { title: f.title.trim() || null, intro: f.intro.trim() || null, key_terms: list(f.terms), hashtags: list(f.tags) };
}

function PublishBlock({
  kit,
  publications,
  otherPublications,
  videoFormat,
  topicTitle,
  topicSummary,
  topicStatus,
  bankMaturity,
  curriculumHeader,
  headerMappings,
  topicSubject,
  auditPassed,
  thumbnails,
  kitArticleStatus,
  canEditWords,
  canPublish: canPublishRole,
  publishEnabled,
  busy,
  post,
  setNotice,
}: {
  kit: TopicKit;
  publications: TopicPublication[];
  otherPublications: TopicPublication[];
  videoFormat: VideoFormatSetting | null;
  topicTitle: string;
  topicSummary: string | null;
  topicStatus: string;
  bankMaturity: string | null;
  curriculumHeader: string[];
  headerMappings: HeaderMapping[];
  topicSubject: string | null;
  auditPassed: boolean;
  /** the thumbnail cards the worker stored with the video, one per part (signed) */
  thumbnails: KitArtifactView[];
  kitArticleStatus: string | null;
  /** may edit the title / intro / terms / tags (the `approve` action) */
  canEditWords: boolean;
  canPublish: boolean;
  publishEnabled: boolean;
  busy: string | null;
  post: Post;
  setNotice: (v: string | null) => void;
}) {
  const [privacy, setPrivacy] = useState<PublishPrivacy>(defaultPrivacy(auditPassed));
  const [form, setForm] = useState<WordsForm>(wordsFormOf(kit.youtube_meta));
  const [editing, setEditing] = useState(false);
  const summary = publicationSummary(publications, kit.part_plan.length);
  const action = publishActionFor(summary);
  const chapters = chaptersByPart(kit.chapters);
  // The parts to preview: the plan when the worker has written it, else the
  // parts that already have a publication row, else one.
  const partNumbers = summary.parts.length ? summary.parts.map((p) => p.part) : [1];
  // What the composers read: the saved words, or — while editing — the form.
  const meta: YouTubeMeta | null = editing ? metaOfForm(form) : kit.youtube_meta;
  const terms = effectiveTerms(meta, topicSummary);
  const audience = audienceTag(boardsOf(headerMappings), topicSubject);
  const titleFor = (p: number) => publishTitle(topicTitle, p, partNumbers.length, { meta, keyTerms: terms, audience });
  const thumbFor = (p: number) => thumbnails.find((t) => t.part === p) ?? null;
  const allowed = publishablePrivacies(auditPassed);

  // The disabled reason, in the order the route checks it, so the sentence on
  // the button is the sentence a click would have answered:
  //   1. the deployment (the flag) — the whole phase is dark
  //   2. the four refusals (kit, topic, article, bank)
  //   3. nothing left to do (every part already uploaded / nothing to retry)
  //   4. the privacy the operator picked
  const gate = canPublish(kit.status, topicStatus, kitArticleStatus, bankMaturity);
  const queue = canQueuePublish(action, summary);
  const priv = publishPrivacyAccepts(privacy, auditPassed);
  const why = !publishEnabled ? PUBLISH_OFF_NOTE : !gate.ok ? gate.why : !queue.ok ? queue.why : !priv.ok ? priv.why : editing ? "Save or discard the words first." : null;

  const publish = async () => {
    const what = privacy === "public" ? "PUBLIC — listed and searchable the moment the upload finishes" : privacy === "unlisted" ? "unlisted" : "private";
    if (
      !window.confirm(
        action === "retry"
          ? `Finish posting this kit? Parts already on YouTube are skipped; the rest go up ${what}, with the title, description, chapters, captions and thumbnail shown here.`
          : `Post this kit to YouTube ${what}, with the title, description, chapters, captions and thumbnail shown here?`,
      )
    )
      return;
    const r = await post({ action, kitId: kit.id, privacy }, "publish", "publish");
    if (r) setNotice(`Post queued — the worker uploads the parts in order (${privacy}) and records each one.`);
  };

  const saveWords = async () => {
    const m = metaOfForm(form);
    const r = await post({ action: "save_youtube", kitId: kit.id, title: m.title ?? "", intro: m.intro ?? "", key_terms: m.key_terms, hashtags: m.hashtags }, "save_youtube", "kit");
    if (r) {
      setEditing(false);
      setNotice("Words saved — the preview below is what will be posted.");
    }
  };

  const wordsSource = kit.youtube_meta?.source === "edited" ? "edited in the library" : kit.youtube_meta?.source === "generated" ? "written by the worker from the narration" : "defaults (nothing written yet)";

  // The video format (0122): which of this kit's posted parts predate the
  // format the worker renders now, and which older videos of the same part
  // (the topic's earlier kits) this kit's video may supersede. Both are facts
  // for the founder to act on by hand; nothing here is automatic.
  const currentFormat = videoFormat?.version ?? null;
  const candidates = supersedeCandidates(publications, otherPublications, kit.id);
  const supersede = async (c: (typeof candidates)[number]) => {
    const ok = canQueueSupersede(c.old, c.replacement);
    if (!ok.ok) {
      setNotice(ok.why);
      return;
    }
    if (
      !confirm(
        `Supersede the older part ${c.part} video (${c.old.youtube_video_id}) with this kit's (${c.replacement.youtube_video_id})?\n\n` +
          "The older video's description gets a first line pointing at the new one, and if it is public it becomes unlisted. Its views, likes and comments stay with it. Nothing is deleted.",
      )
    )
      return;
    const r = await post({ kitId: kit.id, oldPublicationId: c.old.id }, `supersede-${c.old.id}`, "supersede");
    if (r) setNotice("Supersede queued — the worker points the older video at this one and records it.");
  };

  return (
    <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Post to YouTube</h3>
        <span className="text-xs text-[#5B6470]">{summary.label}</span>
      </div>
      {!auditPassed && <p className="text-xs text-[#9A6400] bg-[#FFF9EE] rounded-lg px-3 py-2">{AUDIT_NOTE}</p>}

      {/* what is on the channel */}
      <div className="overflow-x-auto rounded-lg border border-[#EEF0EC]">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[#5B6470] border-b border-[#EEF0EC]">
            <tr>
              <th className="px-3 py-2 font-medium">Part</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Video</th>
              <th className="px-3 py-2 font-medium">Extras</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EEF0EC]">
            {summary.parts.length === 0 ? (
              <tr>
                <td className="px-3 py-2 text-xs text-[#98A0A9]" colSpan={4}>
                  Nothing posted yet.{!summary.known && " The part plan is not written, so the number of parts is not known here."}
                </td>
              </tr>
            ) : (
              summary.parts.map(({ part, row, state }) => (
                <tr key={part}>
                  <td className="px-3 py-2">{part}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${PUBLICATION_TONE[state]}`}>{PUBLICATION_LABEL[state]}</span>
                    {row?.error && (
                      <span className="block text-xs text-[#B3401F] max-w-xs truncate" title={row.error}>
                        {row.error}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row?.youtube_video_id ? (
                      <a
                        href={`https://www.youtube.com/watch?v=${row.youtube_video_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs underline text-[#1F5B99] font-mono"
                      >
                        {row.youtube_video_id}
                      </a>
                    ) : (
                      <span className="text-xs text-[#98A0A9]">—</span>
                    )}
                    {row && <span className="block text-xs text-[#98A0A9]">{row.privacy}</span>}
                    {row?.youtube_video_id && (() => {
                      const label = formatLabel(row, currentFormat);
                      const outdated = currentFormat !== null && formatVersionOf(row) < currentFormat && !row.superseded_by;
                      return (
                        <span className="block text-xs mt-0.5">
                          {row.superseded_by ? (
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 bg-[#EEF0EC] text-[#5B6470]" title={`Superseded ${row.superseded_at ? fmtDate(row.superseded_at) : ""}: the description points at the newer video`}>
                              superseded
                            </span>
                          ) : label ? (
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 ${outdated ? "bg-[#FFF3D6] text-[#9A6400]" : "bg-[#EEF0EC] text-[#5B6470]"}`}
                              title={outdated && videoFormat ? `Rendered before: ${changesSince(videoFormat, formatVersionOf(row)).join(" · ")}` : "Rendered with the current video format"}
                            >
                              {label}
                              {outdated ? " · update available" : ""}
                            </span>
                          ) : null}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2 text-xs text-[#5B6470]">
                    {row ? (
                      <>
                        {row.captions_uploaded?.length ? `captions: ${row.captions_uploaded.join(", ")}` : "no captions"}
                        {" · "}
                        {row.thumbnail_set ? "thumbnail set" : "no thumbnail"}
                        {row.playlist_ids?.length ? ` · ${row.playlist_ids.length} playlist${row.playlist_ids.length === 1 ? "" : "s"}` : ""}
                        {row.published_at ? ` · ${fmtDate(row.published_at)}` : ""}
                      </>
                    ) : (
                      <span className="text-[#98A0A9]">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* supersede (0122): this kit's posted parts against the topic's older videos */}
      {candidates.length > 0 && (
        <div className="rounded-lg border border-[#F5E3B8] bg-[#FFF9EE] p-3 space-y-2">
          <p className="text-sm font-medium">Older videos of this lesson are still on the channel</p>
          <p className="text-xs text-[#5B6470]">
            A YouTube video&apos;s file cannot be replaced, so this kit&apos;s video is a new upload. Supersede points an older video at it (a first line in its description) and makes a public one unlisted; its views and likes stay with it, nothing is deleted. Your call, video by video.
          </p>
          <ul className="space-y-1">
            {candidates.map((c) => (
              <li key={c.old.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span>
                  Part {c.part}: <span className="font-mono">{c.old.youtube_video_id}</span> ({c.old.privacy}
                  {c.old.published_at ? `, posted ${fmtDate(c.old.published_at)}` : ""}, {formatLabel(c.old, currentFormat) ?? "format unknown"})
                </span>
                {canPublishRole ? (
                  <button type="button" className="btn-ghost h-7 px-2 text-xs" disabled={!!busy} onClick={() => supersede(c)}>
                    Supersede with this kit&apos;s part {c.part}
                  </button>
                ) : (
                  <span className="text-[#98A0A9]">admins supersede</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* the words: title, hook, key terms, hashtags */}
      <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">
            The words <span className="text-xs font-normal text-[#5B6470]">({wordsSource})</span>
          </p>
          {canEditWords && !editing && (
            <button type="button" className="btn-ghost h-8 px-3 text-xs" disabled={!!busy} onClick={() => { setForm(wordsFormOf(kit.youtube_meta)); setEditing(true); }}>
              Edit
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <label className="block text-xs text-[#5B6470]">
              Title <span className="text-[#98A0A9]">({form.title.trim().length}/{TITLE_MAX}; blank = composed from the topic, the key terms and &ldquo;{audience || "the subject"}&rdquo;)</span>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={TITLE_MAX} className="field mt-1 w-full h-9 px-2 text-sm" placeholder={titleFor(1)} />
            </label>
            <label className="block text-xs text-[#5B6470]">
              Opening paragraph <span className="text-[#98A0A9]">({form.intro.trim().length}/{INTRO_MAX}; blank = the topic summary)</span>
              <textarea value={form.intro} onChange={(e) => setForm({ ...form, intro: e.target.value })} maxLength={INTRO_MAX} rows={4} className="field mt-1 w-full px-2 py-1 text-sm" />
            </label>
            <label className="block text-xs text-[#5B6470]">
              Key terms <span className="text-[#98A0A9]">(comma-separated; the first three go into the title)</span>
              <input value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} className="field mt-1 w-full h-9 px-2 text-sm" />
            </label>
            <label className="block text-xs text-[#5B6470]">
              Hashtags <span className="text-[#98A0A9]">(comma-separated, without #)</span>
              <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} className="field mt-1 w-full h-9 px-2 text-sm" />
            </label>
            <div className="flex items-center gap-2">
              <button type="button" className="btn-primary h-8 px-3 text-xs disabled:opacity-50" disabled={!!busy} onClick={saveWords}>
                {busy === "save_youtube" ? "Saving…" : "Save words"}
              </button>
              <button type="button" className="btn-ghost h-8 px-3 text-xs" disabled={!!busy} onClick={() => { setEditing(false); setForm(wordsFormOf(kit.youtube_meta)); }}>
                Discard
              </button>
              {summary.published > 0 && <span className="text-xs text-[#9A6400]">Parts already on YouTube keep the words they went up with.</span>}
            </div>
          </div>
        ) : (
          <p className="text-xs text-[#5B6470]">
            {kit.youtube_meta ? "Title, opening paragraph, key terms and hashtags as they will be composed below." : "Nothing written for this kit yet — the preview uses the topic summary and the curriculum mapping."}
          </p>
        )}
      </div>

      {/* what will be posted, per part: thumbnail, title, description */}
      <div className="rounded-lg border border-[#EEF0EC] p-3">
        <p className="text-sm font-medium mb-2">
          What will be posted <span className="text-xs font-normal text-[#5B6470]">(thumbnail, title and description per part — exactly as the worker composes them)</span>
        </p>
        <div className="space-y-4">
          {partNumbers.map((p) => {
            const thumb = thumbFor(p);
            return (
              <div key={p} className="grid gap-3 md:grid-cols-[240px_1fr]">
                <div>
                  {thumb?.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb.url} alt={`Thumbnail for part ${p}`} className="w-full rounded-lg border border-[#E6E8E4]" />
                  ) : (
                    <div className="w-full aspect-video rounded-lg border border-dashed border-[#E6E8E4] flex items-center justify-center text-xs text-[#98A0A9] text-center px-2">
                      No stored thumbnail — the worker draws one at post time.
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium break-words">{titleFor(p)}</p>
                  <p className="text-[11px] text-[#98A0A9]">{titleFor(p).length}/{TITLE_MAX} characters</p>
                  <pre className="mt-1 text-xs text-[#5B6470] whitespace-pre-wrap font-sans">
                    {buildDescriptionPreview({
                      topicTitle,
                      summary: topicSummary,
                      subject: topicSubject,
                      curriculumHeader,
                      mappings: headerMappings,
                      meta,
                      chapters: chapters.get(p) ?? [],
                      part: p,
                      parts: partNumbers.length,
                    })}
                  </pre>
                  {(chapters.get(p) ?? []).length > 0 && chapterCountWarning(chapters.get(p)!.length)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {canPublishRole ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as PublishPrivacy)}
            className="field h-9 px-2 text-sm"
            aria-label="Privacy"
            disabled={!!busy}
          >
            {PRIVACY.map((p) => (
              <option key={p} value={p} disabled={!(allowed as readonly string[]).includes(p)}>
                {PRIVACY_LABEL[p]}
                {(allowed as readonly string[]).includes(p) ? "" : " — needs the compliance audit"}
              </option>
            ))}
          </select>
          <button type="button" disabled={!!busy || !!why} title={why ?? undefined} onClick={publish} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
            {busy === "publish" ? "Queuing…" : action === "retry" ? "Finish posting" : privacy === "public" ? "Post to YouTube (public)" : `Post to YouTube (${privacy})`}
          </button>
        </div>
      ) : (
        <p className="text-xs text-[#98A0A9]">Posting is a platform admin&apos;s action; this is the state and what would be posted.</p>
      )}
      {canPublishRole && why && <p className="text-xs text-[#9A6400]">{why}</p>}
    </div>
  );
}

const PUBLICATION_TONE: Record<"published" | "failed" | "waiting", string> = {
  published: "bg-[#E6F6F2] text-[#0F7A68]",
  failed: "bg-[#FFE9E3] text-[#B3401F]",
  waiting: "bg-[#EEF0EC] text-[#5B6470]",
};

const PUBLICATION_LABEL: Record<"published" | "failed" | "waiting", string> = {
  published: "published",
  failed: "failed",
  waiting: "not yet",
};

/** YouTube only reads a timestamp list as chapters with three or more marks
 *  starting at 0:00; below that the block is dropped rather than posted
 *  broken, and the reviewer should know why the preview has none. */
function chapterCountWarning(count: number) {
  if (count >= 3) return null;
  return <p className="text-xs text-[#9A6400]">Only {count} chapter mark{count === 1 ? "" : "s"} — YouTube needs three from 0:00, so no timestamp block is posted for this part.</p>;
}

/** One generation's worker job: progress + stage while live, the error when it failed. */
function JobLine({ job }: { job: JobRow | null }) {
  if (!job) return <span className="text-xs text-[#98A0A9]">—</span>;
  const live = isLiveJobStatus(job.status);
  const stage = live ? stageLabel(job.stage) : null;
  return (
    <span className="inline-flex flex-col gap-0.5 text-xs text-[#5B6470]">
      <span>
        {job.status === "processing" && job.progress != null ? `${Math.round(job.progress)}%` : job.status}
        {stage && <> · {stage}</>}
      </span>
      {job.error && (
        <span className="text-[#B3401F] max-w-xs truncate" title={job.error}>
          {job.error}
        </span>
      )}
    </span>
  );
}

// ── Clips ────────────────────────────────────────────────────────────────────

type ClipDraft = { part: string; start: string; end: string; label: string; purpose: string };

const draftOf = (c: ClipRow): ClipDraft => ({ part: String(c.part), start: fmtTimestamp(c.start), end: fmtTimestamp(c.end), label: c.label, purpose: c.purpose ?? "" });

function ClipEditor({
  kit,
  editable,
  busy,
  onSave,
  setErrors,
  clear,
}: {
  kit: TopicKit;
  editable: boolean;
  busy: string | null;
  onSave: (clips: ClipRow[]) => Promise<boolean>;
  setErrors: (v: string[]) => void;
  clear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<ClipDraft[]>(kit.clips.map(draftOf));
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const parts = kit.part_plan.map((p) => p.part);

  const save = async () => {
    // validateClips runs in the browser first so every problem shows before
    // the round trip; the route runs the same validator again.
    const v = validateClips(rows, partDurationsOf(kit.part_plan));
    if (!v.ok) {
      setLocalErrors(v.errors);
      return;
    }
    setLocalErrors([]);
    const ok = await onSave(v.clips);
    if (ok) setEditing(false);
  };
  const update = (i: number, patch: Partial<ClipDraft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  if (!editing) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-sm font-medium">Clips</h3>
          <span className="text-xs text-[#5B6470]">for the lesson plan&apos;s micro-clip mode and the YouTube description</span>
          {editable && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => {
                clear();
                setRows(kit.clips.map(draftOf));
                setLocalErrors([]);
                setEditing(true);
              }}
              className="btn-ghost h-8 px-3 text-xs ml-auto"
            >
              Edit clips
            </button>
          )}
        </div>
        {kit.clips.length === 0 ? (
          <p className="text-xs text-[#98A0A9]">{kit.status === "generating" ? "Written by the worker when the video finishes." : "No clips."}</p>
        ) : (
          <ul className="text-xs text-[#5B6470] space-y-0.5">
            {kit.clips.map((c, i) => (
              <li key={i}>
                Part {c.part} <span className="font-mono tabular">{fmtTimestamp(c.start)}–{fmtTimestamp(c.end)}</span> · {c.label}
                {c.purpose && <span className="text-[#98A0A9]"> — {c.purpose}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Clips</h3>
        <span className="text-xs text-[#5B6470]">mm:ss inside one part · 30 s to 10 min · label up to 80 characters</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-[#5B6470]">
            <tr>
              <th className="px-1 py-1 font-medium">Part</th>
              <th className="px-1 py-1 font-medium">Start</th>
              <th className="px-1 py-1 font-medium">End</th>
              <th className="px-1 py-1 font-medium">Label</th>
              <th className="px-1 py-1 font-medium">Purpose</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="px-1 py-1">
                  {parts.length ? (
                    <select value={r.part} onChange={(e) => update(i, { part: e.target.value })} className="field h-8 px-1">
                      {parts.map((p) => (
                        <option key={p} value={String(p)}>
                          {p}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input value={r.part} onChange={(e) => update(i, { part: e.target.value })} className="field h-8 w-12 px-1" inputMode="numeric" />
                  )}
                </td>
                <td className="px-1 py-1">
                  <input value={r.start} onChange={(e) => update(i, { start: e.target.value })} className="field h-8 w-16 px-1 font-mono" placeholder="m:ss" />
                </td>
                <td className="px-1 py-1">
                  <input value={r.end} onChange={(e) => update(i, { end: e.target.value })} className="field h-8 w-16 px-1 font-mono" placeholder="m:ss" />
                </td>
                <td className="px-1 py-1">
                  <input value={r.label} onChange={(e) => update(i, { label: e.target.value })} maxLength={80} className="field h-8 w-full min-w-[10rem] px-2" />
                </td>
                <td className="px-1 py-1">
                  <input value={r.purpose} onChange={(e) => update(i, { purpose: e.target.value })} maxLength={200} className="field h-8 w-full min-w-[10rem] px-2" placeholder="optional" />
                </td>
                <td className="px-1 py-1 text-right">
                  <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-[#B3401F] hover:underline" aria-label={`Remove clip ${i + 1}`}>
                    remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={rows.length >= 12}
          onClick={() => setRows([...rows, { part: String(parts[0] ?? 1), start: "0:00", end: "2:00", label: "", purpose: "" }])}
          className="btn-ghost h-8 px-3 text-xs disabled:opacity-50"
        >
          + Add clip
        </button>
        <span className="ml-auto flex items-center gap-2">
          <button type="button" disabled={!!busy} onClick={save} className="btn-primary h-8 px-3 text-xs disabled:opacity-50">
            {busy === "clips" ? "Saving…" : "Save clips"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setLocalErrors([]);
              setErrors([]);
            }}
            className="btn-ghost h-8 px-3 text-xs"
          >
            Cancel
          </button>
        </span>
      </div>
      {localErrors.length > 0 && (
        <ul className="text-xs text-red-600 list-disc pl-5 space-y-0.5">
          {localErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
