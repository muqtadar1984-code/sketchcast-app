"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";

export type PendingSub = {
  id: string;
  studentName: string;
  label: string;
  mode: string;
  auto: number | null;
  max: number | null;
};

// Teacher grading of submitted worksheets/exams that still need a mark. Opens
// the student's uploaded file (signed via /api/submission-url) and saves a score
// + optional feedback (RLS sub_teacher_grade).
export default function GradeList({ pending }: { pending: PendingSub[] }) {
  const [rows, setRows] = useState(pending);
  const [score, setScore] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openFile(id: string) {
    setError(null);
    const res = await fetch(`/api/submission-url?id=${encodeURIComponent(id)}`);
    const json = await res.json();
    if (json.url) window.open(json.url, "_blank");
    else setError(json.error || "Could not open file.");
  }

  async function save(id: string) {
    const raw = score[id];
    if (raw === undefined || raw === "") {
      setError("Enter a score first.");
      return;
    }
    setBusy(id);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error: uErr } = await supabase
      .from("submissions")
      .update({
        teacher_score: Number(raw),
        feedback: feedback[id]?.trim() || null,
        grade_status: "graded",
        graded_by: user?.id ?? null,
        graded_at: new Date().toISOString(),
      })
      .eq("id", id);
    setBusy(null);
    if (uErr) {
      setError(uErr.message);
      return;
    }
    setRows((rs) => rs.filter((r) => r.id !== id)); // drop from the to-grade list
  }

  if (rows.length === 0) {
    return <p className="text-sm text-[#6F6A5F]">Nothing to grade right now.</p>;
  }

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-3 border border-[#F1ECE0] rounded-lg px-3 py-2">
          <span className="text-sm min-w-0">
            <span className="font-medium">{r.studentName}</span>
            <span className="text-[#6F6A5F]"> · {r.label}</span>
          </span>
          {r.mode === "file" ? (
            <button onClick={() => openFile(r.id)} className="text-xs font-medium text-[#2E6B4E] hover:underline">
              Open file
            </button>
          ) : (
            <span className="text-xs text-[#6F6A5F]">Auto-scored {r.auto ?? 0}/{r.max ?? 0}</span>
          )}
          <span className="flex items-center gap-2 ml-auto">
            <input
              type="number"
              placeholder="Score"
              value={score[r.id] ?? ""}
              onChange={(e) => setScore((s) => ({ ...s, [r.id]: e.target.value }))}
              className="field h-8 w-20 px-2 text-sm text-right"
            />
            <input
              placeholder="Feedback (optional)"
              value={feedback[r.id] ?? ""}
              onChange={(e) => setFeedback((s) => ({ ...s, [r.id]: e.target.value }))}
              className="field h-8 w-44 px-2 text-sm"
            />
            <button onClick={() => save(r.id)} disabled={busy === r.id} className="btn-primary h-8 px-3 text-xs">
              {busy === r.id ? "Saving…" : "Save"}
            </button>
          </span>
        </div>
      ))}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
