"use client";

import { useState } from "react";
import { ARTICLE_LIMITS, articleBodyOf, nextId, validateArticle, wordCount } from "@/utils/catalogue/article";
import type { ArticleBody, ArticleFigure, ArticleFigureInput, ArticleSection, TopicArticle } from "@/utils/catalogue/types";
import { FigureStatusChip } from "../../catalogue-ui";

// The article editor (Phase 2b): every editable part of a draft / in-review
// version — title, objectives, sections (markdown body, figure keys, covered
// objectives), figures (key, caption, spec: subject + parts as a tag list),
// glossary, misconceptions, worked examples, claims, depth rationale. The
// state IS an ArticleBody; Save hands it to the parent, which POSTs
// {action: "save", articleId, article}. The route runs validateArticle; the
// same validator runs here first so the member sees every problem before the
// round trip. Renderer-owned figure fields (status, asset, labels, error) are
// shown, never edited.

type FigureView = ArticleFigure & { url: string | null };

/** The keys of ArticleBody that hold a list — what the row helpers below may
 *  index into (title and depth_rationale are scalars). */
type ListKey = { [K in keyof ArticleBody]: ArticleBody[K] extends readonly unknown[] ? K : never }[keyof ArticleBody];

export function ArticleEditor({
  article,
  figures,
  busy,
  errors,
  onSave,
  onCancel,
}: {
  article: TopicArticle;
  figures: FigureView[];
  busy: boolean;
  errors: string[];
  onSave: (body: ArticleBody) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState<ArticleBody>(() => articleBodyOf(article, figures));
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const existingByKey = new Map(figures.map((f) => [f.figure_key, f]));
  const patch = (fn: (b: ArticleBody) => ArticleBody) => setBody((b) => fn(b));
  const words = wordCount(body);
  const shown = localErrors.length ? localErrors : errors;

  const updateAt = <K extends ListKey>(key: K, i: number, fn: (item: ArticleBody[K][number]) => ArticleBody[K][number]) =>
    patch((b) => ({ ...b, [key]: (b[key] as unknown[]).map((it, j) => (j === i ? fn(it as ArticleBody[K][number]) : it)) }));
  const removeAt = (key: ListKey, i: number) => patch((b) => ({ ...b, [key]: (b[key] as unknown[]).filter((_, j) => j !== i) }));
  const move = (key: ListKey, i: number, dir: -1 | 1) =>
    patch((b) => {
      const list = [...(b[key] as unknown[])];
      const j = i + dir;
      if (j < 0 || j >= list.length) return b;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...b, [key]: list };
    });

  return (
    <form
      className="space-y-5 text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        const v = validateArticle(body);
        if (!v.ok) {
          setLocalErrors(v.errors);
          return;
        }
        setLocalErrors([]);
        await onSave(v.article);
      }}
    >
      <label className="block">
        <span className="text-xs text-[#5B6470]">Title</span>
        <input value={body.title} onChange={(e) => patch((b) => ({ ...b, title: e.target.value }))} required maxLength={ARTICLE_LIMITS.title} className="field w-full h-9 px-3 mt-1" />
      </label>

      {/* ── Objectives ── */}
      <Block title="Objectives" count={body.objectives.length} onAdd={() => patch((b) => ({ ...b, objectives: [...b.objectives, { id: nextId("obj", b.objectives), text: "" }] }))}>
        {body.objectives.map((o, i) => (
          <Row key={o.id} id={o.id} onRemove={() => removeAt("objectives", i)}>
            <input value={o.text} onChange={(e) => updateAt("objectives", i, (x) => ({ ...x, text: e.target.value }))} maxLength={ARTICLE_LIMITS.claim} placeholder="What the learner can do afterwards…" className="field h-9 px-3 flex-1" />
          </Row>
        ))}
      </Block>

      {/* ── Sections ── */}
      <Block
        title="Sections"
        count={body.sections.length}
        onAdd={() => patch((b) => ({ ...b, sections: [...b.sections, { id: nextId("sec", b.sections), heading: "", body_md: "", figure_keys: [], covers: [] }] }))}
      >
        {body.sections.map((s, i) => (
          <div key={s.id} className="rounded-lg border border-[#EEF0EC] p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-[#98A0A9] shrink-0">{s.id}</span>
              <input value={s.heading} onChange={(e) => updateAt("sections", i, (x) => ({ ...x, heading: e.target.value }))} maxLength={ARTICLE_LIMITS.heading} placeholder="Heading" className="field h-9 px-3 flex-1 font-medium" />
              <MoveButtons up={() => move("sections", i, -1)} down={() => move("sections", i, 1)} first={i === 0} last={i === body.sections.length - 1} />
              <RemoveButton onClick={() => removeAt("sections", i)} />
            </div>
            <textarea
              value={s.body_md}
              onChange={(e) => updateAt("sections", i, (x) => ({ ...x, body_md: e.target.value }))}
              maxLength={ARTICLE_LIMITS.body_md}
              rows={Math.min(24, Math.max(6, s.body_md.split("\n").length + 1))}
              placeholder="Body (markdown)…"
              className="field w-full px-3 py-2 font-mono text-xs leading-relaxed"
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <CheckList
                label="Figures in this section"
                options={body.figures.map((f) => ({ value: f.figure_key, label: f.figure_key }))}
                values={s.figure_keys}
                empty="No figures yet — add one below."
                onChange={(figure_keys) => updateAt("sections", i, (x) => ({ ...x, figure_keys }))}
              />
              <CheckList
                label="Covers objectives"
                options={body.objectives.map((o) => ({ value: o.id, label: `${o.id} · ${o.text || "(blank)"}` }))}
                values={s.covers}
                empty="No objectives yet."
                onChange={(covers) => updateAt("sections", i, (x) => ({ ...x, covers }))}
              />
            </div>
          </div>
        ))}
      </Block>

      {/* ── Figures ── */}
      <Block
        title="Figures"
        count={body.figures.length}
        hint="What to draw. The renderer files each figure in the visual library under its key and labels the parts as groups; a rendered figure keeps its asset when you edit the caption."
        onAdd={() => patch((b) => ({ ...b, figures: [...b.figures, { figure_key: "", caption: null, spec: { subject: "", parts: [], style: null, notes: null }, sort: b.figures.length }] }))}
      >
        {body.figures.map((f, i) => {
          const existing = existingByKey.get(f.figure_key);
          return (
            <div key={`${i}-${existing?.id ?? "new"}`} className="rounded-lg border border-[#EEF0EC] p-3 grid gap-2 sm:grid-cols-[1fr_auto]">
              <div className="space-y-2 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {existing ? (
                    <span className="font-mono text-xs text-[#1F5B99]" title="The key is fixed once the figure exists — it is what the asset is filed under">
                      {f.figure_key}
                    </span>
                  ) : (
                    <input
                      value={f.figure_key}
                      onChange={(e) => updateAt("figures", i, (x) => ({ ...x, figure_key: e.target.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_") }))}
                      maxLength={ARTICLE_LIMITS.figure_key}
                      placeholder="figure_key (snake_case)"
                      className="field h-9 px-3 font-mono text-xs w-56"
                    />
                  )}
                  <FigureStatusChip status={existing?.status ?? "new"} />
                  <MoveButtons up={() => move("figures", i, -1)} down={() => move("figures", i, 1)} first={i === 0} last={i === body.figures.length - 1} />
                  <RemoveButton
                    onClick={() => removeAt("figures", i)}
                    title={existing && existing.status !== "draft" ? "A rendered figure is kept on the server; removing it here only unplaces it." : "Remove"}
                  />
                </div>
                <input value={f.caption ?? ""} onChange={(e) => updateAt("figures", i, (x) => ({ ...x, caption: e.target.value || null }))} maxLength={ARTICLE_LIMITS.caption} placeholder="Caption" className="field h-9 px-3 w-full" />
                <input
                  value={f.spec.subject}
                  onChange={(e) => updateAt("figures", i, (x) => ({ ...x, spec: { ...x.spec, subject: e.target.value } }))}
                  maxLength={ARTICLE_LIMITS.caption}
                  placeholder="Subject — what to draw (e.g. a plant cell in cross-section)"
                  className="field h-9 px-3 w-full"
                />
                <TagList label="Parts to label" values={f.spec.parts} max={ARTICLE_LIMITS.parts} onChange={(parts) => updateAt("figures", i, (x) => ({ ...x, spec: { ...x.spec, parts } }))} />
                <div className="grid gap-2 sm:grid-cols-2">
                  <input value={f.spec.style ?? ""} onChange={(e) => updateAt("figures", i, (x) => ({ ...x, spec: { ...x.spec, style: e.target.value || null } }))} maxLength={120} placeholder="Style (optional)" className="field h-9 px-3" />
                  <input value={f.spec.notes ?? ""} onChange={(e) => updateAt("figures", i, (x) => ({ ...x, spec: { ...x.spec, notes: e.target.value || null } }))} maxLength={500} placeholder="Notes for the renderer (optional)" className="field h-9 px-3" />
                </div>
                {existing?.render_error && (
                  <p className="text-xs text-[#B3401F]" title={existing.render_error}>
                    Render failed: {existing.render_error}
                  </p>
                )}
              </div>
              <div className="w-full sm:w-40 shrink-0">
                {existing?.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={existing.url} alt={f.caption ?? f.spec.subject} className="w-full rounded bg-[#F8FAF7]" />
                ) : (
                  <div className="h-24 rounded bg-[#F4F6F3] flex items-center justify-center text-xs text-[#98A0A9] text-center px-2">
                    {existing?.visual_asset_id ? "Preview unavailable" : "Not rendered"}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </Block>

      {/* ── Glossary ── */}
      <Block title="Glossary" count={body.glossary.length} onAdd={() => patch((b) => ({ ...b, glossary: [...b.glossary, { term: "", definition: "" }] }))}>
        {body.glossary.map((g, i) => (
          <Row key={i} onRemove={() => removeAt("glossary", i)}>
            <input value={g.term} onChange={(e) => updateAt("glossary", i, (x) => ({ ...x, term: e.target.value }))} maxLength={ARTICLE_LIMITS.term} placeholder="Term" className="field h-9 px-3 w-44" />
            <input value={g.definition} onChange={(e) => updateAt("glossary", i, (x) => ({ ...x, definition: e.target.value }))} maxLength={ARTICLE_LIMITS.definition} placeholder="Definition" className="field h-9 px-3 flex-1" />
          </Row>
        ))}
      </Block>

      {/* ── Misconceptions ── */}
      <Block
        title="Misconceptions"
        count={body.misconceptions.length}
        onAdd={() => patch((b) => ({ ...b, misconceptions: [...b.misconceptions, { id: nextId("mis", b.misconceptions), misconception: "", correction: "" }] }))}
      >
        {body.misconceptions.map((m, i) => (
          <Row key={m.id} id={m.id} onRemove={() => removeAt("misconceptions", i)}>
            <input value={m.misconception} onChange={(e) => updateAt("misconceptions", i, (x) => ({ ...x, misconception: e.target.value }))} maxLength={ARTICLE_LIMITS.definition} placeholder="What learners often think…" className="field h-9 px-3 flex-1" />
            <input value={m.correction} onChange={(e) => updateAt("misconceptions", i, (x) => ({ ...x, correction: e.target.value }))} maxLength={ARTICLE_LIMITS.definition} placeholder="…and what is true" className="field h-9 px-3 flex-1" />
          </Row>
        ))}
      </Block>

      {/* ── Worked examples ── */}
      <Block
        title="Worked examples"
        count={body.worked_examples.length}
        onAdd={() => patch((b) => ({ ...b, worked_examples: [...b.worked_examples, { id: nextId("wex", b.worked_examples), problem: "", solution_md: "" }] }))}
      >
        {body.worked_examples.map((w, i) => (
          <div key={w.id} className="rounded-lg border border-[#EEF0EC] p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-[#98A0A9]">{w.id}</span>
              <span className="flex-1" />
              <RemoveButton onClick={() => removeAt("worked_examples", i)} />
            </div>
            <textarea value={w.problem} onChange={(e) => updateAt("worked_examples", i, (x) => ({ ...x, problem: e.target.value }))} maxLength={ARTICLE_LIMITS.body_md} rows={2} placeholder="Problem" className="field w-full px-3 py-2" />
            <textarea value={w.solution_md} onChange={(e) => updateAt("worked_examples", i, (x) => ({ ...x, solution_md: e.target.value }))} maxLength={ARTICLE_LIMITS.body_md} rows={4} placeholder="Solution (markdown)" className="field w-full px-3 py-2 font-mono text-xs" />
          </div>
        ))}
      </Block>

      {/* ── Claims ── */}
      <Block
        title="Claims"
        count={body.claims.length}
        hint="Discrete facts and formulas, each tied to the section that states it — question authoring draws on these."
        onAdd={() => patch((b) => ({ ...b, claims: [...b.claims, { id: nextId("clm", b.claims), text: "", section_id: b.sections[0]?.id ?? "" }] }))}
      >
        {body.claims.map((c, i) => (
          <Row key={c.id} id={c.id} onRemove={() => removeAt("claims", i)}>
            <input value={c.text} onChange={(e) => updateAt("claims", i, (x) => ({ ...x, text: e.target.value }))} maxLength={ARTICLE_LIMITS.claim} placeholder="The fact, as one sentence" className="field h-9 px-3 flex-1" />
            <select value={c.section_id} onChange={(e) => updateAt("claims", i, (x) => ({ ...x, section_id: e.target.value }))} className="field h-9 px-2 w-48" aria-label="Section">
              <option value="">— section —</option>
              {body.sections.map((s: ArticleSection) => (
                <option key={s.id} value={s.id}>
                  {s.heading || s.id}
                </option>
              ))}
            </select>
          </Row>
        ))}
      </Block>

      <label className="block">
        <span className="text-xs text-[#5B6470]">Depth rationale — why the article goes as deep as it does (the depth node&apos;s demand)</span>
        <textarea value={body.depth_rationale ?? ""} onChange={(e) => patch((b) => ({ ...b, depth_rationale: e.target.value || null }))} maxLength={ARTICLE_LIMITS.depth_rationale} rows={2} className="field w-full px-3 py-2 mt-1" />
      </label>

      {shown.length > 0 && (
        <ul className="text-sm text-red-600 list-disc pl-5 space-y-0.5">
          {shown.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className="btn-primary h-9 px-4">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="btn-ghost h-9 px-3">
          Cancel
        </button>
        <span className="text-xs text-[#5B6470] ml-auto tabular">{words.toLocaleString()} words</span>
      </div>
    </form>
  );
}

// ── Small pieces ────────────────────────────────────────────────────────────

function Block({ title, count, hint, onAdd, children }: { title: string; count: number; hint?: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <div className="flex items-center gap-2">
        <legend className="text-xs font-medium text-[#5B6470] uppercase tracking-wide">
          {title} <span className="font-normal">({count})</span>
        </legend>
        <button type="button" onClick={onAdd} className="ml-auto text-xs text-[#1F5B99] hover:underline">
          + Add
        </button>
      </div>
      {hint && <p className="text-xs text-[#98A0A9]">{hint}</p>}
      {children}
    </fieldset>
  );
}

function Row({ id, onRemove, children }: { id?: string; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {id && <span className="font-mono text-xs text-[#98A0A9] w-14 shrink-0 truncate">{id}</span>}
      {children}
      <RemoveButton onClick={onRemove} />
    </div>
  );
}

function RemoveButton({ onClick, title = "Remove" }: { onClick: () => void; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} className="text-xs text-[#B3401F] hover:underline shrink-0">
      Remove
    </button>
  );
}

function MoveButtons({ up, down, first, last }: { up: () => void; down: () => void; first: boolean; last: boolean }) {
  return (
    <span className="inline-flex gap-1 shrink-0">
      <button type="button" onClick={up} disabled={first} aria-label="Move up" className="btn-ghost h-8 w-8 text-xs disabled:opacity-30">
        ↑
      </button>
      <button type="button" onClick={down} disabled={last} aria-label="Move down" className="btn-ghost h-8 w-8 text-xs disabled:opacity-30">
        ↓
      </button>
    </span>
  );
}

function CheckList({
  label,
  options,
  values,
  empty,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  values: string[];
  empty: string;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="text-xs">
      <p className="text-[#5B6470] mb-1">{label}</p>
      {options.length === 0 ? (
        <p className="text-[#98A0A9]">{empty}</p>
      ) : (
        <ul className="space-y-0.5 max-h-32 overflow-y-auto">
          {options
            .filter((o) => o.value)
            .map((o) => (
              <li key={o.value}>
                <label className="inline-flex items-start gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={values.includes(o.value)}
                    onChange={(e) => onChange(e.target.checked ? [...values, o.value] : values.filter((v) => v !== o.value))}
                    className="mt-0.5"
                  />
                  <span className="truncate max-w-[18rem]">{o.label}</span>
                </label>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/** A list of short strings as chips; Enter or comma adds, × removes. */
function TagList({ label, values, max, onChange }: { label: string; values: string[]; max: number; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...values];
    for (const p of parts) if (!next.includes(p) && next.length < max) next.push(p.slice(0, ARTICLE_LIMITS.part));
    onChange(next);
    setDraft("");
  };
  return (
    <div className="text-xs">
      <p className="text-[#5B6470] mb-1">
        {label} <span className="text-[#98A0A9]">({values.length}/{max})</span>
      </p>
      <div className="flex flex-wrap items-center gap-1.5 field px-2 py-1.5 min-h-9">
        {values.map((v) => (
          <span key={v} className="chip bg-[#EEF0EC] text-[#14181F] inline-flex items-center gap-1">
            {v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="text-[#5B6470] hover:text-[#B3401F]">
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={add}
          maxLength={ARTICLE_LIMITS.part}
          placeholder={values.length ? "" : "nucleus, membrane, … (Enter adds)"}
          className="flex-1 min-w-32 bg-transparent outline-none h-6"
        />
      </div>
    </div>
  );
}

export type { ArticleFigureInput };
