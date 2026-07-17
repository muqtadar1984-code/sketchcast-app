"use client";

import { useMemo, useState } from "react";

// Absences & cover for one date. Everyone is assumed PRESENT until the
// principal or a coordinator marks them absent here; marking calls the
// absence API, which computes cover automatically (subject teacher first,
// then the class teacher, then the lightest day) and returns the plan. Every
// assignment stays hand-editable, and "No cover found" is shown honestly —
// that's a staffing gap to act on, not a blank to hide.

export type AbsenceRow = { id: string; teacher_id: string; on_date: string; reason: string | null };
export type SubRow = {
  id: string;
  absence_id: string;
  class_id: string;
  on_date: string;
  period: number;
  subject: string;
  original_teacher_id: string | null;
  substitute_teacher_id: string | null;
};

function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA");
}

export default function AbsencePanel({
  teachers,
  classNames,
  periodLabels,
  initialAbsences,
  initialSubs,
  canMark,
}: {
  teachers: { id: string; name: string }[];
  classNames: Record<string, string>;
  periodLabels: string[];
  initialAbsences: AbsenceRow[];
  initialSubs: SubRow[];
  canMark: boolean;
}) {
  const [date, setDate] = useState(todayLocal());
  const [absences, setAbsences] = useState<AbsenceRow[]>(initialAbsences);
  const [subs, setSubs] = useState<SubRow[]>(initialSubs);
  const [markTeacher, setMarkTeacher] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teacherName = useMemo(() => new Map(teachers.map((t) => [t.id, t.name] as const)), [teachers]);
  const dayAbsences = absences.filter((a) => a.on_date === date);
  const absentIds = new Set(dayAbsences.map((a) => a.teacher_id));

  async function mark() {
    if (!markTeacher || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/timetable/absence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacher_id: markTeacher, date, reason: reason.trim() || undefined }),
      });
      const json = (await res.json()) as { error?: string; absence_id?: string; substitutions?: SubRow[]; note?: string };
      if (!res.ok || !json.absence_id) {
        setError(json.error ?? "Could not mark the absence.");
      } else {
        setAbsences((prev) => [
          ...prev.filter((a) => !(a.teacher_id === markTeacher && a.on_date === date)),
          { id: json.absence_id!, teacher_id: markTeacher, on_date: date, reason: reason.trim() || null },
        ]);
        // The API returns the WHOLE date's plan (marking someone can re-cover
        // other absences' orphaned assignments) — replace the date wholesale.
        setSubs((prev) => [...prev.filter((s) => s.on_date !== date), ...(json.substitutions ?? [])]);
        setMarkTeacher("");
        setReason("");
        if (json.note) setError(json.note);
      }
    } catch {
      setError("Network error.");
    }
    setBusy(false);
  }

  async function unmark(absenceId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/timetable/absence", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: absenceId }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) setError(json.error ?? "Could not remove the absence.");
      else {
        setAbsences((prev) => prev.filter((a) => a.id !== absenceId));
        setSubs((prev) => prev.filter((s) => s.absence_id !== absenceId));
      }
    } catch {
      setError("Network error.");
    }
    setBusy(false);
  }

  async function changeSub(subId: string, substitute: string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/timetable/absence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: subId, substitute_teacher_id: substitute }),
      });
      const json = (await res.json()) as { error?: string; substitution?: SubRow };
      if (!res.ok || !json.substitution) setError(json.error ?? "Could not update the cover.");
      else setSubs((prev) => prev.map((s) => (s.id === subId ? json.substitution! : s)));
    } catch {
      setError("Network error.");
    }
    setBusy(false);
  }

  return (
    <div className="card mt-4 p-4 print:hidden">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="font-medium text-sm">Absences &amp; cover</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="field h-9 px-2 text-sm" />
        <span className="text-[11px] text-[#98A0A9]">
          Everyone is assumed present until marked absent. Cover is computed when you mark — re-mark after
          big grid changes.
        </span>
      </div>

      {canMark && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <select value={markTeacher} onChange={(e) => setMarkTeacher(e.target.value)} className="field h-9 px-2 text-sm">
            <option value="">Mark a teacher absent…</option>
            {teachers
              .filter((t) => !absentIds.has(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            className="field h-9 px-3 text-sm w-44"
            maxLength={200}
          />
          <button onClick={() => void mark()} disabled={busy || !markTeacher} className="btn-primary h-9 px-3 text-sm disabled:opacity-50">
            {busy ? "Working…" : "Mark absent & assign cover"}
          </button>
        </div>
      )}
      {error && <p className="text-sm text-[#9A6400] mt-2">{error}</p>}

      {dayAbsences.length === 0 ? (
        <p className="text-sm text-[#5B6470] mt-3">No absences on {date} — full house. 🎉</p>
      ) : (
        dayAbsences.map((a) => {
          const mySubs = subs.filter((s) => s.absence_id === a.id).sort((x, y) => x.period - y.period);
          return (
            <div key={a.id} className="mt-3 border-t border-[#EEF0EC] pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{teacherName.get(a.teacher_id) ?? "Teacher"}</span>
                {a.reason && <span className="text-xs text-[#5B6470]">({a.reason})</span>}
                <span className="chip bg-[#FDECEA] text-[#B42318]">absent</span>
                {canMark && (
                  <button onClick={() => void unmark(a.id)} disabled={busy} className="text-xs text-[#B42318] hover:underline ml-auto">
                    Remove (back in school)
                  </button>
                )}
              </div>
              {mySubs.length === 0 ? (
                <p className="text-xs text-[#5B6470] mt-1">No lessons to cover that day.</p>
              ) : (
                <table className="w-full text-sm border-collapse mt-2">
                  <thead>
                    <tr className="bg-[#F5F6F3] text-xs text-[#5B6470]">
                      <th className="px-2 py-1.5 text-left font-normal w-20">Period</th>
                      <th className="px-2 py-1.5 text-left font-normal">Class</th>
                      <th className="px-2 py-1.5 text-left font-normal">Subject</th>
                      <th className="px-2 py-1.5 text-left font-normal">Covered by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mySubs.map((s) => (
                      <tr key={s.id} className="border-t border-[#EEF0EC]">
                        <td className="px-2 py-1.5 text-xs text-[#5B6470]">{periodLabels[s.period - 1] ?? `P${s.period}`}</td>
                        <td className="px-2 py-1.5">{classNames[s.class_id] ?? "Class"}</td>
                        <td className="px-2 py-1.5">{s.subject}</td>
                        <td className="px-2 py-1.5">
                          {canMark ? (
                            <select
                              value={s.substitute_teacher_id ?? ""}
                              onChange={(e) => void changeSub(s.id, e.target.value || null)}
                              className={`field h-8 px-2 text-sm ${s.substitute_teacher_id ? "" : "text-[#B42318]"}`}
                              disabled={busy}
                            >
                              <option value="">⚠ No cover found</option>
                              {teachers
                                .filter((t) => t.id !== s.original_teacher_id && !absentIds.has(t.id))
                                .map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name}
                                  </option>
                                ))}
                            </select>
                          ) : s.substitute_teacher_id ? (
                            teacherName.get(s.substitute_teacher_id) ?? "Teacher"
                          ) : (
                            <span className="text-[#B42318]">⚠ No cover found</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
