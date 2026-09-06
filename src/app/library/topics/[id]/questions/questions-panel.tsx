"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  COGNITIVE_LEVELS,
  DEFAULT_TARGET,
  ITEM_TYPE_LABEL,
  MCQ_KEYS,
  QUESTION_LIMITS,
  QUESTION_STATUS_TONE,
  TARGET_MAX,
  TARGET_MIN,
  answerSummary,
  canApproveQuestion,
  canCompose,
  canEditQuestion,
  canRejectQuestion,
  canRetireQuestion,
  mmss,
  modeCounts,
  questionEditOf,
  validateBlueprintSpec,
  validateQuestionEdit,
  type Blueprint,
  type DuplicateGroup,
  type MarkingPoint,
  type QuestionEdit,
  type QuestionOption,
  type QuestionSet,
  type TopicQuestion,
} from "@/utils/catalogue/questions";
import { isLiveJobStatus } from "@/utils/catalogue/status";
import type { BankMaturity } from "@/utils/catalogue/types";
import { JobSummary, fmtDate } from "../../../catalogue-ui";

// The question bank screen's interactive half (Phase 3, spec decision 8/9).
// Every control POSTs /api/library/topics/[id]/questions (or /compose) with
// {action, …} and then router.refresh() (the article-panel.tsx pattern). The
// `can*` flags come from the server; the routes re-check them, these only
// decide what renders. A reviewer sees the table and Approve / Reject only.
//
//   • Generate questions / Regenerate rejected — enqueue the topic_questions
//     job (one live per topic; the job's state is shown)
//   • the table: filters live in the URL (the page's <form method="get">),
//     a row expands into an editor (validateQuestionEdit runs here first, so
//     every problem shows before the round trip), per-row and bulk Approve /
//     Reject / Retire, a duplicate warning when two items open with the same
//     eight words, a misconception tooltip on an MCQ distractor that names one
//   • Compose — a blueprint select greyed with the reason canCompose gives
//     (maturity rung, or the buckets the approved counts cannot fill), a seed,
//     then the rendered generation and the list of past sets with their
//     signed DOCX / answer-key links

export type JobRow = { id: string; status: string; progress: number | null; stage: unknown; error: string | null; created_at: string };

export type ArticleRefsView = {
  id: string;
  version: number;
  objectives: { id: string; text: string }[];
  claims: { id: string; text: string }[];
  misconceptions: { id: string; misconception: string; correction: string }[];
  /** the RENDERED, labelled figures — what a diagram_label edit may name */
  figures: { figure_key: string; caption: string | null; labels: string[] }[];
};

export type SetView = QuestionSet & {
  blueprintName: string;
  generation: { id: string; status: string; error: string | null; created_at: string; progress: number | null; stage: unknown } | null;
  docx: string | null;
  answerKey: string | null;
};

type Post = (path: "questions" | "compose", payload: Record<string, unknown>, label: string) => Promise<Record<string, unknown> | null>;

