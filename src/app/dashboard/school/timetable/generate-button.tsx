"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Teacher = { id: string; name: string };
type Unplaced = { class: string; subject: string; count: number };

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
}: {
  teachers: Teacher[];
  subjects: string[];
  /** subject -> teacher ids, inferred server-side (onboarding subjects + current grid). */
  initialMapping: Record<string, string[]>;
  /** The subjects that run once every day (config override or the default four). */
  coreNames: string[];
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
      if (!res.ok) throw new Error(d?.error || "Generation failed.");
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
        ✨ Auto-generate
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div
            className="card w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg">Auto-generate the timetable</h2>
            <p className="text-sm text-[#5B6470] mt-1 mb-4">
              Confirm who teaches what — the class teacher takes Period 1 every day, core subjects (
              {coreNames.join(", ")}) run once every day, the other subjects fill the rest of the week, and no teacher
              is ever in two rooms at once.
            </p>

            <div className="space-y-2 mb-4">
              {subjects.map((s) => (
                <div key={s} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm w-36 shrink-0 text-[#14181F]">{s}</span>
                  {teachers.map((t) => {
                    const on = (mapping[s] ?? []).includes(t.id);
                    return (
                      <button
                        key={t.id}
                        onClick={() => toggle(s, t.id)}
                        aria-pressed={on}
                        className={`chip font-sans cursor-pointer ${on ? "bg-[#E2F4F1] text-[#0C8175]" : "bg-[#F4F6F3] text-[#98A0A9]"}`}
                      >
                        {t.name.split(" ")[0]}
                      </button>
                    );
                  })}
                  {!(mapping[s] ?? []).length && <span className="text-[10px] text-[#9A6400]">no teacher — will be reported as a gap</span>}
                </div>
              ))}
            </div>

            <div className="flex items-center gap-4 mb-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={mode === "fill"} onChange={() => setMode("fill")} />
                Fill gaps (keep what&apos;s already placed)
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} />
                Start over (replace the whole grid)
              </label>
            </div>

            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            {result && (
              <div className="rounded-lg bg-[#F4F6F3] px-4 py-3 mb-3 text-sm">
                <p>
                  ✅ Placed <span className="tabular">{result.placed}</span> lessons
                  {result.kept ? ` (kept ${result.kept} existing)` : ""}.
                </p>
                {result.unplaced.length > 0 ? (
                  <div className="mt-2">
                    <p className="text-[#9A6400]">Couldn&apos;t staff {result.unplaced.length} gap{result.unplaced.length === 1 ? "" : "s"}:</p>
                    <ul className="mt-1 text-xs text-[#5B6470] list-disc pl-4">
                      {result.unplaced.slice(0, 10).map((u, i) => (
                        <li key={i}>
                          {u.class}: {u.subject} ×{u.count}
                        </li>
                      ))}
                      {result.unplaced.length > 10 && <li>…and {result.unplaced.length - 10} more</li>}
                    </ul>
                    <p className="text-xs text-[#5B6470] mt-1">Assign more teachers to those subjects and run “Fill gaps”.</p>
                  </div>
                ) : (
                  <p className="text-[#0C8175] mt-1">No gaps — the week is fully staffed.</p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-xs text-[#98A0A9]">{assignedCount}/{subjects.length} subjects staffed</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setOpen(false)} className="btn-ghost h-10 px-4 text-sm">
                  {result ? "Done" : "Cancel"}
                </button>
                <button onClick={() => void generate()} disabled={busy} className="btn-primary h-10 px-4 text-sm disabled:opacity-50">
                  {busy ? "Generating…" : result ? "Run again" : "Generate"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
