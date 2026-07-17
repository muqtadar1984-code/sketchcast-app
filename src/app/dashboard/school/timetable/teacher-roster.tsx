"use client";

import { useMemo, useState } from "react";
import { DAY_NAMES, isLesson, teacherDayLoads, type Slot } from "@/utils/timetable";
import type { StaffDetail } from "./timetable-editor";

// The staffing picture under the grid: who is a class teacher (and of what),
// who isn't, what each person teaches (declared in onboarding ∪ taught on the
// live grid), their weekly lesson count, and their heaviest day against the
// per-day limit. Derived live from the editor's slot state, so edits update
// it immediately.
export default function TeacherRoster({
  staff,
  classes,
  slots,
  maxPerDay,
  shapeDays,
}: {
  staff: StaffDetail[];
  classes: { id: string; name: string; teacher_id: string }[];
  slots: Slot[];
  maxPerDay: number;
  shapeDays: number;
}) {
  const [open, setOpen] = useState(true);

  const rows = useMemo(() => {
    const classesByTeacher = new Map<string, string[]>();
    for (const c of classes) {
      if (!classesByTeacher.has(c.teacher_id)) classesByTeacher.set(c.teacher_id, []);
      classesByTeacher.get(c.teacher_id)!.push(c.name);
    }
    const taught = new Map<string, Set<string>>();
    let weekly = new Map<string, number>();
    {
      const w = new Map<string, number>();
      for (const s of slots) {
        if (!s.teacher_id) continue;
        if (isLesson(s)) w.set(s.teacher_id, (w.get(s.teacher_id) ?? 0) + 1);
        if (!taught.has(s.teacher_id)) taught.set(s.teacher_id, new Set());
        if (isLesson(s)) taught.get(s.teacher_id)!.add(s.subject.trim());
      }
      weekly = w;
    }
    const dayLoads = teacherDayLoads(slots);

    return staff
      .map((t) => {
        const subjects = new Set<string>(t.subjects.map((s) => s.trim()).filter(Boolean));
        for (const s of taught.get(t.id) ?? []) subjects.add(s);
        let worstDay = 0;
        let worstCount = 0;
        for (let d = 1; d <= shapeDays; d++) {
          const n = dayLoads.get(`${t.id}|${d}`) ?? 0;
          if (n > worstCount) {
            worstCount = n;
            worstDay = d;
          }
        }
        return {
          id: t.id,
          name: t.name,
          classTeacherOf: classesByTeacher.get(t.id) ?? [],
          subjects: [...subjects].sort(),
          weekly: weekly.get(t.id) ?? 0,
          worstDay,
          worstCount,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [staff, classes, slots, shapeDays]);

  return (
    <div className="card mt-6 p-4 print:hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-left">
        <span className="font-medium text-sm">Teachers ({rows.length})</span>
        <span className="text-xs text-[#5B6470]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-[#F5F6F3] text-xs text-[#5B6470]">
                <th className="px-2 py-2 text-left font-normal">Teacher</th>
                <th className="px-2 py-2 text-left font-normal">Class teacher</th>
                <th className="px-2 py-2 text-left font-normal">Teaches</th>
                <th className="px-2 py-2 text-left font-normal whitespace-nowrap">Lessons / week</th>
                <th className="px-2 py-2 text-left font-normal whitespace-nowrap">Heaviest day (limit {maxPerDay})</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-[#EEF0EC] align-top">
                  <td className="px-2 py-1.5">{r.name}</td>
                  <td className="px-2 py-1.5">
                    {r.classTeacherOf.length ? (
                      r.classTeacherOf.map((c) => (
                        <span key={c} className="chip bg-[#E2F4F1] text-[#0C8175] mr-1 mb-0.5 inline-block">
                          {c}
                        </span>
                      ))
                    ) : (
                      <span className="text-[#98A0A9]">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.subjects.length ? (
                      <span className="text-[#5B6470]">{r.subjects.join(", ")}</span>
                    ) : (
                      <span className="text-[#98A0A9]">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-[#5B6470]">{r.weekly}</td>
                  <td className="px-2 py-1.5">
                    {r.worstCount ? (
                      <span className={r.worstCount > maxPerDay ? "text-[#9A6400] font-medium" : "text-[#5B6470]"}>
                        {DAY_NAMES[r.worstDay - 1]} · {r.worstCount}/{maxPerDay}
                        {r.worstCount > maxPerDay ? " ⚠" : ""}
                      </span>
                    ) : (
                      <span className="text-[#98A0A9]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
