"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { kitRows } from "./kit";
import { NARRATION_STYLES, DEFAULT_STYLE, availableVoices, defaultVoiceFor } from "@/utils/narration";

// Book-level batch generation (0059: the KIT is the unit). One checkbox per
// chapter queues that chapter's full kit — the video lesson plus all five
// documents (one lesson credit each, documents free). Chapters whose lesson
// already exists are locked here: their missing documents are free add-backs
// on the chapter row, and Regenerate lives in the cells.
// Each queued row is tagged params.batch = true, which groups the results
// under the book's "Generated as selected" section as the batch's receipt.
export default function BatchGenerate({
  bookId,
  schoolId,
  chapters,
  existingKeys,
  language = null,
}: {
  bookId: string;
  schoolId: string | null;
  chapters: { num: number; title: string }[];
  /** "num|kind" combos that ALREADY have a lesson — a chapter with an existing
   * presentation is locked (its kit has started; use the row's own controls). */
  existingKeys: string[];
  /** Detected book language (0056) — batch lessons inherit it + its voice. */
  language?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrationStyle, setNarrationStyle] = useState(DEFAULT_STYLE);
  const [ttsVoice, setTtsVoice] = useState(defaultVoiceFor(language));
  const voices = availableVoices(language);

  const existing = new Set(existingKeys);
  const started = new Set(
    existingKeys.filter((k) => k.endsWith("|presentation")).map((k) => Number(k.split("|")[0])),
  );
  const openChapters = chapters.filter((c) => !started.has(c.num));
  const toggle = (num: number) =>
    setSel((s) => {
      const next = new Set(s);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
  const allSelected = openChapters.length > 0 && openChapters.every((c) => sel.has(c.num));
  const setAll = (on: boolean) => setSel(on ? new Set(openChapters.map((c) => c.num)) : new Set());

  async function generate() {
    if (sel.size === 0) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in.");
      setBusy(false);
      return;
    }
    // One INSERT per kit (presentation row FIRST — the DB's docs-with-lesson
    // guard reads earlier rows of the same insert). Chunking per chapter means
    // hitting the credit cap midway keeps everything already queued instead of
    // aborting the whole batch. Legacy standalone docs are skipped, not
    // duplicated.
    let queued = 0;
    let stopError: string | null = null;
    for (const num of [...sel].sort((a, z) => a - z)) {
      const rows = kitRows({
        bookId,
        schoolId,
        userId: user.id,
        chapterNum: num,
        language,
        narrationStyle,
        ttsVoice,
        batch: true,
      }).filter((r) => r.kind === "presentation" || !existing.has(`${num}|${r.kind}`));
      const { error: gErr } = await supabase.from("generations").insert(rows);
      if (gErr) {
        stopError = queued
          ? `Queued ${queued} kit${queued === 1 ? "" : "s"}, then stopped at chapter ${num + 1}: ${gErr.message}`
          : gErr.message;
        break;
      }
      queued++;
    }
    setBusy(false);
    if (stopError) {
      setError(stopError);
      router.refresh(); // the queued kits are real — show them
      return;
    }
    setSel(new Set());
    setOpen(false);
    router.refresh();
  }

  if (!chapters.length) return null;

  return (
    <div className="py-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost h-8 px-3 text-xs"
        aria-expanded={open}
        title="Pick chapters and generate their full kits (lesson + documents) at once — one credit per lesson part (long chapters render as several parts)"
      >
        {open ? "▾" : "▸"} Batch generate…
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-[#E6E8E4] bg-white p-3">
          <p className="text-[10px] text-[#98A0A9] mb-1.5">
            Each kit = the video lesson + plan, activities, worksheet, exam and case study. The
            documents are free; the lesson costs one credit per rendered part (long chapters render
            as several ~15-minute parts).
          </p>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer py-1 text-[#5B6470]">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => setAll(e.target.checked)}
              className="h-3.5 w-3.5 accent-[#0C8175]"
              disabled={openChapters.length === 0}
            />
            All remaining chapters ({openChapters.length})
          </label>
          <div className="max-h-56 overflow-y-auto divide-y divide-[#F1F3EF]">
            {chapters.map((c) =>
              started.has(c.num) ? (
                <div key={c.num} className="flex items-center gap-1.5 text-xs py-1.5 text-[#98A0A9]" title="Kit started — finish or regenerate from the chapter row">
                  <span className="w-3.5 text-center text-[#0C8175]">✓</span>
                  <span className="truncate">
                    <span className="text-[#98A0A9]">{c.num + 1}.</span> {c.title}
                  </span>
                </div>
              ) : (
                <label key={c.num} className="flex items-center gap-1.5 text-xs py-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sel.has(c.num)}
                    onChange={() => toggle(c.num)}
                    className="h-3.5 w-3.5 accent-[#0C8175]"
                  />
                  <span className="truncate text-[#14181F]">
                    <span className="text-[#98A0A9]">{c.num + 1}.</span> {c.title}
                  </span>
                </label>
              ),
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-[#5B6470]">Narration</span>
              <select value={narrationStyle} onChange={(e) => setNarrationStyle(e.target.value)} className="field h-8 px-2 text-xs">
                {NARRATION_STYLES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-[#5B6470]">Voice</span>
              <select value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)} className="field h-8 px-2 text-xs">
                {voices.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                    {v.tier === "premium" ? " ★ premium" : ""}
                  </option>
                ))}
              </select>
            </label>
            <span className="ml-auto flex items-center gap-3">
              {error && <span className="text-xs text-red-600 [overflow-wrap:anywhere]">{error}</span>}
              <button
                onClick={() => void generate()}
                disabled={busy || sel.size === 0}
                className="btn-primary h-8 px-3 text-xs whitespace-nowrap disabled:opacity-50"
              >
                {busy ? "Queuing…" : `Generate ${sel.size} kit${sel.size === 1 ? "" : "s"}`}
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
