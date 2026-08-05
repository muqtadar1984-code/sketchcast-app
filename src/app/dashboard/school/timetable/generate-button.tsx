"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";

type Teacher = { id: string; name: string };
type Unplaced = { class: string; subject: string; count: number };

/** Every word the dialog renders, handed down by the (server) Timetable page. */
export type GenerateMessages = Dictionary["school"]["timetable"]["generate"] & Pick<Dictionary["common"], "cancel">;

// The auto-generate dialog (admin only): confirm who teaches what, pick a mode,
// and let the solver fill every class's week — class teachers are anchored into
// their own classes first, and no teacher is ever double-booked. "Fill gaps"
// treats every existing cell as pinned; "Start over" rebuilds the whole grid.
// Anything the staffing can't cover comes back as a named gap list, not a
// silent hole.
export default function GenerateButton({
  teachers,
  subjects,
  initialMapping,
  coreNames,
  t,
}: {
  teachers: Teacher[];
  subjects: string[];
  /** subject -> teacher ids, inferred server-side (onboarding subjects + current grid). */
  initialMapping: Record<string, string[]>;
  /** The subjects that run once every day (config override or the default four). */
  coreNames: string[];
  t: GenerateMessages;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string[]>>(initialMapping);
  const [mode, setMode] = useState<"fill" | "replace">("fill");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ placed: number; kept: number; unplaced: Unplaced[] } | null>(null);

  function toggle(subject: string, teacherId: string) {
    setMapping((m) => {
      const cur = m[subject] ?? [];
      return { ...m, [subject]: cur.includes(teacherId) ? cur.filter((t) => t !== teacherId) : [...cur, teacherId] };
    });
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/timetable/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, mapping }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || t.failed);
      setResult({ placed: d.placed ?? 0, kept: d.kept ?? 0, unplaced: d.unplaced ?? [] });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const assignedCount = Object.values(mapping).filter((ids) => ids.length).length;

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-primary h-9 px-4 text-sm">
        ✨ {t.button}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div
            className="card w-full max-w-2xl p-6 max-h-[90dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg">{t.title}</h2>
            <p className="text-sm text-[#5B6470] mt-1 mb-4">{fmt(t.intro, { core: coreNames.join(", ") })}</p>

            <div className="space-y-2 mb-4">
              {subjects.map((s) => (
                <div key={s} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm w-36 shrink-0 text-[#14181F]">{s}</span>
                  {teachers.map((teacher) => {
                    const on = (mapping[s] ?? []).includes(teacher.id);
                    return (
                      <button
                        key={teacher.id}
                        onClick={() => toggle(s, teacher.id)}
                        aria-pressed={on}
                        className={`chip font-sans cursor-pointer ${on ? "bg-[#E2F4F1] text-[#0C8175]" : "bg-[#F4F6F3] text-[#98A0A9]"}`}
                      >
                        {teacher.name.split(" ")[0]}
                      </button>
                    );
                  })}
                  {!(mapping[s] ?? []).length && <span className="text-[10px] text-[#9A6400]">{t.noTeacher}</span>}
                </div>
              ))}
            </div>

            <div className="flex items-center gap-4 mb-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={mode === "fill"} onChange={() => setMode("fill")} />
                {t.modeFill}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} />
                {t.modeReplace}
              </label>
            </div>

            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            {result && (
              <div className="rounded-lg bg-[#F4F6F3] px-4 py-3 mb-3 text-sm">
                <p>
                  ✅{" "}
                  {result.kept
                    ? fmt(t.placedKept, { n: result.placed, kept: result.kept })
                    : fmt(t.placed, { n: result.placed })}
                </p>
                {result.unplaced.length > 0 ? (
                  <div className="mt-2">
                    <p className="text-[#9A6400]">
                      {result.unplaced.length === 1 ? t.gapsOne : fmt(t.gapsMany, { n: result.unplaced.length })}
                    </p>
                    <ul className="mt-1 text-xs text-[#5B6470] list-disc ps-4">
                      {result.unplaced.slice(0, 10).map((u, i) => (
                        <li key={i}>{fmt(t.gapRow, { class: u.class, subject: u.subject, count: u.count })}</li>
                      ))}
                      {result.unplaced.length > 10 && <li>{fmt(t.andMore, { n: result.unplaced.length - 10 })}</li>}
                    </ul>
                    <p className="text-xs text-[#5B6470] mt-1">{t.gapsHint}</p>
                  </div>
                ) : (
                  <p className="text-[#0C8175] mt-1">{t.noGaps}</p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-xs text-[#98A0A9]">
                {fmt(t.staffed, { n: assignedCount, total: subjects.length })}
              </span>
              <div className="flex items-center gap-2">
                <button onClick={() => setOpen(false)} className="btn-ghost h-10 px-4 text-sm">
                  {result ? t.done : t.cancel}
                </button>
                <button onClick={() => void generate()} disabled={busy} className="btn-primary h-10 px-4 text-sm disabled:opacity-50">
                  {busy ? t.generating : result ? t.runAgain : t.generate}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
