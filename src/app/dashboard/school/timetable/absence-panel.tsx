"use client";

import { useMemo, useState } from "react";
import { isoWeekday } from "@/utils/substitution";
import { isLesson, type Slot } from "@/utils/timetable";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";

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

/** Every word this panel renders, handed down by the (server) Timetable page. */
export type AbsenceMessages = Dictionary["school"]["timetable"]["absence"] & {
  teacherFallback: string;
  classFallback: string;
};

// "en-CA" is the ISO yyyy-mm-dd shape the <input type="date"> and the API both
// speak — a wire format, not a display one, so it stays pinned to that tag in
// every language.
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
  slots,
  maxPerDay,
  t,
}: {
  teachers: { id: string; name: string }[];
  classNames: Record<string, string>;
  periodLabels: string[];
  initialAbsences: AbsenceRow[];
  initialSubs: SubRow[];
  canMark: boolean;
  slots: Slot[];
  maxPerDay: number;
  t: AbsenceMessages;
}) {
  const [date, setDate] = useState(todayLocal());
  const [absences, setAbsences] = useState<AbsenceRow[]>(initialAbsences);
  const [subs, setSubs] = useState<SubRow[]>(initialSubs);
  const [markTeacher, setMarkTeacher] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teacherName = useMemo(() => new Map(teachers.map((x) => [x.id, x.name] as const)), [teachers]);
  const dayAbsences = absences.filter((a) => a.on_date === date);
  const absentIds = new Set(dayAbsences.map((a) => a.teacher_id));

  // Availability on the selected date's weekday: who is in class when, and how
  // many lessons each teacher already carries that day. Only someone less than
  // 100% busy — free that period AND under the daily cap — can take cover.
  const weekday = isoWeekday(date);
  const availability = useMemo(() => {
    const busy = new Set<string>(); // "teacher|period"
    const dayLessons = new Map<string, number>();
    if (weekday !== null) {
      for (const s of slots) {
        if (!s.teacher_id || s.day !== weekday) continue;
        busy.add(`${s.teacher_id}|${s.period}`);
        if (isLesson(s)) dayLessons.set(s.teacher_id, (dayLessons.get(s.teacher_id) ?? 0) + 1);
      }
    }
    return { busy, dayLessons };
  }, [slots, weekday]);

  /** Why a teacher can('t) cover this row — "ok", or the key of the blocking
   * reason (a key, not a phrase, so the words live in the dictionary). */
  function coverState(teacherId: string, row: SubRow): "ok" | keyof AbsenceMessages["state"] {
    if (availability.busy.has(`${teacherId}|${row.period}`)) return "inClass";
    const covers = subs.filter((x) => x.on_date === date && x.substitute_teacher_id === teacherId && x.id !== row.id);
    if (covers.some((x) => x.period === row.period)) return "covering";
    if ((availability.dayLessons.get(teacherId) ?? 0) + covers.length >= maxPerDay) return "fullyBooked";
    return "ok";
  }

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
        setError(json.error ?? t.markFailed);
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
      setError(t.networkError);
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
      if (!res.ok) setError(json.error ?? t.removeFailed);
      else {
        setAbsences((prev) => prev.filter((a) => a.id !== absenceId));
        setSubs((prev) => prev.filter((s) => s.absence_id !== absenceId));
      }
    } catch {
      setError(t.networkError);
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
      if (!res.ok || !json.substitution) setError(json.error ?? t.updateFailed);
      else setSubs((prev) => prev.map((s) => (s.id === subId ? json.substitution! : s)));
    } catch {
      setError(t.networkError);
    }
    setBusy(false);
  }

  return (
    <div className="card mt-4 p-4 print:hidden">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="font-medium text-sm">{t.title}</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="field h-9 px-2 text-sm" />
        <span className="text-[11px] text-[#98A0A9]">{t.hint}</span>
      </div>

      {canMark && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <select value={markTeacher} onChange={(e) => setMarkTeacher(e.target.value)} className="field h-9 px-2 text-sm">
            <option value="">{t.markPlaceholder}</option>
            {teachers
              .filter((x) => !absentIds.has(x.id))
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t.reasonPlaceholder}
            className="field h-9 px-3 text-sm w-44"
            maxLength={200}
          />
          <button onClick={() => void mark()} disabled={busy || !markTeacher} className="btn-primary h-9 px-3 text-sm disabled:opacity-50">
            {busy ? t.working : t.mark}
          </button>
        </div>
      )}
      {error && <p className="text-sm text-[#9A6400] mt-2">{error}</p>}

      {dayAbsences.length === 0 ? (
        <p className="text-sm text-[#5B6470] mt-3">{fmt(t.none, { date })} 🎉</p>
      ) : (
        dayAbsences.map((a) => {
          const mySubs = subs.filter((s) => s.absence_id === a.id).sort((x, y) => x.period - y.period);
          return (
            <div key={a.id} className="mt-3 border-t border-[#EEF0EC] pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{teacherName.get(a.teacher_id) ?? t.teacherFallback}</span>
                {a.reason && <span className="text-xs text-[#5B6470]">({a.reason})</span>}
                <span className="chip bg-[#FDECEA] text-[#B42318]">{t.absent}</span>
                {canMark && (
                  <button onClick={() => void unmark(a.id)} disabled={busy} className="text-xs text-[#B42318] hover:underline ms-auto">
                    {t.removeAbsence}
                  </button>
                )}
              </div>
              {mySubs.length === 0 ? (
                <p className="text-xs text-[#5B6470] mt-1">{t.noLessons}</p>
              ) : (
                <table className="w-full text-sm border-collapse mt-2">
                  <thead>
                    <tr className="bg-[#F5F6F3] text-xs text-[#5B6470]">
                      <th className="px-2 py-1.5 text-start font-normal w-20">{t.col.period}</th>
                      <th className="px-2 py-1.5 text-start font-normal">{t.col.class}</th>
                      <th className="px-2 py-1.5 text-start font-normal">{t.col.subject}</th>
                      <th className="px-2 py-1.5 text-start font-normal">{t.col.coveredBy}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mySubs.map((s) => (
                      <tr key={s.id} className="border-t border-[#EEF0EC]">
                        <td className="px-2 py-1.5 text-xs text-[#5B6470]">{periodLabels[s.period - 1] ?? `P${s.period}`}</td>
                        <td className="px-2 py-1.5">{classNames[s.class_id] ?? t.classFallback}</td>
                        <td className="px-2 py-1.5">{s.subject}</td>
                        <td className="px-2 py-1.5">
                          {canMark ? (
                            <select
                              value={s.substitute_teacher_id ?? ""}
                              onChange={(e) => void changeSub(s.id, e.target.value || null)}
                              className={`field h-8 px-2 text-sm ${s.substitute_teacher_id ? "" : "text-[#B42318]"}`}
                              disabled={busy}
                            >
                              <option value="">{`⚠ ${t.noCover}`}</option>
                              {teachers
                                .filter((x) => x.id !== s.original_teacher_id && !absentIds.has(x.id))
                                .map((x) => {
                                  const state = coverState(x.id, s);
                                  const isCurrent = x.id === s.substitute_teacher_id;
                                  return (
                                    <option key={x.id} value={x.id} disabled={state !== "ok" && !isCurrent}>
                                      {x.name}
                                      {state !== "ok" ? ` · ${t.state[state]}` : ""}
                                    </option>
                                  );
                                })}
                            </select>
                          ) : s.substitute_teacher_id ? (
                            teacherName.get(s.substitute_teacher_id) ?? t.teacherFallback
                          ) : (
                            <span className="text-[#B42318]">{`⚠ ${t.noCover}`}</span>
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