function useBankPost(topicId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const post: Post = async (path, payload, label) => {
    setBusy(label);
    setError(null);
    setErrors([]);
    setNotice(null);
    const res = await fetch(`/api/library/topics/${topicId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    setBusy(null);
    if (!res.ok) {
      setError((json.error as string) ?? "Something went wrong.");
      if (Array.isArray(json.errors)) setErrors(json.errors.filter((e): e is string => typeof e === "string"));
      else if (Array.isArray(json.reasons)) setErrors(json.reasons.filter((e): e is string => typeof e === "string"));
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

function Messages({ error, errors, notice }: { error: string | null; errors: string[]; notice: string | null }) {
  return (
    <>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {errors.length > 0 && (
        <ul className="text-xs text-red-600 list-disc pl-5">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {notice && <p className="text-sm text-[#0F7A68]">{notice}</p>}
    </>
  );
}

export function QuestionStatusChip({ status }: { status: string }) {
  const tone = QUESTION_STATUS_TONE[status as keyof typeof QUESTION_STATUS_TONE] ?? "bg-[#EEF0EC] text-[#5B6470]";
  return <span className={`chip ${tone}`}>{status}</span>;
}

const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

// ── The panel ────────────────────────────────────────────────────────────────

export function QuestionsPanel({
  topicId,
  maturity,
  article,
  items,
  visible,
  duplicates,
  job,
  blueprints,
  sets,
  names,
  canEdit,
  canGenerate,
  canApprove,
  generateOn,
  ownerConfigured,
}: {
  topicId: string;
  maturity: BankMaturity | null;
  /** the approved English article, or null (nothing can be generated) */
  article: ArticleRefsView | null;
  /** every item of the bank (for counts, duplicates, compose) */
  items: TopicQuestion[];
  /** the items the URL filters leave visible — what the table shows */
  visible: TopicQuestion[];
  duplicates: DuplicateGroup[];
  job: JobRow | null;
  blueprints: Blueprint[];
  sets: SetView[];
  names: Record<string, string>;
  /** edit_article: the items (edit, retire) */
  canEdit: boolean;
  /** generate: Generate questions, Regenerate rejected, Compose — the three
   *  controls that spend model calls or build capacity (the routes ask for
   *  the same action) */
  canGenerate: boolean;
  canApprove: boolean;
  generateOn: boolean;
  ownerConfigured: boolean;
}) {
  const { post, busy, error, errors, notice, setNotice, clear } = useBankPost(topicId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [hints, setHints] = useState("");
  const [target, setTarget] = useState("");
  const [notes, setNotes] = useState("");

  const liveJob = !!job && isLiveJobStatus(job.status);
  const rejected = items.filter((q) => q.status === "rejected");
  const generateDisabledWhy = !generateOn
    ? "Catalogue generation is off (FEATURE_CATALOGUE_GENERATE)."
    : !article
      ? "Approve an article first — questions are written from the approved English article."
      : liveJob
        ? `A question job is already ${job!.status}.`
        : null;
  const dupOf = new Map<string, string[]>();
  for (const g of duplicates) for (const id of g.ids) dupOf.set(id, g.ids.filter((x) => x !== id));
  const misconceptionText = new Map((article?.misconceptions ?? []).map((m) => [m.id, `${m.misconception} → ${m.correction}`]));
  const objectiveText = new Map((article?.objectives ?? []).map((o) => [o.id, o.text]));
  const personName = (id: string | null) => (id ? (names[id] ?? shortId(id)) : "—");

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const visibleIds = visible.map((q) => q.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleAll = () => setSelected(allVisibleSelected ? new Set() : new Set(visibleIds));
  const selectedRows = visible.filter((q) => selected.has(q.id));
  const approvable = selectedRows.filter((q) => canApproveQuestion(q.status)).map((q) => q.id);
  const rejectable = selectedRows.filter((q) => canRejectQuestion(q.status)).map((q) => q.id);
  const retirable = selectedRows.filter((q) => canRetireQuestion(q.status)).map((q) => q.id);

  const generate = async (regenerate: boolean) => {
    const payload: Record<string, unknown> = regenerate ? { action: "regenerate_rejected", hints: hints.trim() || undefined } : { action: "generate", hints: hints.trim() || undefined, target: target.trim() || undefined };
    const r = await post("questions", payload, regenerate ? "regenerate" : "generate");
    if (r) {
      setGenerating(false);
      setHints("");
      setTarget("");
      setNotice(regenerate ? `Queued — the worker rewrites around the ${rejected.length} rejected item${rejected.length === 1 ? "" : "s"}.` : "Queued — the worker writes the drafts and they appear here.");
    }
  };

  const approve = async (ids: string[]) => {
    if (!ids.length) return;
    const r = await post("questions", { action: "approve", questionIds: ids }, "approve");
    if (r) {
      setSelected(new Set());
      const skipped = Number(r.skipped ?? 0);
      setNotice(`${r.approved} item${r.approved === 1 ? "" : "s"} approved${skipped ? ` · ${skipped} skipped (no longer a draft)` : ""}.`);
    }
  };
  const reject = async (ids: string[]) => {
    if (!ids.length) return;
    let why = notes.trim();
    if (!why) {
      why = (window.prompt("Why? Notes are required to reject (they steer Regenerate rejected).") ?? "").trim();
      if (!why) return;
    }
    const r = await post("questions", { action: "reject", questionIds: ids, notes: why }, "reject");
    if (r) {
      setSelected(new Set());
      setNotes("");
      setNotice(`${r.rejected} item${r.rejected === 1 ? "" : "s"} rejected.`);
    }
  };
  const retire = async (ids: string[]) => {
    if (!ids.length) return;
    if (!window.confirm(`Retire ${ids.length} item${ids.length === 1 ? "" : "s"}? Retired items leave the bank and are never composed.`)) return;
    const r = await post("questions", { action: "retire", questionIds: ids }, "retire");
    if (r) {
      setSelected(new Set());
      setNotice(`${r.retired} item${r.retired === 1 ? "" : "s"} retired.`);
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Generate ── */}
      <div className="card p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-medium">Question bank</h2>
            <p className="text-xs text-[#5B6470] mt-1">
              Items are written from the approved article ({DEFAULT_TARGET} drafts a run: half objective, half subjective), reviewed one by one, and composed into
              worksheets from the approved ones. Approval here is per item — the kit&apos;s gate is on the topic page.
            </p>
          </div>
          {canGenerate && (
            <div className="flex flex-col items-end gap-1 shrink-0">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!!busy || !!generateDisabledWhy}
                  title={generateDisabledWhy ?? undefined}
                  onClick={() => {
                    clear();
                    setGenerating((v) => !v);
                  }}
                  className="btn-primary h-9 px-4 text-sm disabled:opacity-50"
                >
                  Generate questions
                </button>
                <button
                  type="button"
                  disabled={!!busy || !!generateDisabledWhy || rejected.length === 0}
                  title={generateDisabledWhy ?? (rejected.length ? "Write again, steering away from what reviewers rejected (their notes lead the hints)" : "No rejected items to regenerate from")}
                  onClick={() => void generate(true)}
                  className="btn-ghost h-9 px-3 text-sm disabled:opacity-50"
                >
                  {busy === "regenerate" ? "Queuing…" : `Regenerate rejected (${rejected.length})`}
                </button>
              </div>
              {generateDisabledWhy && <span className="text-xs text-[#9A6400] max-w-xs text-right">{generateDisabledWhy}</span>}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-[#5B6470]">Latest question job:</span>
          <JobSummary job={job} never="none yet" />
        </div>
        {generating && (
          <div className="rounded-lg border border-[#EEF0EC] p-3 space-y-2 text-sm">
            <p className="text-xs text-[#5B6470]">
              The worker drafts {target.trim() || DEFAULT_TARGET} items across every objective (with a top-up for thin ones), each with its answer, marking
              scheme and explanation. Hints are optional: emphasis, item types to favour, what to avoid.
            </p>
            <div className="flex flex-wrap gap-2">
              <textarea value={hints} onChange={(e) => setHints(e.target.value)} maxLength={4000} rows={2} placeholder="Hints for the writer (optional)…" className="field flex-1 min-w-[16rem] px-3 py-2" />
              <label className="text-xs text-[#5B6470]">
                Target
                <input value={target} onChange={(e) => setTarget(e.target.value)} type="number" min={TARGET_MIN} max={TARGET_MAX} placeholder={String(DEFAULT_TARGET)} className="field h-9 w-20 px-2 ml-2" />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" disabled={!!busy || !!generateDisabledWhy} onClick={() => void generate(false)} className="btn-primary h-9 px-4">
                {busy === "generate" ? "Queuing…" : "Write"}
              </button>
              <button type="button" onClick={() => setGenerating(false)} className="btn-ghost h-9 px-3">
                Cancel
              </button>
            </div>
          </div>
        )}
        <Messages error={error} errors={errors} notice={notice} />
      </div>

      {/* ── Table ── */}
      <div className="card p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">
            Items <span className="text-sm text-[#5B6470] font-normal">({visible.length} shown of {items.length})</span>
          </h2>
          {(canApprove || canEdit) && visible.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-[#5B6470]">{selected.size} selected</span>
              {canApprove && (
                <>
                  <button type="button" disabled={!!busy || approvable.length === 0} onClick={() => void approve(approvable)} className="btn-primary h-8 px-3 disabled:opacity-50" title="Approve the selected drafts">
                    {busy === "approve" ? "…" : `Approve (${approvable.length})`}
                  </button>
                  <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Reject notes (required)…" className="field h-8 px-2 w-52" />
                  <button
                    type="button"
                    disabled={!!busy || rejectable.length === 0}
                    onClick={() => void reject(rejectable)}
                    className="h-8 px-3 rounded-lg bg-[#FFE9E3] text-[#B3401F] hover:bg-[#FFDCD2] disabled:opacity-50"
                    title="Reject the selected drafts / approved items (notes required)"
                  >
                    {busy === "reject" ? "…" : `Reject (${rejectable.length})`}
                  </button>
                </>
              )}
              {canEdit && (
                <button type="button" disabled={!!busy || retirable.length === 0} onClick={() => void retire(retirable)} className="btn-ghost h-8 px-3 disabled:opacity-50" title="Retire the selected items (out of the bank)">
                  {busy === "retire" ? "…" : `Retire (${retirable.length})`}
                </button>
              )}
            </div>
          )}
        </div>
        {visible.length === 0 ? (
          <p className="text-sm text-[#98A0A9]">{items.length ? "No item matches the filters." : "No items yet — generate some."}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[#EEF0EC]">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[#5B6470] border-b border-[#EEF0EC]">
                <tr>
                  {(canApprove || canEdit) && (
                    <th className="px-2 py-2 w-6">
                      <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="Select every visible item" />
                    </th>
                  )}
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Stem</th>
                  <th className="px-3 py-2 font-medium text-center" title="difficulty 1–5">
                    D
                  </th>
                  <th className="px-3 py-2 font-medium">Level</th>
                  <th className="px-3 py-2 font-medium text-right">Marks</th>
                  <th className="px-3 py-2 font-medium">Answer</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EEF0EC]">
                {visible.map((q) => {
                  const dups = dupOf.get(q.id) ?? [];
                  const misconceptions = Object.values(q.distractor_rationale ?? {})
                    .map((d) => (d && typeof d === "object" ? d.misconception_ref : null))
                    .filter((r): r is string => !!r);
                  const isEditing = editing === q.id;
                  return (
                    <Fragment key={q.id}>
                      <tr className={isEditing ? "bg-[#F4F6F3]" : "hover:bg-[#F8FAF7]"}>
                        {(canApprove || canEdit) && (
                          <td className="px-2 py-2">
                            <input type="checkbox" checked={selected.has(q.id)} onChange={() => toggle(q.id)} aria-label={`Select ${shortId(q.id)}`} />
                          </td>
                        )}
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="chip bg-[#F4F6F3] text-[#5B6470]">{ITEM_TYPE_LABEL[q.item_type] ?? q.item_type}</span>
                        </td>
                        <td className="px-3 py-2 min-w-[18rem]">
                          <span className="line-clamp-2" title={q.stem}>
                            {q.stem}
                          </span>
                          <span className="block text-xs text-[#98A0A9] mt-0.5">
                            <span title={objectiveText.get(q.objective_ref ?? "") ?? "objective not in the approved article"} className="font-mono">
                              {q.objective_ref ?? "no objective"}
                            </span>
                            {q.claim_ref && <span className="font-mono"> · {q.claim_ref}</span>}
                            {q.est_seconds != null && <> · {mmss(q.est_seconds)}</>}
                            {dups.length > 0 && (
                              <span className="ml-1 text-[#9A6400]" title={`Opens with the same eight words as ${dups.map(shortId).join(", ")} — probably the same question re-worded`}>
                                ⚠ duplicate?
                              </span>
                            )}
                            {misconceptions.length > 0 && (
                              <span className="ml-1 text-[#5B3FBF] cursor-help" title={misconceptions.map((r) => misconceptionText.get(r) ?? r).join("\n")}>
                                ◆ misconception
                              </span>
                            )}
                            {q.notes && (
                              <span className="ml-1 text-[#B3401F]" title={q.notes}>
                                ✎ notes
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center tabular">{q.difficulty}</td>
                        <td className="px-3 py-2 text-[#5B6470] whitespace-nowrap">{q.cognitive_level}</td>
                        <td className="px-3 py-2 text-right tabular">{q.marks}</td>
                        <td className="px-3 py-2 text-[#5B6470] max-w-[12rem] truncate" title={answerSummary(q)}>
                          {answerSummary(q)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <QuestionStatusChip status={q.status} />
                          {q.reviewer_id && (
                            <span className="block text-xs text-[#98A0A9]" title={q.reviewed_at ? `Reviewed ${fmtDate(q.reviewed_at)}` : undefined}>
                              {personName(q.reviewer_id)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-right">
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            {canEdit && canEditQuestion(q.status) && (
                              <button type="button" disabled={!!busy} onClick={() => setEditing(isEditing ? null : q.id)} className="btn-ghost h-7 px-2">
                                {isEditing ? "Close" : "Edit"}
                              </button>
                            )}
                            {canApprove && canApproveQuestion(q.status) && (
                              <button type="button" disabled={!!busy} onClick={() => void approve([q.id])} className="btn-primary h-7 px-2">
                                Approve
                              </button>
                            )}
                            {canApprove && canRejectQuestion(q.status) && (
                              <button type="button" disabled={!!busy} onClick={() => void reject([q.id])} className="h-7 px-2 rounded-lg bg-[#FFE9E3] text-[#B3401F] hover:bg-[#FFDCD2]">
                                Reject
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                      {isEditing && (
                        // The editor is a full-width row under the item.
                        <tr className="bg-[#F8FAF7]">
                          <td colSpan={canApprove || canEdit ? 9 : 8} className="px-3 py-3">
                            {article ? (
                              <RowEditor
                                question={q}
                                article={article}
                                busy={busy === "save"}
                                errors={errors}
                                onCancel={() => setEditing(null)}
                                onSave={async (item) => {
                                  const r = await post("questions", { action: "save", questionId: q.id, item }, "save");
                                  if (r) {
                                    setEditing(null);
                                    setNotice(r.demoted ? "Saved — the item went back to draft for re-review (it was approved)." : "Saved.");
                                  }
                                }}
                              />
                            ) : (
                              <p className="text-xs text-[#B3401F]">The approved article is gone; this item cannot be edited against it.</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Compose ── */}
      <ComposeBox
        items={items}
        maturity={maturity}
        blueprints={blueprints}
        sets={sets}
        canGenerate={canGenerate}
        generateOn={generateOn}
        ownerConfigured={ownerConfigured}
        busy={busy}
        personName={personName}
        onCompose={async (blueprintId, seed) => {
          const r = await post("compose", { blueprintId, seed: seed.trim() || undefined }, "compose");
          if (r) setNotice("Composed — the worker renders the worksheet and its answer key; they appear in the sets below.");
          return !!r;
        }}
      />
    </div>
  );
}

// ── The row editor ───────────────────────────────────────────────────────────

function RowEditor({
  question,
  article,
  busy,
  errors,
  onSave,
  onCancel,
}: {
  question: TopicQuestion;
  article: ArticleRefsView;
  busy: boolean;
  errors: string[];
  onSave: (item: QuestionEdit) => Promise<void>;
  onCancel: () => void;
}) {
  const [item, setItem] = useState<QuestionEdit>(() => questionEditOf(question));
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const isMcq = item.item_type === "mcq";
  const isTF = item.item_type === "true_false";
  const keyed = Array.isArray(item.options) ? (item.options as QuestionOption[]) : null;
  // Free-form answers are edited as text when the answer is {text} (or
  // empty); any other shape (a numerical {value, unit}, a match mapping) is
  // edited as JSON so nothing the worker wrote is lost by the editor.
  const answerIsText = !isMcq && !isTF && (Object.keys(item.answer).length === 0 || (Object.keys(item.answer).every((k) => k === "text" || k === "key")));
  const [answerJson, setAnswerJson] = useState(() => JSON.stringify(item.answer, null, 2));
  const [optionsJson, setOptionsJson] = useState(() => (item.options && !Array.isArray(item.options) ? JSON.stringify(item.options, null, 2) : ""));
  const patch = (fn: (i: QuestionEdit) => QuestionEdit) => setItem((i) => fn(i));
  const shown = localErrors.length ? localErrors : errors;
  const answerKey = typeof item.answer.key === "string" ? (item.answer.key as string) : "";

  const setOption = (i: number, fn: (o: QuestionOption) => QuestionOption) => patch((it) => ({ ...it, options: (it.options as QuestionOption[]).map((o, j) => (j === i ? fn(o) : o)) }));
  const setWhy = (key: string, fn: (d: { why_wrong: string; misconception_ref?: string | null }) => { why_wrong: string; misconception_ref?: string | null }) =>
    patch((it) => ({ ...it, distractor_rationale: { ...(it.distractor_rationale ?? {}), [key]: fn(it.distractor_rationale?.[key] ?? { why_wrong: "" }) } }));
  const setPoint = (i: number, fn: (p: MarkingPoint) => MarkingPoint) => patch((it) => ({ ...it, marking_scheme: it.marking_scheme.map((p, j) => (j === i ? fn(p) : p)) }));

  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        let next: QuestionEdit = item;
        try {
          if (!isMcq && !isTF && !answerIsText) next = { ...next, answer: JSON.parse(answerJson) };
          if (optionsJson.trim()) next = { ...next, options: JSON.parse(optionsJson) };
        } catch {
          setLocalErrors(["The answer / options JSON does not parse."]);
          return;
        }
        // Keyed options are A–D by POSITION (the key column is read-only and
        // shows exactly that): the worker keys them so, validateQuestionEdit
        // refuses anything else, and bank_worksheet prints the key verbatim.
        if ((isMcq || item.item_type === "assertion_reason") && Array.isArray(next.options)) {
          next = { ...next, options: (next.options as QuestionOption[]).map((o, i) => ({ ...o, key: MCQ_KEYS[i] ?? o.key })) };
        }
        const v = validateQuestionEdit(next, article);
        if (!v.ok) {
          setLocalErrors(v.errors);
          return;
        }
        setLocalErrors([]);
        await onSave(v.item);
      }}
    >
      <label className="block">
        <span className="text-xs text-[#5B6470]">Stem</span>
        <textarea value={item.stem} onChange={(e) => patch((i) => ({ ...i, stem: e.target.value }))} maxLength={QUESTION_LIMITS.stem} rows={3} required className="field w-full px-3 py-2 mt-1" />
      </label>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <label className="block lg:col-span-2">
          <span className="text-xs text-[#5B6470]">Objective</span>
          <select value={item.objective_ref} onChange={(e) => patch((i) => ({ ...i, objective_ref: e.target.value }))} className="field h-9 w-full px-2 mt-1">
            <option value="">— pick —</option>
            {article.objectives.map((o) => (
              <option key={o.id} value={o.id}>
                {o.id} · {o.text.slice(0, 60)}
              </option>
            ))}
          </select>
        </label>
        <label className="block lg:col-span-2">
          <span className="text-xs text-[#5B6470]">Claim (optional)</span>
          <select value={item.claim_ref ?? ""} onChange={(e) => patch((i) => ({ ...i, claim_ref: e.target.value || null }))} className="field h-9 w-full px-2 mt-1">
            <option value="">—</option>
            {article.claims.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} · {c.text.slice(0, 60)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Difficulty</span>
          <select value={item.difficulty} onChange={(e) => patch((i) => ({ ...i, difficulty: Number(e.target.value) }))} className="field h-9 w-full px-2 mt-1">
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Level</span>
          <select value={item.cognitive_level} onChange={(e) => patch((i) => ({ ...i, cognitive_level: e.target.value as QuestionEdit["cognitive_level"] }))} className="field h-9 w-full px-2 mt-1">
            {COGNITIVE_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Marks</span>
          <input type="number" min={1} max={QUESTION_LIMITS.marks} value={item.marks} onChange={(e) => patch((i) => ({ ...i, marks: Number(e.target.value) }))} className="field h-9 w-full px-2 mt-1" />
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Seconds</span>
          <input type="number" min={10} max={QUESTION_LIMITS.est_seconds} value={item.est_seconds ?? ""} onChange={(e) => patch((i) => ({ ...i, est_seconds: e.target.value === "" ? null : Number(e.target.value) }))} className="field h-9 w-full px-2 mt-1" />
        </label>
      </div>

      {/* ── Options + answer, per type ── */}
      {isMcq && keyed && (
        <div className="space-y-1.5">
          <span className="text-xs text-[#5B6470]">Options — tick the answer; every other option needs a why_wrong (and may name a misconception)</span>
          {keyed.map((o, i) => {
            const isAnswer = o.key.toUpperCase() === answerKey.toUpperCase();
            const d = item.distractor_rationale?.[o.key] ?? item.distractor_rationale?.[o.key.toUpperCase()];
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[auto_1fr_1fr_auto] items-center">
                <label className="inline-flex items-center gap-1.5 text-xs">
                  <input type="radio" name={`answer-${question.id}`} checked={isAnswer} onChange={() => patch((it) => ({ ...it, answer: { key: o.key.toUpperCase() } }))} />
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#EEF0EC] bg-[#F4F6F3] font-mono text-xs" aria-label="Option key" title="Options are keyed A–D by position (the worker's rule)">
                    {MCQ_KEYS[i] ?? o.key}
                  </span>
                </label>
                <input value={o.text} onChange={(e) => setOption(i, (x) => ({ ...x, text: e.target.value }))} maxLength={QUESTION_LIMITS.option} placeholder="Option text" className="field h-8 px-2" />
                <input
                  value={isAnswer ? "" : (d?.why_wrong ?? "")}
                  disabled={isAnswer}
                  onChange={(e) => setWhy(o.key, (x) => ({ ...x, why_wrong: e.target.value }))}
                  maxLength={QUESTION_LIMITS.why_wrong}
                  placeholder={isAnswer ? "(the answer)" : "Why this is wrong…"}
                  className="field h-8 px-2 disabled:bg-[#F4F6F3]"
                />
                <select
                  value={isAnswer ? "" : (d?.misconception_ref ?? "")}
                  disabled={isAnswer}
                  onChange={(e) => setWhy(o.key, (x) => ({ ...x, misconception_ref: e.target.value || null }))}
                  className="field h-8 px-1 text-xs max-w-[12rem] disabled:bg-[#F4F6F3]"
                  title="The article misconception this distractor embodies (optional)"
                >
                  <option value="">no misconception</option>
                  {article.misconceptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} · {m.misconception.slice(0, 40)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
      {isTF && (
        <label className="block">
          <span className="text-xs text-[#5B6470]">Answer</span>
          <select value={item.answer.value === true ? "true" : item.answer.value === false ? "false" : ""} onChange={(e) => patch((i) => ({ ...i, answer: { value: e.target.value === "true" } }))} className="field h-9 px-2 mt-1 block">
            <option value="">—</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </label>
      )}
      {!isMcq && !isTF && keyed && (
        <div className="space-y-1.5">
          <span className="text-xs text-[#5B6470]">Options — tick the answer</span>
          {keyed.map((o, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[auto_1fr] items-center">
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input type="radio" name={`answer-${question.id}`} checked={o.key.toUpperCase() === answerKey.toUpperCase()} onChange={() => patch((it) => ({ ...it, answer: { ...it.answer, key: o.key.toUpperCase() } }))} />
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#EEF0EC] bg-[#F4F6F3] font-mono text-xs" aria-label="Option key" title="Options are keyed A–D by position (the worker's rule)">
                    {MCQ_KEYS[i] ?? o.key}
                  </span>
              </label>
              <input value={o.text} onChange={(e) => setOption(i, (x) => ({ ...x, text: e.target.value }))} maxLength={QUESTION_LIMITS.option} className="field h-8 px-2" />
            </div>
          ))}
        </div>
      )}
      {!isMcq && !isTF && !keyed && item.options && (
        <label className="block">
          <span className="text-xs text-[#5B6470]">Options (JSON — a match item&apos;s pairs)</span>
          <textarea value={optionsJson} onChange={(e) => setOptionsJson(e.target.value)} rows={4} className="field w-full px-3 py-2 mt-1 font-mono text-xs" />
        </label>
      )}
      {!isMcq && !isTF && answerIsText && (
        <label className="block">
          <span className="text-xs text-[#5B6470]">Answer</span>
          <textarea value={typeof item.answer.text === "string" ? (item.answer.text as string) : ""} onChange={(e) => patch((i) => ({ ...i, answer: { ...i.answer, text: e.target.value } }))} maxLength={QUESTION_LIMITS.answer_text} rows={3} className="field w-full px-3 py-2 mt-1" />
        </label>
      )}
      {!isMcq && !isTF && !answerIsText && (
        <label className="block">
          <span className="text-xs text-[#5B6470]">Answer (JSON — keeps the worker&apos;s shape)</span>
          <textarea value={answerJson} onChange={(e) => setAnswerJson(e.target.value)} rows={4} className="field w-full px-3 py-2 mt-1 font-mono text-xs" />
        </label>
      )}

      {/* ── Marking scheme ── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-[#5B6470]">
            Marking scheme {item.marking_scheme.length > 0 && <>· adds up to {item.marking_scheme.reduce((n, p) => n + (Number(p.marks) || 0), 0)} of {item.marks}</>}
          </span>
          <button type="button" onClick={() => patch((i) => ({ ...i, marking_scheme: [...i.marking_scheme, { point: "", marks: 1 }] }))} className="btn-ghost h-7 px-2 text-xs">
            + point
          </button>
        </div>
        {item.marking_scheme.map((p, i) => (
          <div key={i} className="grid gap-2 grid-cols-[1fr_5rem_auto] items-center">
            <input value={p.point} onChange={(e) => setPoint(i, (x) => ({ ...x, point: e.target.value }))} maxLength={QUESTION_LIMITS.point} placeholder="What earns the mark…" className="field h-8 px-2" />
            <input type="number" min={0.5} step={0.5} value={p.marks} onChange={(e) => setPoint(i, (x) => ({ ...x, marks: Number(e.target.value) }))} className="field h-8 px-2" aria-label="Marks for this point" />
            <button type="button" onClick={() => patch((it) => ({ ...it, marking_scheme: it.marking_scheme.filter((_, j) => j !== i) }))} className="text-xs text-[#B3401F] hover:underline">
              remove
            </button>
          </div>
        ))}
      </div>

      <label className="block">
        <span className="text-xs text-[#5B6470]">Explanation</span>
        <textarea value={item.explanation ?? ""} onChange={(e) => patch((i) => ({ ...i, explanation: e.target.value || null }))} maxLength={QUESTION_LIMITS.explanation} rows={2} className="field w-full px-3 py-2 mt-1" />
      </label>
      <label className="block">
        <span className="text-xs text-[#5B6470]">Tags (comma-separated)</span>
        <input value={item.tags.join(", ")} onChange={(e) => patch((i) => ({ ...i, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }))} className="field h-9 w-full px-3 mt-1" />
      </label>

      {shown.length > 0 && (
        <ul className="text-xs text-red-600 list-disc pl-5">
          {shown.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="btn-primary h-9 px-4">
          {busy ? "Saving…" : question.status === "approved" ? "Save (back to draft)" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="btn-ghost h-9 px-3">
          Cancel
        </button>
        {question.status === "approved" && <span className="text-xs text-[#9A6400]">An approved item that is edited goes back to draft for re-review.</span>}
      </div>
    </form>
  );
}

// ── Compose ──────────────────────────────────────────────────────────────────

function ComposeBox({
  items,
  maturity,
  blueprints,
  sets,
  canGenerate,
  generateOn,
  ownerConfigured,
  busy,
  personName,
  onCompose,
}: {
  items: TopicQuestion[];
  maturity: BankMaturity | null;
  blueprints: Blueprint[];
  sets: SetView[];
  /** Compose inserts a generation — the `generate` action, like the kit route */
  canGenerate: boolean;
  generateOn: boolean;
  ownerConfigured: boolean;
  busy: string | null;
  personName: (id: string | null) => string;
  onCompose: (blueprintId: string, seed: string) => Promise<boolean>;
}) {
  const counts = modeCounts(items);
  // Every ACTIVE preset, with the reason it is greyed (the same arithmetic the
  // worker runs — spec decision 9 — so an offered preset is one it will fill).
  const options = blueprints
    .filter((b) => b.status === "active")
    .map((b) => {
      const spec = validateBlueprintSpec(b.spec);
      const check = spec.ok ? canCompose(spec.spec, counts, { have: maturity, need: b.min_maturity }) : { ok: false, reasons: spec.errors, plan: null };
      return { b, ok: check.ok, reasons: check.reasons };
    });
  const [blueprintId, setBlueprintId] = useState<string>(options.find((o) => o.ok)?.b.id ?? "");
  const [seed, setSeed] = useState("");
  const picked = options.find((o) => o.b.id === blueprintId) ?? null;
  const disabledWhy = !generateOn
    ? "Catalogue generation is off (FEATURE_CATALOGUE_GENERATE)."
    : !ownerConfigured
      ? "Catalogue owner not configured (CATALOGUE_OWNER_ID)."
      : options.length === 0
        ? "No active blueprint — create one on the Blueprints tab."
        : !picked
          ? "Pick a blueprint."
          : !picked.ok
            ? `The bank cannot fill this blueprint yet: ${picked.reasons.join("; ")}.`
            : null;

  return (
    <div className="card p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">Compose a worksheet</h2>
          <p className="text-xs text-[#5B6470] mt-1">
            A blueprint says how many items, the objective / subjective split and the difficulty mix; the worker draws APPROVED items to fill every bucket exactly
            (never padding), spread across the objectives, and renders a student DOCX plus a separate answer key with the curriculum header. A preset is greyed
            when the bank cannot fill it yet.{" "}
            <Link href="/library/blueprints" className="underline">
              Blueprints
            </Link>
          </p>
        </div>
      </div>
      {canGenerate && (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="block flex-1 min-w-[16rem]">
            <span className="text-xs text-[#5B6470]">Blueprint</span>
            <select value={blueprintId} onChange={(e) => setBlueprintId(e.target.value)} className="field h-9 w-full px-2 mt-1" title={picked && !picked.ok ? picked.reasons.join("; ") : undefined}>
              <option value="">— pick —</option>
              {options.map(({ b, ok, reasons }) => (
                <option key={b.id} value={b.id} disabled={!ok} title={ok ? undefined : reasons.join("; ")}>
                  {b.name} · {b.spec?.count ?? "?"} items · min {String(b.min_maturity).replace(/_/g, " ")}
                  {ok ? "" : " — cannot fill yet"}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-[#5B6470]">Seed (optional)</span>
            <input value={seed} onChange={(e) => setSeed(e.target.value)} type="number" min={0} placeholder="fresh" className="field h-9 w-28 px-2 mt-1" title="The same seed on the same bank draws the same items" />
          </label>
          <button
            type="button"
            disabled={!!busy || !!disabledWhy}
            title={disabledWhy ?? "Record the set and queue the worksheet render"}
            onClick={() => void onCompose(blueprintId, seed)}
            className="btn-primary h-9 px-4 disabled:opacity-50"
          >
            {busy === "compose" ? "Composing…" : "Compose"}
          </button>
        </div>
      )}
      {canGenerate && picked && !picked.ok && (
        <ul className="text-xs text-[#9A6400] list-disc pl-5">
          {picked.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {canGenerate && disabledWhy && (!picked || picked.ok) && <p className="text-xs text-[#9A6400]">{disabledWhy}</p>}

      <h3 className="text-xs font-medium text-[#5B6470] uppercase tracking-wide">Past sets</h3>
      {sets.length === 0 ? (
        <p className="text-sm text-[#98A0A9]">None yet.</p>
      ) : (
        <ul className="divide-y divide-[#EEF0EC] text-sm">
          {sets.map((s) => (
            <li key={s.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="font-medium">{s.blueprintName}</span>
                <span className="text-xs text-[#5B6470]">
                  {" "}
                  · seed {s.seed} · {s.question_ids.length ? `${s.question_ids.length} items` : "items chosen by the worker"} · {fmtDate(s.created_at)} · {personName(s.requested_by)}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs">
                {s.generation ? <JobSummary job={s.generation} /> : <span className="text-[#98A0A9]">not rendered</span>}
                {s.docx && (
                  <a href={s.docx} className="underline">
                    Worksheet.docx
                  </a>
                )}
                {s.answerKey && (
                  <a href={s.answerKey} className="underline">
                    Answer key.docx
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
