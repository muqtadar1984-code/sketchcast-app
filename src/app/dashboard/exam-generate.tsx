"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { LANGUAGES } from "@/utils/narration";

// Exam generation (0062). A teacher builds ONE cumulative exam over everything
// covered so far — any mix of chapters and parts. It produces TWO documents:
//   · the exam paper, and
//   · a SEPARATE answer key (never assigned to students).
// The teacher sets the difficulty and how many questions of each type to write,
// and ticks exactly which chapters/parts to test — unticking any topic to skip
// it this time. Free, like revision papers: an exam is built from lessons
// already generated (the parent passes only covered units).

export type ExamUnit = { part: number; label: string };
export type ExamChapterOpt = { num: number; title: string; units: ExamUnit[] };

const QTYPES = [
  { key: "mcq", label: "Multiple choice", def: 10 },
  { key: "fill_blank", label: "Fill in the blanks", def: 5 },
  { key: "true_false", label: "True / False", def: 5 },
  { key: "match_column", label: "Match the columns", def: 5 },
  { key: "short_answer", label: "Short answer", def: 4 },
  { key: "long_answer", label: "Long answer", def: 3 },
] as const;

const DIFFICULTIES = ["easy", "medium", "hard", "mixed"] as const;

const unitKey = (num: number, part: number) => `${num}:${part}`;

