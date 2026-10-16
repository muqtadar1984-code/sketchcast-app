"use client";

import { useState } from "react";
import { LANGUAGES, languageLabel } from "@/utils/narration";
import { KIT_KIND_LABEL, kitGenerationIdFor } from "@/utils/catalogue/kit";
import { isLiveJobStatus } from "@/utils/catalogue/status";
import type { PrecheckReport, TopicKit } from "@/utils/catalogue/types";
import { GenStatusChip, KitStatusChip, fmtDate } from "../../catalogue-ui";
import { JobLine, useKitPost, type KitView } from "./kit-panel";
import type { JobRow } from "./article-panel";

// The topic page's Translations panel (Kit Translator, plan revision 3, T0 —
// 2026-10-16). Every kit of this topic in a language other than English,
// newest first: its language, the kit's status and the translation's own
// (staged → in review → approved | stale | blocked | failed), the source
// English kit, the pre-check verdict (blocking findings and flags, the
// post-render check once the video exists), the worker's job line per piece,
// the video parts and the deck. "Translate into …" queues ONE kit_translate
// job for the topic's approved English kit (the route refuses a second live
// one). Approval of a translation is T1's review screen; until then the
// reviewer watches the video here.

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

function TranslationChip({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${TRANSLATION_TONE[status] ?? "bg-[#EEF0EC] text-[#5B6470]"}`}>{status.replace(/_/g, " ")}</span>;
}

function PrecheckLine({ report }: { report: PrecheckReport | null | undefined }) {
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

function Findings({ report }: { report: PrecheckReport | null | undefined }) {
  if (!report) return null;
  const items = [...(report.blocking ?? []).map((f) => ({ ...f, level: "blocks" })), ...(report.flags ?? []).map((f) => ({ ...f, level: "flag" })),
    ...((report.post_render?.blocking ?? []).map((f) => ({ ...f, level: "blocks" }))), ...((report.post_render?.flags ?? []).map((f) => ({ ...f, level: "flag" })))];
  if (!items.length) return null;
  return (
    <details className="text-xs text-[#5B6470]">
      <summary className="cursor-pointer">{items.length} finding{items.length === 1 ? "" : "s"}</summary>
      <ul className="mt-1 space-y-0.5 max-h-48 overflow-y-auto">
        {items.slice(0, 60).map((f, i) => (
          <li key={i}>
            <span className={f.level === "blocks" ? "text-[#B3401F]" : "text-[#8A5A00]"}>{f.level}</span> · <span className="font-mono">{String(f.where)}</span> · {String(f.what)}
            {"detail" in f && f.detail ? <span className="text-[#98A0A9]"> — {typeof f.detail === "string" ? f.detail : JSON.stringify(f.detail).slice(0, 80)}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function TranslationsPanel({
  topicId,
  sourceKit,
  translations,
  jobs,
  names,
  canGenerate,
  generateEnabled,
  migrationNote,
}: {
  topicId: string;
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

  const jobsWithoutKit = jobs.filter((j) => !translations.some((t) => (t.kit.translation as { job_id?: string } | null)?.job_id === j.id || t.kit.language === j.params.language && t.kit.status !== "failed"));

  return (
    <div className="card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">Translations</h2>
          <p className="text-xs text-[#5B6470] mt-1">
            The same lesson in another language: the English kit&apos;s words are translated and its scene plan re-rendered with new voices — the pictures, the figures and the maths stay as they are.
            Pre-check A compares the translation with the English before the render; check C looks at the rendered timing. A reviewer approves each translation.
          </p>
        </div>
        {canGenerate && (
          <div className="flex items-center gap-2">
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className="input h-8 text-xs" disabled={!!busy || !choices.length} aria-label="Language to translate into">
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
        <div className="space-y-4">
          {translations.map(({ kit, generations }) => {
            const byId = new Map(generations.map((g) => [g.gen.id, g]));
            const pres = kit.presentation_generation_id ? byId.get(kit.presentation_generation_id) : null;
            const videos = pres ? pres.artifacts.filter((a) => a.kind === "video_mp4").sort((a, b) => a.part - b.part) : [];
            return (
              <div key={kit.id} className="rounded-lg border border-[#EEF0EC] p-3 space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{languageLabel(kit.language) ?? kit.language}</span>
                  <KitStatusChip status={kit.status} />
                  <TranslationChip status={kit.translation_status} />
                  <span className="text-xs text-[#98A0A9]">
                    from kit {kit.source_kit_id ? kit.source_kit_id.slice(0, 8) : "—"} · {fmtDate(kit.created_at)}
                    {kit.reviewer_id && <> · {names[kit.reviewer_id] ?? kit.reviewer_id.slice(0, 8)}</>}
                  </span>
                </div>
                {kit.notes && <p className="text-xs text-[#B3401F]">{kit.notes}</p>}
                <div className="flex flex-wrap gap-6">
                  <div>
                    <p className="text-xs text-[#5B6470] mb-1">Pre-checks</p>
                    <PrecheckLine report={kit.precheck} />
                    <Findings report={kit.precheck} />
                  </div>
                  <div className="flex-1 min-w-[16rem]">
                    <table className="w-full text-xs">
                      <tbody className="divide-y divide-[#EEF0EC]">
                        {(["presentation", "deck", "lesson_plan"] as const).map((kind) => {
                          const gid = kitGenerationIdFor(kit, kind);
                          const g = gid ? (byId.get(gid) ?? null) : null;
                          const docs = g ? g.artifacts.filter((a) => a.kind !== "video_mp4" && a.kind !== "script_json" && a.kind !== "thumbnail_png") : [];
                          return (
                            <tr key={kind}>
                              <td className="py-1 pr-2">{KIT_KIND_LABEL[kind]}</td>
                              <td className="py-1 pr-2">{g ? <GenStatusChip status={g.gen.status} /> : <span className="text-[#98A0A9]">{kind === "lesson_plan" ? "after the video" : "—"}</span>}</td>
                              <td className="py-1 pr-2">
                                <JobLine job={g?.job ?? null} />
                              </td>
                              <td className="py-1">
                                {docs.map((a) =>
                                  a.url ? (
                                    <a key={a.kind} href={a.url} className="underline text-[#1F5B99] mr-2" download={a.name ?? undefined}>
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
                </div>
                {videos.length > 0 && (
                  <div className="grid gap-3 md:grid-cols-2">
                    {videos.map((v) => (
                      <div key={`${v.part}-${v.url ?? ""}`}>
                        <p className="text-xs font-medium mb-1">Part {v.part}</p>
                        {v.url ? <video controls preload="metadata" src={v.url} controlsList="nodownload" disablePictureInPicture className="w-full rounded-lg bg-black" /> : <span className="text-xs text-[#98A0A9]">not signed</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
