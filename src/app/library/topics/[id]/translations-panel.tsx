"use client";

import { useState } from "react";
import Link from "next/link";
import { LANGUAGES, languageLabel } from "@/utils/narration";
import {
  KIT_KINDS,
  KIT_KIND_LABEL,
  KIT_REJECT_REASONS,
  KIT_REJECT_REASON_LABEL,
  canApproveKit,
  canRejectKit,
  kitGenerationIdFor,
  translationAcceptsApprove,
  translationAcceptsReject,
} from "@/utils/catalogue/kit";
import { isLiveJobStatus } from "@/utils/catalogue/status";
import { blockingCount, flagCount } from "@/utils/catalogue/review-queue";
import { AUDIT_NOTE, PRIVACY, PRIVACY_LABEL, PUBLISH_OFF_NOTE, REWORDS_ACTION, canPublish as publishGate, canQueuePublish, canQueueRewords, defaultPrivacy, metaInLanguage, publicationSummary, publishActionFor, publishPrivacyAccepts, publishablePrivacies, rewordsOffered } from "@/utils/catalogue/publish";
import type { KitRejectReason, PrecheckReport, PublishPrivacy, TopicKit, TopicPublication } from "@/utils/catalogue/types";
import { GenStatusChip, KitStatusChip, fmtDate } from "../../catalogue-ui";
import { JobLine, VideoParts, useKitPost, type KitView, type Post } from "./kit-panel";
import type { JobRow } from "./article-panel";

// The topic page's Translations section (Kit Translator, plan revision 3, T0
// — 2026-10-16). Every kit of this topic in a language other than English,
// newest first — ONE ROW PER LANGUAGE in the same shape as the English kit
// (layout D, 2026-10-17): the row says the language, the kit's status and the
// translation's own (staged → in review → approved | stale | blocked |
// failed), the pre-check verdict (check A before the render, check C after)
// with its flag count, and the date; it unfolds to the pieces the translate
// job rebuilt with the worker's job line per piece, the documents, the review
// box and the video parts. "Review at the top" selects the translation for
// the page's own review header (?lang=). "Translate into …" queues ONE
// kit_translate job for the topic's approved English kit (the route refuses
// a second live one). Approve / Reject post the kit route's actions:
// approve_topic_kit's translation branch promotes the staged article and
// items and marks the previous translation stale; reject retires them. The
// topic is never moved. An APPROVED translation carries "Post to YouTube"
// (app PR #88): the publish route accepts a kit whose translation_status is
// approved and the worker posts the video in the kit's language, on the
// language's channel when one is configured, else on the English channel —
// so a translation's publications are read by kit id, whatever channel
// carried them. Posting stays a platform admin's action (libraryAllows
// "publish"), the same gate as the English kit's publish block.

export type TranslateJobRow = JobRow & { params: Record<string, unknown> };

const TARGETS = LANGUAGES.filter((l) => l.value !== "en");

const TRANSLATION_TONE: Record<string, string> = {
  staged: "bg-[#EEF0EC] text-[#5B6470]",
  in_review: "bg-[#FFF4DB] text-[#8A5A00]",
  approved: "bg-[#E6F4EA] text-[#1E6B3A]",
  stale: "bg-[#FFF4DB] text-[#8A5A00]",
  blocked: "bg-[#FDECEA] text-[#B3401F]",
  failed: "bg-[#FDECEA] text-[#B3401F]",
};

