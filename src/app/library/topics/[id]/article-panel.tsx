"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  canApproveArticle,
  canEditArticle,
  canRejectArticle,
  canRenderFigures,
  canSubmitArticle,
  diffSummary,
  sectionDiff,
  topicAcceptsArticle,
} from "@/utils/catalogue/article";
import { isLiveJobStatus } from "@/utils/catalogue/status";
import type { ArticleBody, ArticleFigure, TopicArticle } from "@/utils/catalogue/types";
import { ArticleStatusChip, FigureStatusChip, JobSummary, fmtDate } from "../../catalogue-ui";
import { ArticleEditor } from "./article-editor";

// The topic page's Article panel (Phase 2b): the version list, one selected
// version (read-only view, or the editor for a draft / in-review version), the
// review box (Approve / Reject), Write article / New version from this
// (enqueue a topic_article job), Render figures (a figure_render job), and a
// section-by-section diff of two versions. Every control POSTs
// /api/library/topics/[id]/article with {action, …} and then router.refresh()
// (the topic-panels.tsx pattern). `can*` flags come from the server; the
// route re-checks them, these only decide what renders.

export type JobRow = { id: string; status: string; progress: number | null; stage: unknown; error: string | null; created_at: string };
export type FigureView = ArticleFigure & { url: string | null };
export type ArticleVersion = { article: TopicArticle; figures: FigureView[]; renderJob: JobRow | null };

type Post = (payload: Record<string, unknown>, label: string) => Promise<Record<string, unknown> | null>;

