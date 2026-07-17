"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DAY_NAMES, isLesson, teacherDayLoads, type Slot } from "@/utils/timetable";
import type { StaffDetail } from "./timetable-editor";

// The staffing picture under the grid: who is a class teacher (and of what),
// who isn't, what each person teaches (declared in onboarding ∪ taught on the
// live grid), their weekly lesson count, and their heaviest day against the
// per-day limit. Derived live from the editor's slot state, so edits update
// it immediately. The principal can reassign class-teacher positions from
// here (an ownership transfer — the class follows its class teacher), and a
// standing check confirms every grade & section has one.
export default function TeacherRoster({
  staff,
  classes,
  slots,
  maxPerDay,
  shapeDays,
  periodsPerDay,
  isAdmin,
}: {
  staff: StaffDetail[];
  classes: { id: string; name: string; grade: string | null; teacher_id: string }[];
  slots: Slot[];
  maxPerDay: number;
  shapeDays: number;
  periodsPerDay: number;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  // Optimistic class-teacher reassignments (server truth catches up on refresh).
  const [reassigned, setReassigned] = useState<Record<string, string>>({});
  const [ctBusy, setCtBusy] = useState(false);
  const [ctErr, setCtErr] = useState<string | null>(null);

  const mergedClasses = useMemo(
    () => classes.map((c) => ({ ...c, teacher_id: reassigned[c.id] ?? c.teacher_id })),
    [classes, reassigned],
  );
  const staffIds = useMemo(() => new Set(staff.map((t) => t.id)), [staff]);
  // The check: a position is uncovered when its holder is no longer on staff
  // (left the school, role changed) — the DB never lets it be empty.
  const uncovered = mergedClasses.filter((c) => !staffIds.has(c.teacher_id));

  async function reassign(classId: string, teacherId: string) {
    if (!teacherId || ctBusy) return;
    setCtBusy(true);
    setCtErr(null);
    // Optimistic: show the new holder immediately, roll back on failure.
    const prevHolder = reassigned[classId];
    setReassigned((prev) => ({ ...prev, [classId]: teacherId }));
    try {
      const res = await fetch("/api/timetable/class-teacher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ class_id: classId, teacher_id: teacherId }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        setCtErr(json.error ?? "Could not reassign the class teacher.");
        setReassigned((prev) => {
          const next = { ...prev };
          if (prevHolder) next[classId] = prevHolder;
          else delete next[classId];
          return next;
        });
      } else {
        // Refresh server props so the EDITOR's cell-teacher default follows
        // the new class teacher too (the grid's client state survives — the
        // editor is keyed by the slots version, which this doesn't touch).
        router.refresh();
      }
    } catch {
      setCtErr("Network error.");
      setReassigned((prev) => {
        const next = { ...prev };
        if (prevHolder) next[classId] = prevHolder;
        else delete next[classId];
        return next;
      });
    }
    setCtBusy(false);
  }

  const rows = useMemo(() => {
    const classesByTeacher = new Map<string, string[]>();
    for (const c of mergedClasses) {
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
        const week = weekly.get(t.id) ?? 0;
        // "Blocked" = share of the coverable week already taken: the
        // denominator is what a teacher may at most carry (the per-day cap,
        // or the day length if shorter) × days. "Fully" is judged PER DAY —
        // a teacher over-loaded Mon–Thu but free Friday can still cover on
        // Friday, so the weekly ratio alone must not say "never".
        const perDayCapacity = Math.min(maxPerDay, periodsPerDay);
        const denom = shapeDays * perDayCapacity;
        let daysWithSpare = 0;
        for (let d = 1; d <= shapeDays; d++) {
          if ((dayLoads.get(`${t.id}|${d}`) ?? 0) < perDayCapacity) daysWithSpare++;
        }
        return {
          id: t.id,
          name: t.name,
          classTeacherOf: classesByTeacher.get(t.id) ?? [],
          subjects: [...subjects].sort(),
          weekly: week,
          blockedPct: denom > 0 ? Math.min(100, Math.round((week / denom) * 100)) : 0,
          fullyBlocked: daysWithSpare === 0,
          worstDay,
          worstCount,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [staff, mergedClasses, slots, shapeDays, maxPerDay, periodsPerDay]);

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
                <th className="px-2 py-2 text-left font-normal whitespace-nowrap">Blocked</th>
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
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span
                      className={r.fullyBlocked ? "text-[#B42318] font-medium" : "text-[#5B6470]"}
                      title={
                        r.fullyBlocked
                          ? "Fully booked every day — cannot be assigned as a substitute"
                          : "Has spare capacity on at least one day — can take cover then"
                      }
                    >
                      {r.blockedPct}% blocked
                    </span>
                  </td>
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

          <div className="mt-5 border-t border-[#EEF0EC] pt-3">
            <div className="text-xs font-medium text-[#5B6470] mb-1">Class-teacher positions</div>
            {uncovered.length === 0 ? (
              <p className="text-xs text-[#0C8175] mb-2">✓ Every grade &amp; section has a class teacher.</p>
            ) : (
              <p className="text-xs text-[#B42318] mb-2">
                ⚠ Without a serving class teacher:{" "}
                {uncovered.map((c) => c.name).join(", ")} — assign one below.
              </p>
            )}
            <div className="grid gap-1.5 sm:grid-cols-2">
              {[...mergedClasses]
                .sort((a, b) => (a.grade ?? "").localeCompare(b.grade ?? "") || a.name.localeCompare(b.name))
                .map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <span className="w-44 truncate text-[#5B6470]" title={c.name}>
                      {c.name}
                    </span>
                    {isAdmin ? (
                      <select
                        value={staffIds.has(c.teacher_id) ? c.teacher_id : ""}
                        onChange={(e) => void reassign(c.id, e.target.value)}
                        disabled={ctBusy}
                        className={`field h-8 px-2 text-sm ${staffIds.has(c.teacher_id) ? "" : "text-[#B42318]"}`}
                      >
                        {!staffIds.has(c.teacher_id) && <option value="">⚠ assign a class teacher…</option>}
                        {staff.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>{staff.find((t) => t.id === c.teacher_id)?.name ?? "⚠ unassigned"}</span>
                    )}
                  </label>
                ))}
            </div>
            {isAdmin && (
              <p className="text-[10px] text-[#98A0A9] mt-1.5">
                Reassigning moves the class — its students and join code — to the new class teacher. Timetable
                lessons keep their own subject teachers.
              </p>
            )}
            {ctErr && <p className="text-sm text-red-600 mt-1">{ctErr}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
