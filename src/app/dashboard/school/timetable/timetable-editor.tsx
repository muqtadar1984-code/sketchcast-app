"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { DAY_NAMES, cellKey, teacherConflicts, type Slot, type TimetableShape } from "@/utils/timetable";

type ClassRow = { id: string; name: string; grade: string | null; teacher_id: string; editable: boolean };
type Teacher = { id: string; name: string };

const SUBJECT_SUGGESTIONS = [
  "Mathematics",
  "Science",
  "English",
  "Bahasa Melayu",
  "History",
  "Geography",
  "Art",
  "PE",
  "Music",
  "Moral Education",
  "ICT",
];

// The whole-school timetable, client-side: one source-of-truth slot list (all
// classes — conflicts are only visible across classes), a by-class editable
// grid, and a by-teacher derived view. Saves go straight through the browser
// client; the RLS policies (0045) are the authorization, and every write is
// verified to have actually landed (.select) so a denied save never looks like
// a success.
export default function TimetableEditor({
  schoolId,
  shape,
  classes,
  teachers,
  initialSlots,
}: {
  schoolId: string;
  shape: TimetableShape;
  classes: ClassRow[];
  teachers: Teacher[];
  initialSlots: Slot[];
}) {
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [view, setView] = useState<"class" | "teacher">("class");
  const [classId, setClassId] = useState(classes.find((c) => c.editable)?.id ?? classes[0].id);
  const [teacherId, setTeacherId] = useState(teachers[0]?.id ?? "");
  const [editing, setEditing] = useState<{ day: number; period: number } | null>(null);
  const [subject, setSubject] = useState("");
  const [cellTeacher, setCellTeacher] = useState("");
  const [room, setRoom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = DAY_NAMES.slice(0, shape.days);
  const conflicts = useMemo(() => teacherConflicts(slots), [slots]);
  const teacherName = useMemo(() => new Map(teachers.map((t) => [t.id, t.name] as const)), [teachers]);
  const className = useMemo(() => new Map(classes.map((c) => [c.id, c.name] as const)), [classes]);
  const currentClass = classes.find((c) => c.id === classId);
  const slotAt = (cid: string, day: number, period: number) =>
    slots.find((s) => s.class_id === cid && s.day === day && s.period === period);

  function openCell(day: number, period: number) {
    if (!currentClass?.editable) return;
    const s = slotAt(classId, day, period);
    setSubject(s?.subject ?? "");
    setCellTeacher(s?.teacher_id ?? currentClass.teacher_id);
    setRoom(s?.room ?? "");
    setEditing({ day, period });
    setError(null);
  }

  async function saveCell() {
    if (!editing || !subject.trim()) {
      setError("A subject is required.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const row = {
      school_id: schoolId,
      class_id: classId,
      day: editing.day,
      period: editing.period,
      subject: subject.trim(),
      teacher_id: cellTeacher || null,
      room: room.trim() || null,
    };
    const { data, error: err } = await supabase
      .from("timetable_slots")
      .upsert(row, { onConflict: "class_id,day,period" })
      .select("id");
    setBusy(false);
    if (err || !data?.length) {
      setError(err?.message || "You can't edit this class's timetable.");
      return;
    }
    setSlots((prev) => [
      ...prev.filter((s) => !(s.class_id === classId && s.day === editing.day && s.period === editing.period)),
      { ...row, id: data[0].id },
    ]);
    setEditing(null);
  }

  async function clearCell() {
    if (!editing) return;
    const existing = slotAt(classId, editing.day, editing.period);
    if (!existing) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error: err } = await supabase
      .from("timetable_slots")
      .delete()
      .eq("class_id", classId)
      .eq("day", editing.day)
      .eq("period", editing.period)
      .select("id");
    setBusy(false);
    if (err || !data?.length) {
      setError(err?.message || "You can't edit this class's timetable.");
      return;
    }
    setSlots((prev) => prev.filter((s) => !(s.class_id === classId && s.day === editing.day && s.period === editing.period)));
    setEditing(null);
  }

  const firstName = (id: string | null) => (id ? (teacherName.get(id) ?? "—").split(" ")[0] : "—");

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex rounded-lg border border-[#E6E8E4] overflow-hidden">
          <button
            onClick={() => setView("class")}
            className={`h-9 px-3 text-sm ${view === "class" ? "bg-[#14181F] text-white" : "bg-white text-[#5B6470]"}`}
          >
            By class
          </button>
          <button
            onClick={() => setView("teacher")}
            className={`h-9 px-3 text-sm ${view === "teacher" ? "bg-[#14181F] text-white" : "bg-white text-[#5B6470]"}`}
          >
            By teacher
          </button>
        </div>
        {view === "class" ? (
          <select value={classId} onChange={(e) => { setClassId(e.target.value); setEditing(null); }} className="field h-9 px-2 text-sm">
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.editable ? "" : " (view only)"}
              </option>
            ))}
          </select>
        ) : (
          <select value={teacherId} onChange={(e) => setTeacherId(e.target.value)} className="field h-9 px-2 text-sm">
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <button onClick={() => window.print()} className="btn-ghost h-9 px-3 text-sm ml-auto">
          🖨 Print
        </button>
      </div>

      {conflicts.size > 0 && (
        <p className="text-sm text-[#9A6400] mb-3">
          ⚠ {conflicts.size} clash{conflicts.size === 1 ? "" : "es"}: a teacher is timetabled in two classes at
          once — clashing cells are outlined.
        </p>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-[#F5F6F3] text-xs text-[#5B6470]">
              <th className="px-2 py-2 text-left font-normal w-20">Period</th>
              {days.map((d) => (
                <th key={d} className="px-2 py-2 text-left font-normal">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shape.periods.map((p, pi) => {
              const period = pi + 1;
              return (
                <tr key={p.label} className="border-t border-[#EEF0EC] align-top">
                  <td className="px-2 py-1.5 text-xs text-[#5B6470] whitespace-nowrap">
                    {p.label}
                    {p.time ? <span className="block text-[10px] text-[#98A0A9]">{p.time}</span> : null}
                  </td>
                  {days.map((_, di) => {
                    const day = di + 1;
                    if (view === "teacher") {
                      const mine = slots.filter((s) => s.teacher_id === teacherId && s.day === day && s.period === period);
                      const clash = mine.length > 1;
                      return (
                        <td key={day} className="px-1 py-1">
                          {mine.map((s) => (
                            <div
                              key={`${s.class_id}-${s.day}-${s.period}`}
                              className={`rounded px-1.5 py-1 mb-0.5 text-[11px] leading-4 ${clash ? "ring-2 ring-[#9A6400] bg-[#FFF1D6]" : "bg-[#F4F6F3]"}`}
                            >
                              <span className="text-[#14181F]">{s.subject}</span>
                              <span className="block text-[#5B6470]">{className.get(s.class_id) ?? "Class"}{s.room ? ` · ${s.room}` : ""}</span>
                            </div>
                          ))}
                        </td>
                      );
                    }
                    const s = slotAt(classId, day, period);
                    const clash = s ? conflicts.has(cellKey(classId, day, period)) : false;
                    const isEditing = editing?.day === day && editing?.period === period;
                    return (
                      <td key={day} className="px-1 py-1">
                        <button
                          onClick={() => openCell(day, period)}
                          disabled={!currentClass?.editable}
                          className={`w-full min-h-[44px] rounded px-1.5 py-1 text-left text-[11px] leading-4 transition-colors ${
                            isEditing
                              ? "ring-2 ring-[#0C8175] bg-white"
                              : clash
                                ? "ring-2 ring-[#9A6400] bg-[#FFF1D6]"
                                : s
                                  ? "bg-[#F4F6F3] hover:bg-[#ECEFEA]"
                                  : "bg-white border border-dashed border-[#E6E8E4] hover:border-[#0C8175]"
                          } ${currentClass?.editable ? "cursor-pointer" : "cursor-default"}`}
                        >
                          {s ? (
                            <>
                              <span className="text-[#14181F]">{s.subject}</span>
                              <span className="block text-[#5B6470]">
                                {firstName(s.teacher_id)}
                                {s.room ? ` · ${s.room}` : ""}
                              </span>
                            </>
                          ) : (
                            <span className="text-[#C6CBC4]">+</span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {view === "class" && editing && currentClass?.editable && (
        <div className="card mt-4 p-4">
          <div className="text-sm mb-3">
            <span className="font-medium">{currentClass.name}</span> · {days[editing.day - 1]} ·{" "}
            {shape.periods[editing.period - 1]?.label}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-xs text-[#5B6470]">
              Subject
              <input
                list="tt-subjects"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="field w-full h-10 px-3 text-sm mt-1"
                maxLength={60}
                autoFocus
              />
              <datalist id="tt-subjects">
                {SUBJECT_SUGGESTIONS.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </label>
            <label className="text-xs text-[#5B6470]">
              Teacher
              <select value={cellTeacher} onChange={(e) => setCellTeacher(e.target.value)} className="field w-full h-10 px-2 text-sm mt-1">
                <option value="">— unassigned —</option>
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[#5B6470]">
              Room (optional)
              <input value={room} onChange={(e) => setRoom(e.target.value)} className="field w-full h-10 px-3 text-sm mt-1" maxLength={40} />
            </label>
          </div>
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          <div className="flex items-center justify-between mt-3">
            <button onClick={() => void clearCell()} disabled={busy} className="text-sm text-[#B42318] hover:underline">
              Clear cell
            </button>
            <div className="flex items-center gap-2">
              <button onClick={() => setEditing(null)} className="btn-ghost h-10 px-4 text-sm">
                Cancel
              </button>
              <button onClick={() => void saveCell()} disabled={busy} className="btn-primary h-10 px-4 text-sm disabled:opacity-50">
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