function useArticlePost(topicId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const post: Post = async (payload, label) => {
    setBusy(label);
    setError(null);
    setErrors([]);
    setNotice(null);
    const res = await fetch(`/api/library/topics/${topicId}/article`, {
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
  return { post, busy, error, errors, notice, setNotice, clear };
}

function Messages({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-[#0F7A68]">{notice}</p>}
    </>
  );
}

const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

export function ArticlePanel({
  topicId,
  topicStatus,
  versions,
  articleJob,
  names,
  canEdit,
  canApprove,
}: {
  topicId: string;
  topicStatus: string;
  versions: ArticleVersion[];
  articleJob: JobRow | null;
  names: Record<string, string>;
  canEdit: boolean;
  canApprove: boolean;
}) {
  const { post, busy, error, errors, notice, setNotice, clear } = useArticlePost(topicId);
  const [selectedId, setSelectedId] = useState<string | null>(versions[0]?.article.id ?? null);
  const [mode, setMode] = useState<"view" | "edit" | "diff">("view");
  const [writing, setWriting] = useState<null | { sourceArticleId: string | null; sourceVersion: number | null }>(null);
  const [hints, setHints] = useState("");
  const [notes, setNotes] = useState("");
  const [diffLeft, setDiffLeft] = useState<string>(versions[1]?.article.id ?? versions[0]?.article.id ?? "");
  const [diffRight, setDiffRight] = useState<string>(versions[0]?.article.id ?? "");

  // A version the server no longer lists (deleted elsewhere) falls back to the newest.
  const selected = versions.find((v) => v.article.id === selectedId) ?? versions[0] ?? null;
  // The live version: at most one is approved per language (0112).
  const approvedVersion = versions.find((v) => v.article.status === "approved")?.article ?? null;
  const accepts = topicAcceptsArticle(topicStatus);
  const liveJob = !!articleJob && isLiveJobStatus(articleJob.status);
  const writeDisabledWhy = !accepts
    ? topicStatus === "candidate"
      ? "Approve the topic first — an article is written for an approved topic."
      : "This topic is retired; reopen it before writing an article."
    : liveJob
      ? `An article job is already ${articleJob!.status}.`
      : null;
  const personName = (id: string | null) => (id ? (names[id] ?? shortId(id)) : "—");

  const generate = async () => {
    const r = await post(
      { action: "generate", hints: hints.trim() || undefined, sourceArticleId: writing?.sourceArticleId ?? undefined },
      "generate",
    );
    if (r) {
      setWriting(null);
      setHints("");
      setNotice(writing?.sourceArticleId ? `Queued a new version from v${writing.sourceVersion}.` : "Queued — the worker writes the draft and it appears here.");
    }
  };

  const select = (id: string) => {
    setSelectedId(id);
    setMode("view");
    clear();
  };

  return (
    <div className="card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">
            Article <span className="text-sm text-[#5B6470] font-normal">({versions.length} version{versions.length === 1 ? "" : "s"})</span>
          </h2>
          <p className="text-xs text-[#5B6470] mt-1">
            The knowledge article is the single source of truth: every kit is generated from an <span className="font-medium">approved</span> version.
            Approval is a named reviewer&apos;s act and is recorded.
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-col items-end gap-1 shrink-0">
            <button
              type="button"
              disabled={!!busy || !!writeDisabledWhy}
              title={writeDisabledWhy ?? undefined}
              onClick={() => {
                clear();
                setWriting(writing && writing.sourceArticleId === null ? null : { sourceArticleId: null, sourceVersion: null });
              }}
              className="btn-primary h-9 px-4 text-sm disabled:opacity-50"
            >
              {versions.length ? "Write a new version" : "Write article"}
            </button>
            {writeDisabledWhy && <span className="text-xs text-[#9A6400] max-w-xs text-right">{writeDisabledWhy}</span>}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-[#5B6470]">Latest article job:</span>
        <JobSummary job={articleJob} never="none yet" />
      </div>

      {writing && (
        <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-2 text-sm">
          <p className="text-xs text-[#5B6470]">
            {writing.sourceArticleId
              ? `The worker writes the next version starting from v${writing.sourceVersion}. Hints steer it (what to change, what to keep).`
              : "The worker writes a draft at the depth the topic's depth node asks for. Hints are optional: emphasis, examples to include, what to avoid."}
          </p>
          <textarea
            value={hints}
            onChange={(e) => setHints(e.target.value)}
            maxLength={4000}
            rows={3}
            placeholder="Hints for the writer (optional)…"
            className="field w-full px-3 py-2"
          />
          <div className="flex items-center gap-2">
            <button type="button" disabled={!!busy || !!writeDisabledWhy} onClick={generate} className="btn-primary h-9 px-4">
              {busy === "generate" ? "Queuing…" : writing.sourceArticleId ? `Write v${versions[0].article.version + 1} from v${writing.sourceVersion}` : "Write"}
            </button>
            <button type="button" onClick={() => setWriting(null)} className="btn-ghost h-9 px-3">
              Cancel
            </button>
          </div>
        </div>
      )}

      {versions.length === 0 ? (
        <p className="text-sm text-[#98A0A9]">No article yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-[#EEF0EC]">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[#5B6470] border-b border-[#EEF0EC]">
                <tr>
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Author</th>
                  <th className="px-3 py-2 font-medium text-right">Words</th>
                  <th className="px-3 py-2 font-medium">Reviewer</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EEF0EC]">
                {versions.map(({ article: a }) => {
                  const isSel = selected?.article.id === a.id;
                  return (
                    <tr key={a.id} className={isSel ? "bg-[#F4F6F3]" : "hover:bg-[#F8FAF7]"}>
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => select(a.id)} className={`hover:underline ${isSel ? "font-medium" : ""}`} aria-current={isSel || undefined}>
                          v{a.version}
                        </button>
                        {a.source_article_id && (
                          <span className="block text-xs text-[#98A0A9]">
                            from v{versions.find((v) => v.article.id === a.source_article_id)?.article.version ?? "?"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <ArticleStatusChip status={a.status} />
                      </td>
                      <td className="px-3 py-2 text-[#5B6470]">{a.author}</td>
                      <td className="px-3 py-2 text-right tabular">{a.word_count.toLocaleString()}</td>
                      <td className="px-3 py-2 text-[#5B6470]">
                        {a.reviewer_id ? (
                          <span title={a.reviewed_at ? `Reviewed ${fmtDate(a.reviewed_at)}` : undefined}>{personName(a.reviewer_id)}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2 text-[#5B6470] whitespace-nowrap">{fmtDate(a.updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selected && (
            <SelectedVersion
              key={selected.article.id}
              version={selected}
              versions={versions}
              mode={mode}
              setMode={setMode}
              canEdit={canEdit}
              canApprove={canApprove}
              topicStatus={topicStatus}
              accepts={accepts}
              liveJob={liveJob}
              busy={busy}
              errors={errors}
              notes={notes}
              setNotes={setNotes}
              personName={personName}
              onNewVersion={() => {
                clear();
                setWriting({ sourceArticleId: selected.article.id, sourceVersion: selected.article.version });
              }}
              onSave={async (body: ArticleBody) => {
                const r = await post({ action: "save", articleId: selected.article.id, article: body }, "save");
                if (r) {
                  setMode("view");
                  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);
                  const kept = strings(r.figuresKept);
                  const reset = strings(r.figuresReset);
                  const notes = [`Saved (${r.wordCount} words).`];
                  if (kept.length) {
                    notes.push(`${kept.length} rendered figure${kept.length === 1 ? " was" : "s were"} kept: ${kept.join(", ")} — a rendered figure is not deleted from the editor.`);
                  }
                  if (reset.length) {
                    notes.push(
                      `${reset.length} figure${reset.length === 1 ? "" : "s"} went back to draft because what to draw changed: ${reset.join(", ")} — render the figures again.`,
                    );
                  }
                  setNotice(notes.join(" "));
                }
              }}
              onSubmit={async () => {
                const r = await post({ action: "submit", articleId: selected.article.id }, "submit");
                if (r) setNotice(`v${selected.article.version} submitted for review.`);
              }}
              onRender={async () => {
                const r = await post({ action: "render_figures", articleId: selected.article.id }, "render");
                if (r) setNotice("Figure render queued.");
              }}
              onApprove={async () => {
                // Approval is recorded and moves the topic; it is confirmed
                // like Reject is. The supersession is named when there is one.
                const v = selected.article.version;
                const supersedes = approvedVersion && approvedVersion.id !== selected.article.id ? ` This supersedes v${approvedVersion.version} and` : " This";
                if (!window.confirm(`Approve v${v}?${supersedes} moves the topic to article approved.`)) return;
                const r = await post({ action: "approve", articleId: selected.article.id, notes: notes.trim() || undefined }, "approve");
                if (r) {
                  setNotes("");
                  setNotice(`v${selected.article.version} approved — the topic is now article approved; any previously approved version is superseded.`);
                }
              }}
              onReject={async () => {
                if (!notes.trim()) return;
                if (!window.confirm(`Reject v${selected.article.version}? It stays in the history as rejected.`)) return;
                const r = await post({ action: "reject", articleId: selected.article.id, notes: notes.trim() }, "reject");
                if (r) {
                  setNotes("");
                  setNotice(`v${selected.article.version} rejected.`);
                }
              }}
            />
          )}

          {mode === "diff" && versions.length >= 2 && (
            <DiffView versions={versions} left={diffLeft} right={diffRight} setLeft={setDiffLeft} setRight={setDiffRight} onClose={() => setMode("view")} />
          )}
        </>
      )}
      <Messages error={error} notice={notice} />
    </div>
  );
}

// ── One version: header, actions, review box, then view or editor ───────────

function SelectedVersion({
  version,
  versions,
  mode,
  setMode,
  canEdit,
  canApprove,
  topicStatus,
  accepts,
  liveJob,
  busy,
  errors,
  notes,
  setNotes,
  personName,
  onNewVersion,
  onSave,
  onSubmit,
  onRender,
  onApprove,
  onReject,
}: {
  version: ArticleVersion;
  versions: ArticleVersion[];
  mode: "view" | "edit" | "diff";
  setMode: (m: "view" | "edit" | "diff") => void;
  canEdit: boolean;
  canApprove: boolean;
  topicStatus: string;
  accepts: boolean;
  liveJob: boolean;
  busy: string | null;
  errors: string[];
  notes: string;
  setNotes: (v: string) => void;
  personName: (id: string | null) => string;
  onNewVersion: () => void;
  onSave: (body: ArticleBody) => Promise<void>;
  onSubmit: () => Promise<void>;
  onRender: () => Promise<void>;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const a = version.article;
  const editable = canEditArticle(a.status);
  const showEdit = canEdit && editable && mode !== "edit";
  const showSubmit = canEdit && canSubmitArticle(a.status);
  const showNewVersion = canEdit && !editable;
  const showReview = canApprove && (canApproveArticle(a.status) || canRejectArticle(a.status)) && mode !== "edit";
  const liveRender = !!version.renderJob && isLiveJobStatus(version.renderJob.status);
  // Rendering the figures is part of editing the article (edit_article), not
  // the kit-level `generate` — the route asks for the same role. A rejected or
  // superseded version is history: the route refuses (409), so no button.
  const showRender = canEdit && canRenderFigures(a.status) && version.figures.length > 0 && mode !== "edit";
  // The route refuses to approve an article while the topic is a candidate
  // (plan §1.3: the topic first); the button says so instead of showing a 409.
  const approveBlockedWhy = topicStatus === "candidate" ? "Approve the topic first — an article is approved for an approved topic." : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          v{a.version} · {a.title}
        </span>
        <ArticleStatusChip status={a.status} />
        <span className="text-xs text-[#5B6470]">
          {a.author} · {a.word_count.toLocaleString()} words
          {a.reviewed_at && (
            <>
              {" "}
              · reviewed by {personName(a.reviewer_id)} {fmtDate(a.reviewed_at)}
            </>
          )}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {versions.length >= 2 && mode !== "diff" && (
            <button type="button" onClick={() => setMode("diff")} className="btn-ghost h-8 px-3 text-xs">
              Compare versions
            </button>
          )}
          {showEdit && (
            <button type="button" disabled={!!busy} onClick={() => setMode("edit")} className="btn-ghost h-8 px-3 text-xs">
              Edit
            </button>
          )}
          {showSubmit && mode !== "edit" && (
            <button type="button" disabled={!!busy} onClick={() => void onSubmit()} className="btn-ghost h-8 px-3 text-xs">
              {busy === "submit" ? "…" : "Submit for review"}
            </button>
          )}
          {showRender && (
            <button
              type="button"
              disabled={!!busy || liveRender}
              title={liveRender ? `A figure render is already ${version.renderJob!.status}.` : "Render every figure spec through the visual library"}
              onClick={() => void onRender()}
              className="btn-ghost h-8 px-3 text-xs disabled:opacity-50"
            >
              {busy === "render" ? "…" : `Render figures (${version.figures.length})`}
            </button>
          )}
          {showNewVersion && (
            <button
              type="button"
              disabled={!!busy || !accepts || liveJob}
              title={!accepts ? "The topic must be approved and not retired." : liveJob ? "An article job is already running." : "Ask the worker for the next version, starting from this one"}
              onClick={onNewVersion}
              className="btn-ghost h-8 px-3 text-xs disabled:opacity-50"
            >
              New version from this
            </button>
          )}
        </span>
      </div>
      {a.notes && (
        <p className="text-xs text-[#5B6470] bg-[#F4F6F3] rounded-lg px-3 py-2 whitespace-pre-wrap">
          <span className="font-medium">Notes:</span> {a.notes}
        </p>
      )}
      {version.renderJob && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-[#5B6470]">Latest figure render:</span>
          <JobSummary job={version.renderJob} />
        </div>
      )}

      {showReview && (
        <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-2 text-sm">
          <p className="text-xs text-[#5B6470]">
            Review v{a.version}. <span className="font-medium">Approve</span> supersedes the currently approved version, records you as the
            reviewer and moves the topic to article approved — in one transaction. <span className="font-medium">Reject</span> needs a reason.
          </p>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} placeholder="Review notes (required to reject)…" className="field w-full px-3 py-2" />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!!busy || !!approveBlockedWhy}
              title={approveBlockedWhy ?? undefined}
              onClick={() => void onApprove()}
              className="btn-primary h-9 px-4 disabled:opacity-50"
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              disabled={!!busy || !notes.trim()}
              title={notes.trim() ? undefined : "Say why in the notes first"}
              onClick={() => void onReject()}
              className="h-9 px-3 rounded-lg text-sm bg-[#FFE9E3] text-[#B3401F] hover:bg-[#FFDCD2] disabled:opacity-50"
            >
              {busy === "reject" ? "…" : "Reject"}
            </button>
            {approveBlockedWhy && <span className="text-xs text-[#9A6400]">{approveBlockedWhy}</span>}
          </div>
        </div>
      )}

      {mode === "edit" ? (
        <ArticleEditor article={a} figures={version.figures} busy={busy === "save"} errors={errors} onSave={onSave} onCancel={() => setMode("view")} />
      ) : (
        <ArticleView version={version} />
      )}
    </div>
  );
}

// ── Read-only rendering ─────────────────────────────────────────────────────

function FigureCard({ f }: { f: FigureView }) {
  return (
    <figure className="rounded-lg border border-[#EEF0EC] p-3 text-xs space-y-1.5 bg-white">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[#1F5B99]">{f.figure_key}</span>
        <FigureStatusChip status={f.status} />
      </div>
      {f.url ? (
        // A signed URL into the private bucket (an hour); SVG or PNG alike.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={f.url} alt={f.caption ?? f.spec?.subject ?? f.figure_key} className="max-h-56 w-auto rounded bg-[#F8FAF7]" />
      ) : (
        <p className="text-[#98A0A9]">{f.visual_asset_id ? "Preview unavailable (asset not found or not signable)." : "Not rendered yet."}</p>
      )}
      <p className="text-[#5B6470]">
        <span className="font-medium">Draw:</span> {f.spec?.subject || "—"}
        {f.spec?.parts?.length ? <> · label {f.spec.parts.join(", ")}</> : null}
        {f.spec?.style ? <> · {f.spec.style}</> : null}
      </p>
      {f.caption && <figcaption className="text-[#14181F]">{f.caption}</figcaption>}
      {f.render_error && (
        <p className="text-[#B3401F]" title={f.render_error}>
          Render failed: {f.render_error}
        </p>
      )}
    </figure>
  );
}

function ArticleView({ version }: { version: ArticleVersion }) {
  const a = version.article;
  const figuresByKey = new Map(version.figures.map((f) => [f.figure_key, f]));
  const objectiveText = new Map(a.objectives.map((o) => [o.id, o.text]));
  const sectionHeading = new Map(a.sections.map((s) => [s.id, s.heading]));
  const claimsBySection = new Map<string, typeof a.claims>();
  for (const c of a.claims) claimsBySection.set(c.section_id, [...(claimsBySection.get(c.section_id) ?? []), c]);
  const placed = new Set(a.sections.flatMap((s) => s.figure_keys));

  return (
    <div className="space-y-4 text-sm">
      {a.objectives.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-[#5B6470] uppercase tracking-wide mb-1">Objectives</h3>
          <ol className="list-decimal pl-5 space-y-0.5">
            {a.objectives.map((o) => (
              <li key={o.id}>
                {o.text} <span className="text-xs text-[#98A0A9] font-mono">{o.id}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {a.sections.map((s) => (
        <section key={s.id} className="space-y-2">
          <h3 className="font-medium">
            {s.heading} <span className="text-xs text-[#98A0A9] font-mono">{s.id}</span>
          </h3>
          {s.covers.length > 0 && (
            <p className="text-xs text-[#5B6470]">
              Covers: {s.covers.map((c) => objectiveText.get(c) ?? c).join(" · ")}
            </p>
          )}
          <div className="whitespace-pre-wrap leading-relaxed">{s.body_md || <span className="text-[#98A0A9]">(empty)</span>}</div>
          {s.figure_keys.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {s.figure_keys.map((k) => {
                const f = figuresByKey.get(k);
                return f ? (
                  <FigureCard key={k} f={f} />
                ) : (
                  <p key={k} className="text-xs text-[#B3401F]">
                    Figure &quot;{k}&quot; is named here but has no row.
                  </p>
                );
              })}
            </div>
          )}
          {(claimsBySection.get(s.id) ?? []).length > 0 && (
            <ul className="text-xs text-[#5B6470] list-disc pl-5">
              {(claimsBySection.get(s.id) ?? []).map((c) => (
                <li key={c.id}>
                  <span className="font-medium">claim</span> {c.text}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {version.figures.some((f) => !placed.has(f.figure_key)) && (
        <section>
          <h3 className="text-xs font-medium text-[#5B6470] uppercase tracking-wide mb-1">Figures not placed in a section</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {version.figures.filter((f) => !placed.has(f.figure_key)).map((f) => <FigureCard key={f.id} f={f} />)}
          </div>
        </section>
      )}
      {a.claims.some((c) => !sectionHeading.has(c.section_id)) && (
        <p className="text-xs text-[#B3401F]">
          {a.claims.filter((c) => !sectionHeading.has(c.section_id)).length} claim(s) point at a section that no longer exists.
        </p>
      )}
      {a.glossary.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-[#5B6470] uppercase tracking-wide mb-1">Glossary</h3>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
            {a.glossary.map((g, i) => (
              <div key={`${g.term}-${i}`} className="contents">
                <dt className="font-medium">{g.term}</dt>
                <dd className="text-[#5B6470]">{g.definition}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {a.misconceptions.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-[#5B6470] uppercase tracking-wide mb-1">Misconceptions</h3>
          <ul className="space-y-1">
            {a.misconceptions.map((m) => (
              <li key={m.id}>
                <span className="line-through text-[#B3401F]">{m.misconception}</span> → {m.correction}
              </li>
            ))}
          </ul>
        </section>
      )}
      {a.worked_examples.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-[#5B6470] uppercase tracking-wide mb-1">Worked examples</h3>
          <ul className="space-y-2">
            {a.worked_examples.map((w) => (
              <li key={w.id} className="rounded-lg bg-[#F8FAF7] p-3">
                <p className="font-medium whitespace-pre-wrap">{w.problem}</p>
                <p className="text-[#5B6470] whitespace-pre-wrap mt-1">{w.solution_md}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {a.depth_rationale && (
        <p className="text-xs text-[#5B6470]">
          <span className="font-medium">Depth:</span> {a.depth_rationale}
        </p>
      )}
    </div>
  );
}

// ── Diff ────────────────────────────────────────────────────────────────────

const CHANGE_TONE: Record<string, string> = {
  same: "bg-[#EEF0EC] text-[#5B6470]",
  changed: "bg-[#FFF1D6] text-[#9A6400]",
  added: "bg-[#E6F6F2] text-[#0F7A68]",
  removed: "bg-[#FFE9E3] text-[#B3401F]",
};

function DiffView({
  versions,
  left,
  right,
  setLeft,
  setRight,
  onClose,
}: {
  versions: ArticleVersion[];
  left: string;
  right: string;
  setLeft: (id: string) => void;
  setRight: (id: string) => void;
  onClose: () => void;
}) {
  const L = versions.find((v) => v.article.id === left)?.article ?? null;
  const R = versions.find((v) => v.article.id === right)?.article ?? null;
  const rows = L && R ? sectionDiff(L.sections, R.sections) : [];
  const summary = diffSummary(rows);
  const cell = (s: { heading: string; body_md: string; figure_keys: string[]; covers: string[] } | null, fields: string[]) =>
    s ? (
      <div className="space-y-1">
        <p className={`font-medium ${fields.includes("heading") ? "bg-[#FFF1D6] rounded px-1" : ""}`}>{s.heading}</p>
        <p className={`whitespace-pre-wrap text-xs leading-relaxed ${fields.includes("body_md") ? "bg-[#FFF9EE] rounded px-1" : ""}`}>{s.body_md}</p>
        <p className={`text-xs text-[#5B6470] ${fields.includes("figure_keys") || fields.includes("covers") ? "bg-[#FFF1D6] rounded px-1" : ""}`}>
          figures: {s.figure_keys.join(", ") || "—"} · covers: {s.covers.join(", ") || "—"}
        </p>
      </div>
    ) : (
      <p className="text-xs text-[#98A0A9] italic">—</p>
    );

  return (
    <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Compare</span>
        <select value={left} onChange={(e) => setLeft(e.target.value)} className="field h-8 px-2 text-xs" aria-label="Older version">
          {versions.map((v) => (
            <option key={v.article.id} value={v.article.id}>
              v{v.article.version} · {v.article.status.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <span className="text-xs text-[#5B6470]">→</span>
        <select value={right} onChange={(e) => setRight(e.target.value)} className="field h-8 px-2 text-xs" aria-label="Newer version">
          {versions.map((v) => (
            <option key={v.article.id} value={v.article.id}>
              v{v.article.version} · {v.article.status.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <span className="text-xs text-[#5B6470]">
          {summary.changed} changed · {summary.added} added · {summary.removed} removed · {summary.same} same
        </span>
        <button type="button" onClick={onClose} className="btn-ghost h-8 px-3 text-xs ml-auto">
          Close
        </button>
      </div>
      {L && R && L.title.trim() !== R.title.trim() && (
        <p className="text-xs">
          <span className="chip bg-[#FFF1D6] text-[#9A6400]">title</span> {L.title} → {R.title}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-[#98A0A9]">Neither version has sections.</p>
      ) : (
        <div className="divide-y divide-[#EEF0EC]">
          {rows.map((r) => (
            <div key={r.key} className="grid gap-3 py-3 sm:grid-cols-[auto_1fr_1fr]">
              <span className={`chip self-start ${CHANGE_TONE[r.change]}`}>{r.change}</span>
              {cell(r.left, r.fields)}
              {cell(r.right, r.fields)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