export default function ExamGenerate({
  bookId,
  schoolId,
  chapters,
  language = null,
}: {
  bookId: string;
  schoolId: string | null;
  /** Covered units only — chapters/parts that already have a live lesson. */
  chapters: ExamChapterOpt[];
  /** Detected book language (0056) — the exam inherits it by default. */
  language?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Every covered unit is ticked by default — the teacher unticks to skip.
  const allKeys = chapters.flatMap((c) => c.units.map((u) => unitKey(c.num, u.part)));
  const [sel, setSel] = useState<Set<string>>(() => new Set(allKeys));
  const [counts, setCounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(QTYPES.map((q) => [q.key, q.def])),
  );
  const [difficulty, setDifficulty] = useState<string>("medium");
  const [title, setTitle] = useState("");
  const knownBookLang = LANGUAGES.some((l) => l.value === language) ? language! : "en";
  const [lang, setLang] = useState(knownBookLang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const toggleUnit = (key: string) =>
    setSel((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const toggleChapter = (c: ExamChapterOpt) =>
    setSel((s) => {
      const next = new Set(s);
      const keys = c.units.map((u) => unitKey(c.num, u.part));
      const allOn = keys.every((k) => next.has(k));
      keys.forEach((k) => (allOn ? next.delete(k) : next.add(k)));
      return next;
    });
  const setCount = (key: string, v: number) =>
    setCounts((c) => ({ ...c, [key]: Math.max(0, Math.min(20, v || 0)) }));

  const chosen = chapters
    .flatMap((c) => c.units.map((u) => ({ chapter: String(c.num), part: u.part, key: unitKey(c.num, u.part) })))
    .filter((u) => sel.has(u.key));
  const totalQ = QTYPES.reduce((n, q) => n + (counts[q.key] || 0), 0);
  const canGo = chosen.length > 0 && totalQ > 0;

  async function generate() {
    if (!canGo) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in.");
      setBusy(false);
      return;
    }
    const { error: gErr } = await supabase.from("generations").insert({
      kind: "exam",
      book_id: bookId,
      owner_id: user.id,
      school_id: schoolId,
      chapter_ref: null,
      params: {
        scope: chosen.map((u) => ({ chapter: u.chapter, part: u.part })),
        counts,
        difficulty,
        language: lang,
        ...(title.trim() ? { title: title.trim() } : {}),
      },
      status: "queued",
    });
    setBusy(false);
    if (gErr) {
      setError(gErr.message);
      return;
    }
    setNote("Exam queued — the paper and its answer key appear under “Exams” below.");
    router.refresh();
  }

  if (!chapters.length) return null;

  return (
    <div className="py-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost h-8 px-3 text-xs"
        aria-expanded={open}
        title="Build a cumulative exam (paper + answer key) over the chapters and parts you've taught"
      >
        {open ? "▾" : "▸"} Exam…
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-[#E6E8E4] bg-white p-3">
          <p className="text-[10px] text-[#98A0A9] mb-2">
            A cumulative exam over everything you&apos;ve taught — one <span className="text-[#0C8175]">exam paper</span> plus a
            separate <span className="text-[#0C8175]">answer key</span>. Tick the chapters and parts to test (untick to skip),
            set the difficulty and how many questions of each type. <span className="text-[#0C8175]">Free</span>.
          </p>

          {/* Coverage tree — chapters and their covered parts */}
          <p className="text-[10px] uppercase tracking-wide text-[#98A0A9] mb-1">What to test</p>
          <div className="max-h-48 overflow-y-auto divide-y divide-[#F1F3EF] mb-3">
            {chapters.map((c) => {
              const keys = c.units.map((u) => unitKey(c.num, u.part));
              const allOn = keys.every((k) => sel.has(k));
              const someOn = keys.some((k) => sel.has(k));
              const multi = c.units.length > 1 || (c.units[0] && c.units[0].part > 0);
              return (
                <div key={c.num} className="py-1.5">
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allOn}
                      ref={(el) => {
                        if (el) el.indeterminate = someOn && !allOn;
                      }}
                      onChange={() => toggleChapter(c)}
                      className="h-3.5 w-3.5 accent-[#0C8175]"
                    />
                    <span className="truncate text-[#14181F]">
                      <span className="text-[#98A0A9]">{c.num + 1}.</span> {c.title}
                    </span>
                  </label>
                  {multi && (
                    <div className="pl-5 mt-0.5 flex flex-wrap gap-x-4 gap-y-1">
                      {c.units.map((u) => (
                        <label key={u.part} className="flex items-center gap-1.5 text-[11px] cursor-pointer text-[#5B6470]">
                          <input
                            type="checkbox"
                            checked={sel.has(unitKey(c.num, u.part))}
                            onChange={() => toggleUnit(unitKey(c.num, u.part))}
                            className="h-3 w-3 accent-[#0C8175]"
                          />
                          {u.label}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Question mix */}
          <p className="text-[10px] uppercase tracking-wide text-[#98A0A9] mb-1">Questions per type</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 mb-3">
            {QTYPES.map((q) => (
              <label key={q.key} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-[#5B6470]">{q.label}</span>
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={counts[q.key]}
                  onChange={(e) => setCount(q.key, parseInt(e.target.value || "0", 10))}
                  className="w-14 h-7 px-2 rounded-lg border border-[#E6E8E4] text-xs text-right outline-none focus:border-[#1FB8A6]"
                />
              </label>
            ))}
          </div>

          {/* Difficulty · title · language */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-[#98A0A9] uppercase tracking-wide text-[10px]">Difficulty</span>
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className="field h-8 px-2 text-xs capitalize">
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d} className="capitalize">
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-[#98A0A9] uppercase tracking-wide text-[10px]">Language</span>
              <select value={lang} onChange={(e) => setLang(e.target.value)} className="field h-8 px-2 text-xs">
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                    {knownBookLang === l.value ? " (book)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs flex-1 min-w-[10rem]">
              <span className="text-[#98A0A9] uppercase tracking-wide text-[10px]">Title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Mid-term Exam (optional)"
                className="field h-8 px-2 text-xs flex-1"
              />
            </label>
          </div>

          <div className="flex items-center gap-3">
            {error && <span className="text-xs text-red-600 [overflow-wrap:anywhere]">{error}</span>}
            {note && <span className="text-xs text-[#0C8175]">{note}</span>}
            <span className="text-[10px] text-[#98A0A9]">
              {chosen.length} unit{chosen.length === 1 ? "" : "s"} · {totalQ} question{totalQ === 1 ? "" : "s"}
            </span>
            <button
              onClick={() => void generate()}
              disabled={busy || !canGo}
              className="btn-primary h-8 px-3 text-xs whitespace-nowrap disabled:opacity-50 ml-auto"
            >
              {busy ? "Queuing…" : "Generate exam (free)"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
