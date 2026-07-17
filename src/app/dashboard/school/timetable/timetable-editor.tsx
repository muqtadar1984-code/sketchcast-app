"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import {
  DAY_NAMES,
  cellKey,
  dayOverloads,
  isLesson,
  teacherConflicts,
  teacherDayLoads,
  type Slot,
  type TimetableShape,
} from "@/utils/timetable";
import TeacherRoster from "./teacher-roster";
import SettingsPanel from "./settings-panel";

type ClassRow = { id: string; name: string; grade: string | null; teacher_id: string; editable: boolean };
type Teacher = { id: string; name: string };
export type StaffDetail = { id: string; name: string; subjects: string[] };

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
const NONTEACHING_SUGGESTIONS = ["Assembly", "Free period", "Recess duty", "Library", "Study hall"];

// One undo step = the prior content of every cell an operation touched.
type UndoCell = { day: number; period: number; before: Slot | null };
type UndoEntry = { label: string; classId: string; cells: UndoCell[] };

// The whole-school timetable workbench: one source-of-truth slot list (all
// classes — conflicts are only visible across classes), a by-class editable
// grid with drag-to-move/swap, locked (generator-proof) cells, non-teaching
// cells, day tools (copy/clear), an undo stack, and the live roster beneath.
// Saves go straight through the browser client; the RLS policies (0045) are
// the authorization, and every write is verified to have actually landed
// (.select) so a denied save never looks like a success. If a multi-cell
// operation fails midway we re-sync from the server (router.refresh remounts
// the editor via its data-version key) rather than guessing.
export default function TimetableEditor({
  schoolId,
  shape,
  classes,
  teachers,
  staffDetails,
  initialSlots,
  isAdmin,
}: {
  schoolId: string;
  shape: TimetableShape;
  classes: ClassRow[];
  teachers: Teacher[];
  staffDetails: StaffDetail[];
  initialSlots: Slot[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [view, setView] = useState<"class" | "teacher">("class");
  const [classId, setClassId] = useState(classes.find((c) => c.editable)?.id ?? classes[0].id);
  const [teacherId, setTeacherId] = useState(teachers[0]?.id ?? "");
  const [editing, setEditing] = useState<{ day: number; period: number } | null>(null);
  const [subject, setSubject] = useState("");
  const [cellTeacher, setCellTeacher] = useState("");
  const [room, setRoom] = useState("");
  const [cellLocked, setCellLocked] = useState(false);
  const [cellNonTeaching, setCellNonTeaching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [copySrc, setCopySrc] = useState(1);
  const [copyDst, setCopyDst] = useState<number[]>([]);
  const dragFrom = useRef<{ day: number; period: number } | null>(null);
  const [dropPreview, setDropPreview] = useState<{ day: number; period: number; bad: boolean } | null>(null);

  const days = DAY_NAMES.slice(0, shape.days);
  const maxPerDay = shape.maxPerTeacherPerDay ?? 6;
  const conflicts = useMemo(() => teacherConflicts(slots), [slots]);
  const overloads = useMemo(() => dayOverloads(slots, maxPerDay), [slots, maxPerDay]);
  const dayLoads = useMemo(() => teacherDayLoads(slots), [slots]);
  const teacherName = useMemo(() => new Map(teachers.map((t) => [t.id, t.name] as const)), [teachers]);
  const className = useMemo(() => new Map(classes.map((c) => [c.id, c.name] as const)), [classes]);
  const currentClass = classes.find((c) => c.id === classId);
  const slotAt = (cid: string, day: number, period: number) =>
    slots.find((s) => s.class_id === cid && s.day === day && s.period === period);

  const supabase = () => createClient();
  const firstName = (id: string | null) => (id ? (teacherName.get(id) ?? "—").split(" ")[0] : "—");

  // Break rows keyed by the period they follow (0 = before P1).
  const breaksAfter = useMemo(() => {
    const m = new Map<number, NonNullable<TimetableShape["breaks"]>>();
    for (const b of shape.breaks ?? []) {
      const k = Math.min(b.afterPeriod, shape.periods.length);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(b);
    }
    return m;
  }, [shape]);

  // ── Server helpers ───────────────────────────────────────────────────────────
  // Multi-cell ops that die midway leave the server ahead of the client — the
  // only honest recovery is a full re-sync.
  function failAndResync(message: string) {
    setError(`${message} — re-syncing the grid.`);
    router.refresh();
  }

  async function writeCell(cid: string, day: number, period: number, next: Slot | null): Promise<boolean> {
    if (next === null) {
      const { data, error: err } = await supabase()
        .from("timetable_slots")
        .delete()
        .eq("class_id", cid)
        .eq("day", day)
        .eq("period", period)
        .select("id");
      return !err && !!data?.length;
    }
    const row = {
      school_id: schoolId,
      class_id: cid,
      day,
      period,
      subject: next.subject,
      teacher_id: next.teacher_id,
      room: next.room ?? null,
      locked: next.locked ?? false,
      kind: next.kind ?? "lesson",
    };
    const { data, error: err } = await supabase()
      .from("timetable_slots")
      .upsert(row, { onConflict: "class_id,day,period" })
      .select("id");
    return !err && !!data?.length;
  }

  function applyLocal(cid: string, changes: { day: number; period: number; next: Slot | null }[]) {
    setSlots((prev) => {
      let out = prev;
      for (const ch of changes) {
        out = out.filter((s) => !(s.class_id === cid && s.day === ch.day && s.period === ch.period));
        if (ch.next) out = [...out, { ...ch.next, class_id: cid, day: ch.day, period: ch.period }];
      }
      return out;
    });
  }

  function pushUndo(label: string, cid: string, cells: { day: number; period: number }[]) {
    const entry: UndoEntry = {
      label,
      classId: cid,
      cells: cells.map((c) => {
        const s = slotAt(cid, c.day, c.period);
        return { day: c.day, period: c.period, before: s ? { ...s } : null };
      }),
    };
    setUndoStack((prev) => [...prev.slice(-19), entry]);
  }

  async function undo() {
    const entry = undoStack[undoStack.length - 1];
    if (!entry || busy) return;
    setBusy(true);
    setError(null);
    for (const cell of entry.cells) {
      // Restoring "empty" over an already-empty cell is a no-op — skip it,
      // because a 0-row delete is indistinguishable from a denied one.
      if (cell.before === null && !slotAt(entry.classId, cell.day, cell.period)) continue;
      const ok = await writeCell(entry.classId, cell.day, cell.period, cell.before);
      if (!ok) {
        setBusy(false);
        failAndResync(`Undo of "${entry.label}" only partly applied`);
        return;
      }
    }
    applyLocal(
      entry.classId,
      entry.cells.map((c) => ({ day: c.day, period: c.period, next: c.before })),
    );
    setUndoStack((prev) => prev.slice(0, -1));
    setBusy(false);
  }

  // ── Cell editing ─────────────────────────────────────────────────────────────
  function openCell(day: number, period: number) {
    if (!currentClass?.editable) return;
    const s = slotAt(classId, day, period);
    setSubject(s?.subject ?? "");
    setCellTeacher(s?.teacher_id ?? currentClass.teacher_id);
    setRoom(s?.room ?? "");
    setCellLocked(s?.locked ?? false);
    setCellNonTeaching((s?.kind ?? "lesson") === "nonteaching");
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
    const next: Slot = {
      class_id: classId,
      day: editing.day,
      period: editing.period,
      subject: subject.trim(),
      teacher_id: cellTeacher || null,
      room: room.trim() || null,
      locked: cellLocked,
      kind: cellNonTeaching ? "nonteaching" : "lesson",
    };
    pushUndo("edit cell", classId, [{ day: editing.day, period: editing.period }]);
    const ok = await writeCell(classId, editing.day, editing.period, next);
    setBusy(false);
    if (!ok) {
      setUndoStack((prev) => prev.slice(0, -1));
      setError("You can't edit this class's timetable.");
      return;
    }
    applyLocal(classId, [{ day: editing.day, period: editing.period, next }]);
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
    pushUndo("clear cell", classId, [{ day: editing.day, period: editing.period }]);
    const ok = await writeCell(classId, editing.day, editing.period, null);
    setBusy(false);
    if (!ok) {
      setUndoStack((prev) => prev.slice(0, -1));
      setError("You can't edit this class's timetable.");
      return;
    }
    applyLocal(classId, [{ day: editing.day, period: editing.period, next: null }]);
    setEditing(null);
  }

  // ── Drag to move / swap ──────────────────────────────────────────────────────
  function evalDrop(
    from: { day: number; period: number } | null,
    day: number,
    period: number,
  ): { ok: boolean; bad: boolean } {
    if (!from || !currentClass?.editable) return { ok: false, bad: false };
    if (from.day === day && from.period === period) return { ok: false, bad: false };
    const target = slotAt(classId, day, period);
    if (target?.locked) return { ok: false, bad: false };
    // Preview: would the move/swap create a NEW teacher clash?
    const source = slotAt(classId, from.day, from.period);
    if (!source) return { ok: false, bad: false };
    const hypothetical = slots
      .filter(
        (s) =>
          !(s.class_id === classId && s.day === from.day && s.period === from.period) &&
          !(s.class_id === classId && s.day === day && s.period === period),
      )
      .concat(
        { ...source, day, period },
        target ? [{ ...target, day: from.day, period: from.period }] : [],
      );
    const before = conflicts.size;
    const after = teacherConflicts(hypothetical).size;
    return { ok: true, bad: after > before };
  }
  const canDrop = (day: number, period: number) => evalDrop(dragFrom.current, day, period);

  async function dropOn(day: number, period: number) {
    // Capture BEFORE clearing the ref — evalDrop needs the source cell.
    const from = dragFrom.current;
    dragFrom.current = null;
    setDropPreview(null);
    if (!from) return;
    const { ok } = evalDrop(from, day, period);
    if (!ok) return;
    const source = slotAt(classId, from.day, from.period)!;
    const target = slotAt(classId, day, period) ?? null;
    setBusy(true);
    setError(null);
    pushUndo(target ? "swap cells" : "move cell", classId, [
      { day: from.day, period: from.period },
      { day, period },
    ]);
    // Content moves, rows stay: upsert the target with the source's content
    // (and vice versa for a swap), then delete the source only on a move.
    const okTarget = await writeCell(classId, day, period, { ...source, day, period });
    if (!okTarget) {
      setBusy(false);
      setUndoStack((prev) => prev.slice(0, -1));
      setError("You can't edit this class's timetable.");
      return;
    }
    const okSource = await writeCell(
      classId,
      from.day,
      from.period,
      target ? { ...target, day: from.day, period: from.period } : null,
    );
    setBusy(false);
    if (!okSource) {
      setUndoStack((prev) => prev.slice(0, -1));
      failAndResync("The move only partly applied");
      return;
    }
    applyLocal(classId, [
      { day, period, next: { ...source, day, period } },
      { day: from.day, period: from.period, next: target ? { ...target, day: from.day, period: from.period } : null },
    ]);
  }

  // ── Day tools ────────────────────────────────────────────────────────────────
  async function clearDays(daysToClear: number[], label: string) {
    if (!currentClass?.editable || busy) return;
    const affected: { day: number; period: number }[] = [];
    for (const d of daysToClear)
      for (let p = 1; p <= shape.periods.length; p++) {
        const s = slotAt(classId, d, p);
        if (s && !s.locked) affected.push({ day: d, period: p });
      }
    if (!affected.length) return;
    if (!window.confirm(`${label} for ${currentClass.name}? ${affected.length} lesson(s) will be removed (locked cells stay). You can undo this.`))
      return;
    setBusy(true);
    setError(null);
    pushUndo(label.toLowerCase(), classId, affected);
    for (const c of affected) {
      const ok = await writeCell(classId, c.day, c.period, null);
      if (!ok) {
        setBusy(false);
        failAndResync(`${label} only partly applied`);
        return;
      }
    }
    applyLocal(
      classId,
      affected.map((c) => ({ ...c, next: null })),
    );
    setBusy(false);
  }

  async function copyDay() {
    if (!currentClass?.editable || busy || !copyDst.length) return;
    const changes: { day: number; period: number; next: Slot | null }[] = [];
    for (const d of copyDst) {
      if (d === copySrc) continue;
      for (let p = 1; p <= shape.periods.length; p++) {
        const target = slotAt(classId, d, p);
        if (target?.locked) continue; // locked targets never change
        const src = slotAt(classId, copySrc, p);
        if (!src && !target) continue; // empty→empty: nothing to write (a 0-row delete would read as failure)
        changes.push({ day: d, period: p, next: src ? { ...src, day: d, period: p } : null });
      }
    }
    if (!changes.length) return;
    setBusy(true);
    setError(null);
    pushUndo("copy day", classId, changes.map((c) => ({ day: c.day, period: c.period })));
    for (const ch of changes) {
      const ok = await writeCell(classId, ch.day, ch.period, ch.next);
      if (!ok) {
        setBusy(false);
        failAndResync("Copy day only partly applied");
        return;
      }
    }
    applyLocal(classId, changes);
    setBusy(false);
    setCopyDst([]);
  }

  // Editor-panel soft warning: would this save push the teacher past the cap?
  const capWarning = useMemo(() => {
    if (!editing || !cellTeacher || cellNonTeaching) return null;
    const current = slotAt(classId, editing.day, editing.period);
    let count = dayLoads.get(`${cellTeacher}|${editing.day}`) ?? 0;
    if (current && current.teacher_id === cellTeacher && isLesson(current)) count -= 1;
    if (count >= maxPerDay) {
      return `${teacherName.get(cellTeacher) ?? "This teacher"} already has ${count} lessons on ${days[editing.day - 1]} (limit ${maxPerDay}). You can still save — the limit is a guideline for humans, a rule for the generator.`;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, cellTeacher, cellNonTeaching, dayLoads, maxPerDay, slots]);

  const hoursLine = [
    shape.start && shape.end ? `School hours ${shape.start} – ${shape.end}` : null,
    ...(shape.breaks ?? []).map((b) => `${b.label} ${b.time ?? ""}${b.minutes ? ` · ${b.minutes} min` : ""}`),
  ]
    .filter(Boolean)
    .join("   ·   ");

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4 print:hidden">
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
        {undoStack.length > 0 && (
          <button onClick={() => void undo()} disabled={busy} className="btn-ghost h-9 px-3 text-sm" title={`Undo ${undoStack[undoStack.length - 1].label}`}>
            ↩ Undo {undoStack[undoStack.length - 1].label}
          </button>
        )}
        <button onClick={() => window.print()} className="btn-ghost h-9 px-3 text-sm ml-auto">
          🖨 Print
        </button>
      </div>

      {view === "class" && (
        <p className="hidden print:block text-sm font-medium mb-2">{currentClass?.name}</p>
      )}
      {conflicts.size > 0 && (
        <p className="text-sm text-[#9A6400] mb-2 print:hidden">
          ⚠ {conflicts.size} clash{conflicts.size === 1 ? "" : "es"}: a teacher is timetabled in two classes at
          once — clashing cells are outlined.
        </p>
      )}
      {overloads.length > 0 && (
        <p className="text-sm text-[#9A6400] mb-2 print:hidden">
          ⚠ Over the daily limit ({maxPerDay}/day):{" "}
          {overloads
            .map((o) => `${teacherName.get(o.teacher_id) ?? "Teacher"} — ${DAY_NAMES[o.day - 1]} ${o.count}`)
            .join(", ")}
        </p>
      )}
      {error && <p className="text-sm text-red-600 mb-2 print:hidden">{error}</p>}

      <div className="card overflow-x-auto print:overflow-visible print:shadow-none">
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
            {(breaksAfter.get(0) ?? []).map((b) => (
              <tr key={`b0-${b.label}`} className="border-t border-[#EEF0EC] bg-[#FBF7EE]">
                <td colSpan={days.length + 1} className="px-2 py-1 text-[11px] text-[#9A6400]">
                  ☕ {b.label}
                  {b.time ? ` · ${b.time}` : ""}
                  {b.minutes ? ` · ${b.minutes} min` : ""}
                </td>
              </tr>
            ))}
            {shape.periods.map((p, pi) => {
              const period = pi + 1;
              return (
                <Fragment key={p.label}>
                  <tr className="border-t border-[#EEF0EC] align-top">
                    <td className="px-2 py-1.5 text-xs text-[#5B6470] whitespace-nowrap">
                      {p.label}
                      {p.time ? <span className="block text-[10px] text-[#98A0A9]">{p.time}</span> : null}
                    </td>
                    {days.map((_, di) => {
                      const day = di + 1;
                      if (view === "teacher") {
                        const mine = slots.filter((s) => s.teacher_id === teacherId && s.day === day && s.period === period);
                        const clash = mine.filter((s) => isLesson(s)).length > 1;
                        return (
                          <td key={day} className="px-1 py-1">
                            {mine.map((s) => (
                              <div
                                key={`${s.class_id}-${s.day}-${s.period}`}
                                className={`rounded px-1.5 py-1 mb-0.5 text-[11px] leading-4 ${clash && isLesson(s) ? "ring-2 ring-[#9A6400] bg-[#FFF1D6]" : "bg-[#F4F6F3]"}`}
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
                      const isPreview = dropPreview?.day === day && dropPreview?.period === period;
                      const draggable = !!s && !s.locked && !!currentClass?.editable && !busy;
                      return (
                        <td key={day} className="px-1 py-1">
                          <button
                            onClick={() => openCell(day, period)}
                            disabled={!currentClass?.editable}
                            draggable={draggable}
                            onDragStart={(e) => {
                              dragFrom.current = { day, period };
                              e.dataTransfer.effectAllowed = "move";
                              // Firefox refuses to start a drag with an empty data store.
                              e.dataTransfer.setData("text/plain", "");
                            }}
                            onDragEnd={() => {
                              dragFrom.current = null;
                              setDropPreview(null);
                            }}
                            onDragOver={(e) => {
                              const v = canDrop(day, period);
                              if (v.ok) e.preventDefault();
                            }}
                            onDragEnter={() => {
                              const v = canDrop(day, period);
                              setDropPreview(v.ok ? { day, period, bad: v.bad } : null);
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              void dropOn(day, period);
                            }}
                            className={`w-full min-h-[44px] rounded px-1.5 py-1 text-left text-[11px] leading-4 transition-colors ${
                              isPreview
                                ? dropPreview!.bad
                                  ? "ring-2 ring-[#B42318] bg-[#FDECEA]"
                                  : "ring-2 ring-[#0C8175] bg-[#E2F4F1]"
                                : isEditing
                                  ? "ring-2 ring-[#0C8175] bg-white"
                                  : clash
                                    ? "ring-2 ring-[#9A6400] bg-[#FFF1D6]"
                                    : s && !isLesson(s)
                                      ? "bg-[#EFEDF7] hover:bg-[#E6E2F2]"
                                      : s
                                        ? "bg-[#F4F6F3] hover:bg-[#ECEFEA]"
                                        : "bg-white border border-dashed border-[#E6E8E4] hover:border-[#0C8175]"
                            } ${currentClass?.editable ? "cursor-pointer" : "cursor-default"}`}
                          >
                            {s ? (
                              <>
                                <span className="text-[#14181F]">
                                  {s.locked ? "🔒 " : ""}
                                  {s.subject}
                                </span>
                                <span className="block text-[#5B6470]">
                                  {isLesson(s) ? firstName(s.teacher_id) : "non-teaching"}
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
                  {(breaksAfter.get(period) ?? []).map((b) => (
                    <tr key={`b${period}-${b.label}`} className="border-t border-[#EEF0EC] bg-[#FBF7EE]">
                      <td colSpan={days.length + 1} className="px-2 py-1 text-[11px] text-[#9A6400]">
                        ☕ {b.label}
                        {b.time ? ` · ${b.time}` : ""}
                        {b.minutes ? ` · ${b.minutes} min` : ""}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {hoursLine && (
        <p className="text-xs text-[#5B6470] mt-2">
          {hoursLine}
          {isAdmin && <span className="text-[#98A0A9]"> — edit under Timetable settings below</span>}
        </p>
      )}
      {view === "class" && currentClass?.editable && (
        <p className="text-[11px] text-[#98A0A9] mt-1 print:hidden">
          Tip: drag a lesson onto another cell to move it (onto a filled cell to swap). 🔒 locked cells are
          never touched by the auto-generator, day tools, or drags.
        </p>
      )}

      {view === "class" && currentClass?.editable && (
        <div className="flex flex-wrap items-center gap-2 mt-3 text-sm print:hidden">
          <span className="text-xs text-[#5B6470]">Day tools:</span>
          <select value={copySrc} onChange={(e) => setCopySrc(Number(e.target.value))} className="field h-9 px-2 text-sm">
            {days.map((d, i) => (
              <option key={d} value={i + 1}>
                Copy {d}
              </option>
            ))}
          </select>
          <span className="text-xs text-[#5B6470]">to</span>
          <div className="flex gap-1">
            {days.map((d, i) => {
              const v = i + 1;
              const on = copyDst.includes(v);
              return (
                <button
                  key={d}
                  disabled={v === copySrc}
                  onClick={() => setCopyDst((prev) => (on ? prev.filter((x) => x !== v) : [...prev, v]))}
                  className={`h-9 px-2 rounded border text-xs ${on ? "bg-[#14181F] text-white border-[#14181F]" : "bg-white text-[#5B6470] border-[#E6E8E4]"} disabled:opacity-30`}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <button onClick={() => void copyDay()} disabled={busy || !copyDst.length} className="btn-ghost h-9 px-3 text-sm disabled:opacity-50">
            Copy
          </button>
          <span className="mx-1 text-[#E6E8E4]">|</span>
          <select
            id="tt-clear-day"
            defaultValue=""
            onChange={(e) => {
              const v = Number(e.target.value);
              e.target.value = "";
              if (v) void clearDays([v], `Clear ${DAY_NAMES[v - 1]}`);
            }}
            className="field h-9 px-2 text-sm"
          >
            <option value="" disabled>
              Clear a day…
            </option>
            {days.map((d, i) => (
              <option key={d} value={i + 1}>
                Clear {d}
              </option>
            ))}
          </select>
          <button
            onClick={() => void clearDays(days.map((_, i) => i + 1), "Clear the whole week")}
            disabled={busy}
            className="text-sm text-[#B42318] hover:underline disabled:opacity-50"
          >
            Clear week
          </button>
        </div>
      )}

      {view === "class" && editing && currentClass?.editable && (
        <div className="card mt-4 p-4 print:hidden">
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
                {(cellNonTeaching ? NONTEACHING_SUGGESTIONS : SUBJECT_SUGGESTIONS).map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </label>
            <label className="text-xs text-[#5B6470]">
              Teacher{cellNonTeaching ? " (optional — on duty)" : ""}
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
          <div className="flex flex-wrap gap-4 mt-3">
            <label className="flex items-center gap-1.5 text-xs text-[#5B6470]">
              <input type="checkbox" checked={cellLocked} onChange={(e) => setCellLocked(e.target.checked)} />
              🔒 Lock (auto-generate and day tools never touch it)
            </label>
            <label className="flex items-center gap-1.5 text-xs text-[#5B6470]">
              <input type="checkbox" checked={cellNonTeaching} onChange={(e) => setCellNonTeaching(e.target.checked)} />
              Non-teaching (assembly, free period — no clash or load counting)
            </label>
          </div>
          {capWarning && <p className="text-sm text-[#9A6400] mt-2">⚠ {capWarning}</p>}
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

      <TeacherRoster staff={staffDetails} classes={classes} slots={slots} maxPerDay={maxPerDay} shapeDays={shape.days} />

      {isAdmin && <SettingsPanel shape={shape} />}
    </div>
  );
}
