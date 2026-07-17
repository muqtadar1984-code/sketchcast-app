"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { defaultParams } from "./options-modal";
import { NARRATION_STYLES, DEFAULT_STYLE, DEFAULT_VOICE, availableVoices } from "@/utils/narration";

const KINDS: { kind: string; label: string }[] = [
  { kind: "presentation", label: "Lesson" },
  { kind: "lesson_plan", label: "Plan" },
  { kind: "activity", label: "Activities" },
  { kind: "worksheet", label: "Worksheet" },
  { kind: "exam_paper", label: "Exam" },
  { kind: "case_study", label: "Case study" },
];

// Book-level batch generation: a chapters × kinds checkbox grid, one
// "Generate selected" click. Column headers select a kind for every chapter,
// the row checkbox selects every kind for a chapter. Each queued generation is
// tagged params.batch = true, which groups the results under the book's
// "Generated as selected" section (they also fill their chapter cells as
// usual — the section is the batch's own receipt, not the only home).
export default function BatchGenerate({
  bookId,
  schoolId,
  chapters,
  existingKeys,
}: {
  bookId: string;
  schoolId: string | null;
  chapters: { num: number; title: string }[];
  /** "num|kind" combos that ALREADY have a lesson — locked in the grid, so a
   * batch can never silently displace a finished (possibly assigned) lesson;
   * use the cell's own Regenerate for that. */
  existingKeys: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrationStyle, setNarrationStyle] = useState(DEFAULT_STYLE);
  const [ttsVoice, setTtsVoice] = useState(DEFAULT_VOICE);
  const voices = availableVoices();

  const key = (num: number, kind: string) => `${num}|${kind}`;
  const existing = new Set(existingKeys);
  const locked = (num: number, kind: string) => existing.has(key(num, kind));
  const has = (num: number, kind: string) => sel.has(key(num, kind));
  const setMany = (keys: string[], on: boolean) =>
    setSel((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (on && !existing.has(k)) next.add(k);
        else if (!on) next.delete(k);
      }
      return next;
    });
  const toggleCell = (num: number, kind: string) => setMany([key(num, kind)], !has(num, kind));
  // "All" states consider only the OPEN (not-yet-generated) cells.
  const openCells = (pred: (num: number, kind: string) => boolean) => {
    const cells: string[] = [];
    for (const c of chapters) for (const k of KINDS) if (pred(c.num, k.kind) && !locked(c.num, k.kind)) cells.push(key(c.num, k.kind));
    return cells;
  };
  const kindAll = (kind: string) => {
    const open = openCells((_n, k) => k === kind);
    return open.length > 0 && open.every((k) => sel.has(k));
  };
  const chapterAll = (num: number) => {
    const open = openCells((n) => n === num);
    return open.length > 0 && open.every((k) => sel.has(k));
  };

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
    const rows = [...sel].map((k) => {
      const [numStr, kind] = k.split("|");
      const params =
        kind === "presentation"
          ? { narration_style: narrationStyle, tts_voice: ttsVoice, batch: true }
          : { ...defaultParams(kind), batch: true };
      return {
        kind,
        book_id: bookId,
        owner_id: user.id,
        school_id: schoolId,
        chapter_ref: numStr,
        params,
        status: "queued",
      };
    });
    const { error: gErr } = await supabase.from("generations").insert(rows);
    setBusy(false);
    if (gErr) {
      setError(gErr.message);
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
        title="Pick any mix of chapters and content types, then generate them all at once"
      >
        {open ? "▾" : "▸"} Batch generate…
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-[#E6E8E4] bg-white p-3 overflow-x-auto">
          <table className="text-xs border-collapse">
            <thead>
              <tr className="text-[#5B6470]">
                <th className="text-left font-normal pr-3 pb-1.5">Chapter</th>
                <th className="pr-2 pb-1.5 font-normal" title="Select every type for the whole book">
                  All
                </th>
                {KINDS.map((k) => (
                  <th key={k.kind} className="px-2 pb-1.5 font-normal whitespace-nowrap">
                    <label className="flex items-center gap-1 cursor-pointer justify-center">
                      <input
                        type="checkbox"
                        checked={kindAll(k.kind)}
                        onChange={(e) => setMany(chapters.map((c) => key(c.num, k.kind)), e.target.checked)}
                        className="h-3.5 w-3.5 accent-[#0C8175]"
                      />
                      {k.label}
                    </label>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chapters.map((c) => (
                <tr key={c.num} className="border-t border-[#F1F3EF]">
                  <td className="pr-3 py-1.5 max-w-[260px] truncate text-[#14181F]">
                    <span className="text-[#98A0A9]">{c.num + 1}.</span> {c.title}
                  </td>
                  <td className="pr-2 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={chapterAll(c.num)}
                      onChange={(e) => setMany(KINDS.map((k) => key(c.num, k.kind)), e.target.checked)}
                      className="h-3.5 w-3.5 accent-[#0C8175]"
                      title="Every remaining type for this chapter"
                    />
                  </td>
                  {KINDS.map((k) =>
                    locked(c.num, k.kind) ? (
                      <td key={k.kind} className="px-2 py-1.5 text-center text-[#0C8175]" title="Already generated — use the chapter row's Regenerate to redo it">
                        ✓
                      </td>
                    ) : (
                      <td key={k.kind} className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={has(c.num, k.kind)}
                          onChange={() => toggleCell(c.num, k.kind)}
                          className="h-3.5 w-3.5 accent-[#0C8175]"
                        />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>

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
              {error && <span className="text-xs text-red-600">{error}</span>}
              <button
                onClick={() => void generate()}
                disabled={busy || sel.size === 0}
                className="btn-primary h-8 px-3 text-xs whitespace-nowrap disabled:opacity-50"
              >
                {busy ? "Queuing…" : `Generate selected (${sel.size})`}
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
