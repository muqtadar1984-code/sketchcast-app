"use client";

import { useState } from "react";

type Recap = {
  chapterTitle: string;
  attempted: boolean;
  scorePct: number | null;
  mastery: { score: number | null; band: string; label: string };
  practiceCount: number;
  weakQuestions: string[];
};

const BAND_TONE: Record<string, string> = {
  strong: "bg-[#E2F4F1] text-[#0C8175]",
  progressing: "bg-[#FFF1D6] text-[#9A6400]",
  needs_work: "bg-[#FDE7E3] text-[#B3401F]",
  not_started: "bg-[#EEF0EC] text-[#5B6470]",
};

// Aggregate coach recap for one student + chapter. Loaded on demand (a click, not
// an effect) so parent/teacher pages don't fetch a recap per row up front. Shows
// mastery band, quiz score, practice count and weak spots — never any chat.
export default function CoachRecap({ studentId, generationId }: { studentId: string; generationId: string }) {
  const [data, setData] = useState<Recap | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (data) {
      setOpen((v) => !v);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tutor/recap?studentId=${encodeURIComponent(studentId)}&generationId=${encodeURIComponent(generationId)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Couldn't load the recap.");
      setData((await res.json()) as Recap);
      setOpen(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-xs">
      <button onClick={load} disabled={busy} className="font-medium text-[#0C8175] hover:underline disabled:opacity-50">
        {busy ? "Loading recap…" : open ? "Hide coach recap" : "Coach recap"}
      </button>
      {error && <span className="ml-2 text-[#B42318]">{error}</span>}

      {open && data && (
        <div className="mt-2 rounded-lg bg-[#FAFBF9] border border-[#EEF0EC] px-3 py-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className={`chip font-sans normal-case tracking-normal ${BAND_TONE[data.mastery.band] ?? BAND_TONE.not_started}`}>
              {data.mastery.label}
              {data.mastery.score != null ? ` · ${data.mastery.score}` : ""}
            </span>
            {data.scorePct != null && <span className="text-[#5B6470]">Quiz {data.scorePct}%</span>}
            <span className="text-[#98A0A9]">Practised {data.practiceCount}×</span>
          </div>
          {data.weakQuestions.length > 0 ? (
            <div>
              <div className="text-[#5B6470] font-medium">Still shaky on:</div>
              <ul className="list-disc pl-4 text-[#5B6470]">
                {data.weakQuestions.slice(0, 3).map((q, i) => (
                  <li key={i} className="truncate">{q}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-[#5B6470]">{data.attempted ? "No weak spots from the last quiz." : "No quiz attempted yet."}</div>
          )}
        </div>
      )}
    </div>
  );
}
