"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { defaultParams } from "./options-modal";
import { LANGUAGES } from "@/utils/narration";

// Revision papers (0061). A teacher picks a GROUP of chapters at term /
// mid-term / exam time and generates ONLY worksheets and/or exam papers — no
// videos, decks, plans, activities or case studies. Two modes:
//   · Combine → ONE cumulative paper spanning all the selected chapters
//     (a real revision/term paper; the worker grounds it on all of them).
//   · Per chapter → one paper per selected chapter (a revision pack).
// Revision papers are FREE — they're built from lessons you've already
// generated (the parent passes only chapters that have a lesson). Results
// appear in the book's "Revision papers" section.
const KINDS = [
  { kind: "worksheet", label: "Worksheet" },
  { kind: "exam_paper", label: "Test paper" },
] as const;

export default function BatchGenerate({
  bookId,
  schoolId,
  chapters,
  language = null,
}: {
  bookId: string;
  schoolId: string | null;
  chapters: { num: number; title: string }[];
  /** Detected book language (0056) — papers inherit it. */
  language?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [chapterSel, setChapterSel] = useState<Set<number>>(new Set());
  const [kindSel, setKindSel] = useState<Set<string>>(new Set(["worksheet"]));
  const [combine, setCombine] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Paper language — defaults to the book's, but a teacher can pick another
  // (e.g. Jawi for a Malay revision paper).
  const knownBookLang = LANGUAGES.some((l) => l.value === language) ? language! : "en";
  const [lang, setLang] = useState(knownBookLang);

  const toggleChapter = (num: number) =>
    setChapterSel((s) => {
      const next = new Set(s);
      next.has(num) ? next.delete(num) : next.add(num);
      return next;
    });
  const toggleKind = (kind: string) =>
    setKindSel((s) => {
      const next = new Set(s);
      next.has(kind) ? next.delete(kind) : next.add(kind);
      return next;
    });
  const allChapters = chapters.length > 0 && chapters.every((c) => chapterSel.has(c.num));

  const chosenChapters = chapters.filter((c) => chapterSel.has(c.num)).map((c) => c.num).sort((a, b) => a - b);
  const nKinds = kindSel.size;
  // combine → one paper per kind; per-chapter → one paper per (chapter × kind).
  const nPapers = combine ? nKinds : chosenChapters.length * nKinds;
  // Combining needs ≥2 chapters (one chapter isn't a "combination").
  const canGo = chosenChapters.length > 0 && nKinds > 0 && !(combine && chosenChapters.length < 2);

  async function generate() {
    if (nPapers === 0) return;
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

    // Build the paper list. Combine → one cumulative row per kind carrying the
    // chapter list; per-chapter → one row per (chapter, kind). All standalone
    // (params.revision) → the DB charges one credit each.
    type Row = { kind: string; book_id: string; owner_id: string; school_id: string | null; chapter_ref: string | null; params: Record<string, unknown>; status: string };
    const papers: Row[] = [];
    for (const kind of KINDS.map((k) => k.kind).filter((k) => kindSel.has(k))) {
      if (combine) {
        papers.push({
          kind,
          book_id: bookId,
          owner_id: user.id,
          school_id: schoolId,
          chapter_ref: null,
          params: { ...defaultParams(kind), revision: true, chapters: chosenChapters, language: lang },
          status: "queued",
        });
      } else {
        for (const num of chosenChapters) {
          papers.push({
            kind,
            book_id: bookId,
            owner_id: user.id,
            school_id: schoolId,
            chapter_ref: String(num),
            params: { ...defaultParams(kind), revision: true, language: lang },
            status: "queued",
          });
        }
      }
    }

    // One insert per paper so hitting the credit cap keeps the papers already
    // queued (each paper is independent).
    let queued = 0;
    let stopError: string | null = null;
    for (const row of papers) {
      const { error: gErr } = await supabase.from("generations").insert(row);
      if (gErr) {
        stopError = queued
          ? `Queued ${queued} paper${queued === 1 ? "" : "s"}, then stopped: ${gErr.message}`
          : gErr.message;
        break;
      }
      queued++;
    }
    setBusy(false);
    if (stopError) {
      setError(stopError);
      router.refresh();
      return;
    }
    setNote(`Queued ${queued} revision paper${queued === 1 ? "" : "s"} — see “Revision papers” below.`);
    setChapterSel(new Set());
    router.refresh();
  }

  if (!chapters.length) return null;

  return (
    <div className="py-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost h-8 px-3 text-xs"
        aria-expanded={open}
        title="Generate worksheets and test papers for revision across a group of chapters"
      >
        {open ? "▾" : "▸"} Revision papers…
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-[#E6E8E4] bg-white p-3">
          <p className="text-[10px] text-[#98A0A9] mb-2">
            For term, mid-term and exam revision: pick a group of chapters and generate worksheets
            and/or test papers — <span className="text-[#0C8175]">free</span>, from the lessons
            you&apos;ve already generated.
          </p>

          {/* Chapters */}
          <label className="flex items-center gap-1.5 text-xs cursor-pointer py-1 text-[#5B6470]">
            <input
              type="checkbox"
              checked={allChapters}
              onChange={(e) => setChapterSel(e.target.checked ? new Set(chapters.map((c) => c.num)) : new Set())}
              className="h-3.5 w-3.5 accent-[#0C8175]"
            />
            All taught chapters ({chapters.length})
          </label>
          <div className="max-h-44 overflow-y-auto divide-y divide-[#F1F3EF] mb-2">
            {chapters.map((c) => (
              <label key={c.num} className="flex items-center gap-1.5 text-xs py-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={chapterSel.has(c.num)}
                  onChange={() => toggleChapter(c.num)}
                  className="h-3.5 w-3.5 accent-[#0C8175]"
                />
                <span className="truncate text-[#14181F]">
                  <span className="text-[#98A0A9]">{c.num + 1}.</span> {c.title}
                </span>
              </label>
            ))}
          </div>

          {/* Kinds */}
          <div className="flex items-center gap-4 text-xs mb-2">
            <span className="text-[#98A0A9] uppercase tracking-wide text-[10px]">Papers</span>
            {KINDS.map((k) => (
              <label key={k.kind} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={kindSel.has(k.kind)}
                  onChange={() => toggleKind(k.kind)}
                  className="h-3.5 w-3.5 accent-[#0C8175]"
                />
                {k.label}
              </label>
            ))}
          </div>

          {/* Language */}
          <label className="flex items-center gap-1.5 text-xs mb-2">
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

          {/* Mode */}
          <div className="flex flex-col gap-1 text-xs mb-2">
            <span className="text-[#98A0A9] uppercase tracking-wide text-[10px]">Combine</span>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name={`mode-${bookId}`} checked={combine} onChange={() => setCombine(true)} className="accent-[#0C8175]" />
              One paper across the selected chapters
              <span className="text-[10px] text-[#98A0A9]">(a cumulative revision paper)</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name={`mode-${bookId}`} checked={!combine} onChange={() => setCombine(false)} className="accent-[#0C8175]" />
              One paper per chapter
              <span className="text-[10px] text-[#98A0A9]">(a revision pack)</span>
            </label>
          </div>
          {combine && chosenChapters.length === 1 && (
            <p className="text-[10px] text-[#9A6400] mb-1">Pick at least two chapters to combine — or switch to one per chapter.</p>
          )}

          <div className="flex items-center gap-3 mt-1">
            {error && <span className="text-xs text-red-600 [overflow-wrap:anywhere]">{error}</span>}
            {note && <span className="text-xs text-[#0C8175]">{note}</span>}
            <button
              onClick={() => void generate()}
              disabled={busy || !canGo || nPapers === 0}
              className="btn-primary h-8 px-3 text-xs whitespace-nowrap disabled:opacity-50 ml-auto"
            >
              {busy ? "Queuing…" : nPapers > 0 ? `Generate ${nPapers} paper${nPapers === 1 ? "" : "s"} (free)` : "Generate"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