export function TranslationChip({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${TRANSLATION_TONE[status] ?? "bg-[#EEF0EC] text-[#5B6470]"}`}>{status.replace(/_/g, " ")}</span>;
}

/** The pre-check verdict in one or two short lines: check A (the translation
 *  against the English, before the render) and check C (the rendered timing). */
export function PrecheckLine({ report }: { report: PrecheckReport | null | undefined }) {
  if (!report) return <span className="text-xs text-[#98A0A9]">not checked yet</span>;
  const blocking = report.blocking?.length ?? 0;
  const flags = report.flags?.length ?? 0;
  const post = report.post_render;
  return (
    <span className="inline-flex flex-col gap-0.5 text-xs">
      <span className={blocking ? "text-[#B3401F]" : "text-[#1E6B3A]"}>
        check A: {blocking ? `${blocking} blocking` : "passed"}
        {flags ? ` · ${flags} flag${flags === 1 ? "" : "s"}` : ""}
      </span>
      {post && (
        <span className={post.ok ? "text-[#5B6470]" : "text-[#B3401F]"}>
          check C: {post.ok ? "passed" : `${post.blocking?.length ?? 0} blocking`}
          {post.flags?.length ? ` · ${post.flags.length} flag${post.flags.length === 1 ? "" : "s"}` : ""}
        </span>
      )}
    </span>
  );
}

/** Every finding of both checks, blocking first. */
export function Findings({ report, open = false }: { report: PrecheckReport | null | undefined; open?: boolean }) {
  if (!report) return null;
  const items = [
    ...(report.blocking ?? []).map((f) => ({ ...f, level: "blocks" })),
    ...(report.flags ?? []).map((f) => ({ ...f, level: "flag" })),
    ...(report.post_render?.blocking ?? []).map((f) => ({ ...f, level: "blocks" })),
    ...(report.post_render?.flags ?? []).map((f) => ({ ...f, level: "flag" })),
  ];
  if (!items.length) return null;
  const list = (
    <ul className="mt-1 space-y-0.5 max-h-64 overflow-y-auto text-xs text-[#5B6470]">
      {items.slice(0, 60).map((f, i) => (
        <li key={i}>
          <span className={f.level === "blocks" ? "text-[#B3401F]" : "text-[#8A5A00]"}>{f.level}</span> · <span className="font-mono">{String(f.where)}</span> · {String(f.what)}
          {"detail" in f && f.detail ? <span className="text-[#98A0A9]"> — {typeof f.detail === "string" ? f.detail : JSON.stringify(f.detail).slice(0, 80)}</span> : null}
        </li>
      ))}
    </ul>
  );
  if (open) return list;
  return (
    <details className="text-xs text-[#5B6470]">
      <summary className="cursor-pointer">
        {items.length} finding{items.length === 1 ? "" : "s"}
      </summary>
      {list}
    </details>
  );
}

/** Approve / Reject (reason + notes) for ONE translation kit, posting the kit
 *  route's actions. The article's own status is verified by the route and
 *  the RPC (it must be the staged translated version); here the kit and the
 *  topic decide whether the buttons are offered. Rendered by the review inbox
 *  under the video, and inside each language's folded row. */
export function TranslationReviewBox({ kit, topicStatus, canApprove, post, busy, setNotice }: { kit: TopicKit; topicStatus: string; canApprove: boolean; post: Post; busy: string | null; setNotice: (s: string | null) => void }) {
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState<KitRejectReason | "">("translation");
  const approveOk = translationAcceptsApprove(kit.status, kit.translation_status, "staged", topicStatus);
  const rejectOk = translationAcceptsReject(kit.status);
  const label = languageLabel(kit.language) ?? kit.language;
  if (!canApprove || !(canApproveKit(kit.status) || canRejectKit(kit.status))) return null;

  const approve = async () => {
    if (!window.confirm(`Approve the ${label} translation? Its article and question items are promoted with it, it becomes the ${label} kit teachers see in the app, and any earlier ${label} translation steps aside. The English kit and the topic are not touched.`)) return;
    const r = await post({ action: "approve", kitId: kit.id, notes: notes.trim() || undefined }, `approve:${kit.id}`);
    if (r) setNotice(`${label} translation approved.`);
  };
  const reject = async () => {
    if (!reason) return;
    if (!window.confirm(kit.status === "approved" ? `Pull the ${label} approval? The translation becomes rejected and its items are retired; the app stops showing it.` : `Reject the ${label} translation? Its staged article and items are retired; translate again after the fix.`)) return;
    const r = await post({ action: "reject", kitId: kit.id, reason, notes: notes.trim() }, `reject:${kit.id}`);
    if (r) setNotice(`${label} translation rejected.`);
  };

  return (
    <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-2">
      <p className="text-sm font-medium" title="Approving promotes the staged article and question items with the kit; rejecting retires them so the language can be translated again after the fix. The English kit and the topic are never touched.">
        Review the {label} translation
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {canRejectKit(kit.status) && (
          <select value={reason} onChange={(e) => setReason(e.target.value as KitRejectReason)} className="field h-9 px-2 text-sm" aria-label="Reject reason" disabled={!!busy}>
            {KIT_REJECT_REASONS.map((r) => (
              <option key={r} value={r}>
                {KIT_REJECT_REASON_LABEL[r]}
              </option>
            ))}
          </select>
        )}
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} placeholder="Notes — what you checked, or what is wrong (required to reject)" className="field flex-1 min-w-[16rem] px-3 py-2 text-sm" />
      </div>
      <div className="flex items-center gap-2">
        {canApproveKit(kit.status) && (
          <button type="button" onClick={approve} disabled={!!busy || !approveOk.ok} title={approveOk.ok ? undefined : approveOk.why} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
            {busy === `approve:${kit.id}` ? "Approving…" : "Approve translation"}
          </button>
        )}
        {canRejectKit(kit.status) && (
          <button type="button" onClick={reject} disabled={!!busy || !rejectOk.ok || !reason || !notes.trim()} title={rejectOk.ok ? (!notes.trim() ? "Notes are required to reject." : undefined) : rejectOk.why} className="btn-ghost h-9 px-4 text-sm text-[#B3401F] disabled:opacity-50">
            {busy === `reject:${kit.id}` ? "Rejecting…" : kit.status === "approved" ? "Pull approval" : "Reject"}
          </button>
        )}
      </div>
      {!approveOk.ok && canApproveKit(kit.status) && <p className="text-xs text-[#8A5A00]">{approveOk.why}</p>}
    </div>
  );
}

/** The language's pieces, as the English kit's table: piece, status, worker
 *  job, files. A piece the source kit does not have is not missing here. */
export function TranslationPieces({ kit, generations }: KitView) {
  const byId = new Map(generations.map((g) => [g.gen.id, g]));
  return (
    <div className="overflow-x-auto rounded-lg border border-[#EEF0EC]">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[#5B6470] border-b border-[#EEF0EC]">
          <tr>
            <th className="px-3 py-2 font-medium">Piece</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Worker</th>
            <th className="px-3 py-2 font-medium">Files</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#EEF0EC]">
          {KIT_KINDS.map((kind) => {
            const gid = kitGenerationIdFor(kit, kind);
            const g = gid ? (byId.get(gid) ?? null) : null;
            const docs = g ? g.artifacts.filter((a) => a.kind !== "video_mp4" && a.kind !== "script_json" && a.kind !== "thumbnail_png" && a.kind !== "questions_json") : [];
            if (!gid && kind !== "presentation" && kind !== "deck" && kind !== "lesson_plan") return null;
            return (
              <tr key={kind}>
                <td className="px-3 py-2">{KIT_KIND_LABEL[kind]}</td>
                <td className="px-3 py-2">{g ? <GenStatusChip status={g.gen.status} /> : <span className="text-xs text-[#98A0A9]">{kind === "lesson_plan" ? "after the video" : "—"}</span>}</td>
                <td className="px-3 py-2">
                  <JobLine job={g?.job ?? null} />
                </td>
                <td className="px-3 py-2">
                  {docs.map((a) =>
                    a.url ? (
                      <a key={a.kind} href={a.url} className="text-xs underline text-[#1F5B99] mr-2" download={a.name ?? undefined}>
                        {a.name ?? a.kind}
                      </a>
                    ) : null,
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The video parts of a translation kit (its presentation's video_mp4 artifacts). */
export function translationVideos({ kit, generations }: KitView) {
  const pres = kit.presentation_generation_id ? generations.find((g) => g.gen.id === kit.presentation_generation_id) : null;
  return pres ? pres.artifacts.filter((a) => a.kind === "video_mp4").sort((a, b) => a.part - b.part) : [];
}

/** The words the listing goes up with (topic_kits.youtube_meta), for a
 *  translation: shown read-only when the worker wrote them in the kit's
 *  language (worker PR #261 stamps `language`); otherwise one line saying the
 *  worker writes them in the language when it posts or re-words. The
 *  description itself is composed by the worker's localised composer and is
 *  not mirrored here — the reviewer sees the stored words, not a paraphrase. */
export function TranslationWords({ kit }: { kit: TopicKit }) {
  const label = languageLabel(kit.language) ?? kit.language;
  const meta = kit.youtube_meta;
  const inLanguage = metaInLanguage(meta, kit.language);
  const stampedOther = !!meta && !inLanguage;
  const source = meta?.source === "edited" ? "edited in the library" : "written by the worker from the narration";
  return (
    <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-1.5">
      <p className="text-sm font-medium">
        The words{" "}
        {inLanguage ? (
          <span className="text-xs font-normal text-[#5B6470]">
            (in {label}, {source})
          </span>
        ) : null}
      </p>
      {inLanguage && meta ? (
        <dl className="text-sm space-y-1">
          <div className="grid gap-1 sm:grid-cols-[7rem_1fr]">
            <dt className="text-xs text-[#5B6470]">Title</dt>
            <dd dir="auto">{meta.title?.trim() ? meta.title : <span className="text-xs text-[#98A0A9]">composed from the topic title, the key terms and the audience</span>}</dd>
          </div>
          <div className="grid gap-1 sm:grid-cols-[7rem_1fr]">
            <dt className="text-xs text-[#5B6470]">Opening paragraph</dt>
            <dd dir="auto" className="whitespace-pre-wrap">
              {meta.intro?.trim() ? meta.intro : <span className="text-xs text-[#98A0A9]">the topic summary</span>}
            </dd>
          </div>
          {!!meta.key_terms?.length && (
            <div className="grid gap-1 sm:grid-cols-[7rem_1fr]">
              <dt className="text-xs text-[#5B6470]">Key terms</dt>
              <dd dir="auto" className="text-xs">
                {meta.key_terms.join(", ")}
              </dd>
            </div>
          )}
          {!!meta.hashtags?.length && (
            <div className="grid gap-1 sm:grid-cols-[7rem_1fr]">
              <dt className="text-xs text-[#5B6470]">Hashtags</dt>
              <dd dir="auto" className="text-xs">
                {meta.hashtags.map((t) => `#${t}`).join(" ")}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="text-xs text-[#9A6400]">
          {stampedOther
            ? `The stored words are in ${languageLabel(String(meta?.language || "en")) ?? String(meta?.language || "en")}, not ${label} — the worker writes the ${label} words when it posts or re-words this kit.`
            : `No ${label} words yet — the worker writes the title, opening paragraph, key terms and hashtags in ${label} when it posts or re-words this kit.`}
        </p>
      )}
    </div>
  );
}

