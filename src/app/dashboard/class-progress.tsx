"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";

type Row = { name: string; total: number; completed: number; revised: number; incomplete: number; overdue: number };

// Reverse feedback for the teacher: per-student completion across everything
// assigned to the class. Loaded on demand (a click, not an effect) so we don't
// fetch progress for every class up front.
export default function ClassProgress({ classId }: { classId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    const supabase = createClient();

    type EnrRow = { student_id: string; profiles: { full_name: string | null; username: string | null } | null };
    type ShareRow = { generation_id: string; due_at: string | null };
    const [{ data: enr }, { data: shares }] = await Promise.all([
      supabase.from("enrollments").select("student_id, profiles(full_name, username)").eq("class_id", classId),
      supabase.from("generation_shares").select("generation_id, due_at").eq("class_id", classId),
    ]);
    const students = ((enr ?? []) as unknown as EnrRow[]).map((e) => ({
      id: e.student_id,
      name: e.profiles?.full_name || e.profiles?.username || "Student",
    }));
    const shareRows = (shares ?? []) as ShareRow[];
    const genIds = shareRows.map((s) => s.generation_id);
    const dueByGen = new Map(shareRows.map((s) => [s.generation_id, s.due_at] as const));

    type ProgRow = { generation_id: string; student_id: string; status: string };
    type SubRow = { generation_id: string; student_id: string };
    let prog: ProgRow[] = [];
    let subs: SubRow[] = [];
    if (genIds.length) {
      const [{ data: p }, { data: su }] = await Promise.all([
        supabase.from("student_progress").select("generation_id, student_id, status").in("generation_id", genIds),
        supabase.from("submissions").select("generation_id, student_id").in("generation_id", genIds),
      ]);
      prog = (p ?? []) as ProgRow[];
      subs = (su ?? []) as SubRow[];
    }
    const statusOf = new Map<string, string>(prog.map((r) => [`${r.generation_id}|${r.student_id}`, r.status]));
    const submittedOf = new Set<string>(subs.map((r) => `${r.generation_id}|${r.student_id}`));
    const now = Date.now();

    const out: Row[] = students.map((stu) => {
      let completed = 0;
      let revised = 0;
      let overdue = 0;
      for (const gid of genIds) {
        const key = `${gid}|${stu.id}`;
        const st = statusOf.get(key);
        if (st === "completed" || submittedOf.has(key)) completed++;
        else if (st === "revised") revised++;
        else {
          const due = dueByGen.get(gid);
          if (due && new Date(due).getTime() < now) overdue++;
        }
      }
      const done = completed + revised;
      return { name: stu.name, total: genIds.length, completed, revised, incomplete: genIds.length - done, overdue };
    });

    setRows(out);
    setLoaded(true);
    setBusy(false);
  }

  if (!loaded) {
    return (
      <button onClick={load} disabled={busy} className="mt-3 text-xs font-medium text-[#0C8175] hover:underline disabled:opacity-50">
        {busy ? "Loading progress…" : "Show progress"}
      </button>
    );
  }

  if (rows.length === 0) {
    return <p className="mt-3 text-xs text-[#5B6470]">No students enrolled, or nothing assigned yet.</p>;
  }

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-[#98A0A9] text-left">
            <th className="font-medium py-1">Student</th>
            <th className="font-medium py-1 text-right">Completed</th>
            <th className="font-medium py-1 text-right">Revised</th>
            <th className="font-medium py-1 text-right">Incomplete</th>
            <th className="font-medium py-1 text-right">Overdue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-[#EEF0EC]">
              <td className="py-1.5 truncate">{r.name}</td>
              <td className="py-1.5 text-right font-medium text-[#0C8175] tabular">{r.completed}/{r.total}</td>
              <td className="py-1.5 text-right text-[#9A6400] tabular">{r.revised || "—"}</td>
              <td className="py-1.5 text-right text-[#5B6470] tabular">{r.incomplete}</td>
              <td className={`py-1.5 text-right tabular ${r.overdue ? "text-[#B42318]" : "text-[#98A0A9]"}`}>{r.overdue || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