/** "Post to YouTube" for ONE approved translation kit: what is on the channel
 *  per part, the privacy, and the button — posting the publish route's
 *  `publish` / `retry` with this kit's id. Rendered by the review inbox in
 *  the top card under the verdict (the founder looked for it there,
 *  2026-10-17) and inside each language's folded row when that language is
 *  not the one under review. The disabled reason reads in the
 *  route's order: the flag, the kit and the translation, the topic and the
 *  bank, nothing left to do, the privacy. Above the controls, the words the
 *  listing goes up with (TranslationWords); once every part is on the
 *  channel, "Re-word on YouTube" queues the route's `rewords` — the worker
 *  rewrites the title, description and tags of the posted parts in the kit's
 *  language and changes nothing else. */
export function TranslationPublish({ kit, publications, topicStatus, bankMaturity, canPublish, publishEnabled, auditPassed, post, busy, setNotice }: {
  kit: TopicKit;
  publications: TopicPublication[];
  topicStatus: string;
  bankMaturity: string | null;
  canPublish: boolean;
  publishEnabled: boolean;
  auditPassed: boolean;
  post: Post;
  busy: string | null;
  setNotice: (s: string | null) => void;
}) {
  const [privacy, setPrivacy] = useState<PublishPrivacy>(defaultPrivacy(auditPassed));
  const summary = publicationSummary(publications, kit.part_plan.length);
  const action = publishActionFor(summary);
  const label = languageLabel(kit.language) ?? kit.language;
  // The route checks the translated article itself; here the kit, the
  // translation, the topic and the bank decide what the button says.
  const gate = publishGate(kit.status, topicStatus, "approved", bankMaturity);
  const translationWhy = kit.translation_status && kit.translation_status !== "approved" ? `This translation is ${String(kit.translation_status).replace(/_/g, " ")}, not approved — a reviewer approves the translation before it reaches YouTube.` : null;
  const queue = canQueuePublish(action, summary);
  const priv = publishPrivacyAccepts(privacy, auditPassed);
  const why = !publishEnabled ? PUBLISH_OFF_NOTE : !gate.ok ? gate.why : translationWhy ? translationWhy : !queue.ok ? queue.why : !priv.ok ? priv.why : null;
  const allowed = publishablePrivacies(auditPassed);
  // The re-word: offered once every part is up; its disabled reason reads in
  // the route's order too (the flag, the kit and the translation, nothing
  // to re-word) — the privacy is not one of them, a re-word changes none.
  const rewords = rewordsOffered(summary);
  const rewordsQueue = canQueueRewords(summary);
  const rewordsWhy = !publishEnabled ? PUBLISH_OFF_NOTE : !gate.ok ? gate.why : translationWhy ? translationWhy : !rewordsQueue.ok ? rewordsQueue.why : null;

  const publish = async () => {
    const what = privacy === "public" ? "PUBLIC — listed and searchable the moment the upload finishes" : privacy;
    if (!window.confirm(action === "retry" ? `Finish posting the ${label} kit? Parts already on YouTube are skipped; the rest go up ${what}.` : `Post the ${label} kit to YouTube ${what}? The worker posts it in ${label}, on the ${label} channel when one is configured, else on the English channel.`)) return;
    const r = await post({ action, kitId: kit.id, privacy }, `publish:${kit.id}`, "publish");
    if (r) setNotice(`${label} post queued — the worker uploads the parts in order (${privacy}) and records each one.`);
  };

  const reword = async () => {
    const n = summary.published;
    if (!window.confirm(`Re-word the ${label} kit on YouTube? The worker rewrites the title, description and tags of the ${n} posted part${n === 1 ? "" : "s"} in ${label} and changes nothing else — the videos, their privacy, captions and thumbnails stay as they are.`)) return;
    const r = await post({ action: REWORDS_ACTION, kitId: kit.id }, `rewords:${kit.id}`, "publish");
    if (r) setNotice(`${label} re-word queued — the worker rewrites the words of the posted parts in ${label} and records it.`);
  };

  return (
    <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Post to YouTube</p>
        <span className="text-xs text-[#5B6470]">{summary.label}</span>
      </div>
      <TranslationWords kit={kit} />
      {summary.parts.some((p) => p.row) && (
        <ul className="text-xs text-[#5B6470] space-y-0.5">
          {summary.parts.map(({ part, row, state }) => (
            <li key={part}>
              Part {part}: {state === "published" ? "published" : state === "failed" ? "failed" : "not yet"}
              {row?.youtube_video_id && (
                <>
                  {" "}
                  ·{" "}
                  <a href={`https://www.youtube.com/watch?v=${row.youtube_video_id}`} target="_blank" rel="noreferrer" className="underline text-[#1F5B99] font-mono">
                    {row.youtube_video_id}
                  </a>{" "}
                  · {row.privacy} · {row.channel_language} channel
                </>
              )}
              {row?.error && (
                <span className="text-[#B3401F]" title={row.error}>
                  {" "}
                  — {row.error.slice(0, 80)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!auditPassed && canPublish && <p className="text-xs text-[#9A6400]">{AUDIT_NOTE}</p>}
      {canPublish ? (
        <div className="flex flex-wrap items-center gap-2">
          <select value={privacy} onChange={(e) => setPrivacy(e.target.value as PublishPrivacy)} className="field h-9 px-2 text-sm" aria-label="Privacy" disabled={!!busy}>
            {PRIVACY.map((p) => (
              <option key={p} value={p} disabled={!(allowed as readonly string[]).includes(p)}>
                {PRIVACY_LABEL[p]}
                {(allowed as readonly string[]).includes(p) ? "" : " — needs the compliance audit"}
              </option>
            ))}
          </select>
          <button type="button" disabled={!!busy || !!why} title={why ?? undefined} onClick={publish} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
            {busy === `publish:${kit.id}` ? "Queuing…" : action === "retry" ? "Finish posting" : privacy === "public" ? "Post to YouTube (public)" : `Post to YouTube (${privacy})`}
          </button>
          {rewords && (
            <button
              type="button"
              disabled={!!busy || !!rewordsWhy}
              title={rewordsWhy ?? `Rewrites the title, description and tags of the posted parts in ${label}; nothing else changes.`}
              onClick={reword}
              className="btn-ghost h-9 px-4 text-sm disabled:opacity-50"
            >
              {busy === `rewords:${kit.id}` ? "Queuing…" : "Re-word on YouTube"}
            </button>
          )}
        </div>
      ) : (
        <p className="text-xs text-[#98A0A9]">Posting is a platform admin&apos;s action; this is the state of the channel.</p>
      )}
      {canPublish && why && !rewords && <p className="text-xs text-[#9A6400]">{why}</p>}
      {canPublish && rewords && rewordsWhy && <p className="text-xs text-[#9A6400]">{rewordsWhy}</p>}
    </div>
  );
}

export function TranslationsPanel({
  topicId,
  topicStatus,
  canApprove,
  sourceKit,
  translations,
  jobs,
  names,
  canGenerate,
  generateEnabled,
  migrationNote,
  selectedLanguage = null,
  reviewHrefs = {},
  canPublish = false,
  publishEnabled = false,
  auditPassed = false,
  bankMaturity = null,
}: {
  topicId: string;
  topicStatus: string;
  /** may this member approve or reject (libraryAllows(role, "approve")) */
  canApprove: boolean;
  /** the topic's approved English kit — what a translation starts from */
  sourceKit: TopicKit | null;
  /** every kit of the topic in a language other than English, newest first */
  translations: KitView[];
  /** the kit_translate jobs of this topic's kits, newest first */
  jobs: TranslateJobRow[];
  names: Record<string, string>;
  canGenerate: boolean;
  generateEnabled: boolean;
  migrationNote: string | null;
  /** the language the page's review header shows (?lang=), or null for the English kit */
  selectedLanguage?: string | null;
  /** per language, the inbox URL that selects it for the review header */
  reviewHrefs?: Record<string, string>;
  /** the `publish` action — admins only (plan §7.1); the English kit's gate */
  canPublish?: boolean;
  publishEnabled?: boolean;
  /** YOUTUBE_COMPLIANCE_AUDIT_PASSED on the app: public/unlisted allowed */
  auditPassed?: boolean;
  /** topics.bank_maturity — 'none' blocks publishing (canPublish) */
  bankMaturity?: string | null;
}) {
  const { post, busy, error, notice, setNotice } = useKitPost(topicId);
  const taken = new Set(translations.filter((t) => ["generating", "in_review", "approved"].includes(t.kit.status) && t.kit.translation_status !== "stale").map((t) => t.kit.language));
  const liveJobs = jobs.filter((j) => isLiveJobStatus(j.status));
  for (const j of liveJobs) if (typeof j.params.language === "string") taken.add(j.params.language);
  const choices = TARGETS.filter((l) => !taken.has(l.value));
  const [language, setLanguage] = useState<string>(choices[0]?.value ?? TARGETS[0].value);
  const lockWhy = !generateEnabled ? "Catalogue generation is switched off (FEATURE_CATALOGUE_GENERATE)." : !sourceKit ? "The topic has no approved English kit to translate." : migrationNote;

  const translate = async () => {
    if (!sourceKit) return;
    const label = languageLabel(language) ?? language;
    if (!window.confirm(`Translate the approved English kit into ${label}? The worker translates the glossary, the article and the script, checks them, and queues the video and deck on its off-peak lane. Nothing is published until a reviewer approves the translation.`)) return;
    const r = await post({ action: "translate", kitId: sourceKit.id, language }, `translate:${language}`);
    if (r) setNotice(r.existing ? `A ${label} translation is already queued.` : `${label} translation queued.`);
  };

  const jobsWithoutKit = jobs.filter((j) => !translations.some((t) => (t.kit.translation as { job_id?: string } | null)?.job_id === j.id || (t.kit.language === j.params.language && t.kit.status !== "failed")));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          className="font-medium"
          title="The same lesson in another language: the English kit's words are translated and its scene plan re-rendered with new voices — the pictures, the figures and the maths stay as they are. Pre-check A compares the translation with the English before the render; check C looks at the rendered timing. A reviewer approves each translation."
        >
          Translations <span className="text-sm text-[#5B6470] font-normal">({translations.length})</span>
        </h2>
        {canGenerate && (
          <div className="flex items-center gap-2">
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className="field h-8 px-2 text-xs" disabled={!!busy || !choices.length} aria-label="Language to translate into">
              {(choices.length ? choices : TARGETS).map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={translate} disabled={!!busy || !!lockWhy || !choices.length} title={lockWhy ?? (!choices.length ? "Every language has a translation or a job already." : undefined)} className="btn-primary h-8 px-3 text-xs disabled:opacity-50">
              {busy?.startsWith("translate:") ? "Queuing…" : "Translate into…"}
            </button>
          </div>
        )}
      </div>
      {migrationNote && <p className="text-xs text-[#8A5A00]">{migrationNote}</p>}
      {error && <p className="text-xs text-[#B3401F]">{error}</p>}
      {notice && <p className="text-xs text-[#1E6B3A]">{notice}</p>}

      {jobsWithoutKit.length > 0 && (
        <ul className="text-xs text-[#5B6470] space-y-1">
          {jobsWithoutKit.slice(0, 5).map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{languageLabel(String(j.params.language ?? "")) ?? String(j.params.language ?? "?")}</span>
              <span>· translate job</span>
              <JobLine job={j} />
              <span className="text-[#98A0A9]">{fmtDate(j.created_at)}</span>
            </li>
          ))}
        </ul>
      )}

      {translations.length === 0 ? (
        <p className="text-sm text-[#98A0A9]">No translation yet.</p>
      ) : (
        <div className="rounded-lg border border-[#EEF0EC] divide-y divide-[#EEF0EC]">
          {translations.map((view) => {
            const { kit } = view;
            const videos = translationVideos(view);
            const selected = selectedLanguage === kit.language;
            const flags = flagCount(kit.precheck);
            const blocking = blockingCount(kit.precheck);
            const href = reviewHrefs[kit.language];
            return (
              <details key={kit.id} className={selected ? "bg-[#F4F6F3]" : ""} open={selected || undefined}>
                <summary className="cursor-pointer px-3 py-2 flex flex-wrap items-center gap-2 text-sm list-none [&::-webkit-details-marker]:hidden">
                  <span className="text-[#98A0A9] text-xs w-3">▸</span>
                  <span className="font-medium">{languageLabel(kit.language) ?? kit.language}</span>
                  <KitStatusChip status={kit.status} />
                  <TranslationChip status={kit.translation_status} />
                  <span className="text-xs">
                    <PrecheckLine report={kit.precheck} />
                  </span>
                  {(flags > 0 || blocking > 0) && (
                    <span className={`chip ${blocking ? "bg-[#FFE9E3] text-[#B3401F]" : "bg-[#FFF1D6] text-[#9A6400]"}`} title="Pre-check findings (both checks)">
                      {blocking ? `${blocking} blocking · ` : ""}
                      {flags} flag{flags === 1 ? "" : "s"}
                    </span>
                  )}
                  <span className="text-xs text-[#98A0A9] ml-auto">
                    from kit {kit.source_kit_id ? kit.source_kit_id.slice(0, 8) : "—"} · {fmtDate(kit.created_at)}
                    {kit.reviewer_id && <> · {names[kit.reviewer_id] ?? kit.reviewer_id.slice(0, 8)}</>}
                  </span>
                  {selected ? (
                    <span className="chip bg-[#EDE7FB] text-[#5B3FBF]">reviewing above</span>
                  ) : href ? (
                    <Link href={href} className="text-xs text-[#1F5B99] hover:underline" onClick={(e) => e.stopPropagation()}>
                      Review at the top ↑
                    </Link>
                  ) : null}
                </summary>
                <div className="px-3 pb-3 space-y-3">
                  {kit.notes && <p className="text-xs text-[#B3401F] whitespace-pre-wrap">{kit.notes}</p>}
                  <TranslationPieces {...view} />
                  <Findings report={kit.precheck} />
                  {!selected && <TranslationReviewBox kit={kit} topicStatus={topicStatus} canApprove={canApprove} post={post} busy={busy} setNotice={setNotice} />}
                  {!selected && kit.status === "approved" && (
                    <TranslationPublish
                      kit={kit}
                      publications={view.publications}
                      topicStatus={topicStatus}
                      bankMaturity={bankMaturity}
                      canPublish={canPublish}
                      publishEnabled={publishEnabled}
                      auditPassed={auditPassed}
                      post={post}
                      busy={busy}
                      setNotice={setNotice}
                    />
                  )}
                  {!selected && <VideoParts kit={kit} videos={videos} />}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
