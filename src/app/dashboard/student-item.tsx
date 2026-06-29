"use client";

import { useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";

export type ProgressStatus = "assigned" | "in_progress" | "completed" | "revised";

export type StudentItemData = {
  genId: string;
  kind: string;
  label: string;
  dueAt: string | null;
  dueOverdue: boolean;
  classId: string | null;
  video: string | null;
  deck: string | null;
  doc: string | null;
  status: ProgressStatus | null;
  revisionCount: number;
  submitted: boolean;
};

function Badge({ status, submitted }: { status: ProgressStatus | null; submitted: boolean }) {
  if (status === "completed" || (submitted && status !== "revised"))
    return <span className="chip normal-case tracking-normal bg-[#EAF1EC] text-[#2E6B4E]">✓ Completed</span>;
  if (status === "revised")
    return <span className="chip normal-case tracking-normal bg-[#FAEEDA] text-[#854F0B]">↻ Revised</span>;
  if (status === "in_progress")
    return <span className="chip normal-case tracking-normal bg-[#F1ECE0] text-[#6F6A5F]">In progress</span>;
  return <span className="chip normal-case tracking-normal bg-[#F1ECE0] text-[#9A958A]">Not started</span>;
}

// One assigned item on the student dashboard. The lesson plays in-app and is
// marked complete when watched to the end (re-opening a finished one -> revised);
// worksheets/exams are opened, then an answer file is uploaded to submit. All
// writes go through the student's own session (RLS).
export default function StudentItem({ item, studentId }: { item: StudentItemData; studentId: string }) {
  const supabase = createClient();
  const [status, setStatus] = useState<ProgressStatus | null>(item.status);
  const [revisions, setRevisions] = useState(item.revisionCount);
  const [submitted, setSubmitted] = useState(item.submitted);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const base = { generation_id: item.genId, student_id: studentId, class_id: item.classId };

  async function markOpen() {
    if (status === "completed" || status === "revised") {
      const next = revisions + 1;
      await supabase
        .from("student_progress")
        .upsert({ ...base, status: "revised", revised_at: new Date().toISOString(), revision_count: next }, { onConflict: "generation_id,student_id" });
      setRevisions(next);
      setStatus("revised");
    } else if (!status || status === "assigned") {
      await supabase
        .from("student_progress")
        .upsert({ ...base, status: "in_progress", opened_at: new Date().toISOString() }, { onConflict: "generation_id,student_id" });
      setStatus("in_progress");
    }
  }

  async function markComplete() {
    if (status === "completed" || status === "revised") return;
    await supabase
      .from("student_progress")
      .upsert({ ...base, status: "completed", completed_at: new Date().toISOString(), progress_pct: 100 }, { onConflict: "generation_id,student_id" });
    setStatus("completed");
  }

  function watch() {
    if (!item.video) return;
    setPlaying(true);
    void markOpen();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${studentId}/${item.genId}/${Date.now()}_${safe}`;
    const up = await supabase.storage.from("submissions").upload(path, f, { upsert: true });
    if (up.error) {
      setError(up.error.message);
      setBusy(false);
      return;
    }
    const { error: sErr } = await supabase
      .from("submissions")
      .upsert({ ...base, mode: "file", file_path: path, grade_status: "pending", submitted_at: new Date().toISOString() }, { onConflict: "generation_id,student_id" });
    if (sErr) {
      setError(sErr.message);
      setBusy(false);
      return;
    }
    await markComplete();
    setSubmitted(true);
    setBusy(false);
  }

  const isLesson = item.kind === "presentation";
  const done = status === "completed" || status === "revised" || submitted;
  const overdue = item.dueOverdue && !done;

  return (
    <li className="flex items-center justify-between gap-4 py-0.5">
      <span className="flex items-center gap-2 text-sm min-w-0">
        <span className="text-[10px] uppercase tracking-wide text-[#9A958A]">{item.label}</span>
        <Badge status={status} submitted={submitted} />
      </span>
      <span className="flex items-center gap-3 shrink-0 text-xs">
        {item.dueAt && (
          <span className={overdue ? "text-[#A32D2D]" : "text-[#6F6A5F]"}>
            Due {new Date(item.dueAt).toLocaleDateString()}
          </span>
        )}
        {isLesson ? (
          <>
            {item.video && (
              <button onClick={watch} className="font-medium text-[#2E6B4E] hover:underline">▶ Watch</button>
            )}
            {item.deck && (
              <a href={item.deck} className="font-medium text-[#2E6B4E] hover:underline">⬇ Deck</a>
            )}
          </>
        ) : (
          <>
            {item.doc && (
              <a href={item.doc} className="font-medium text-[#2E6B4E] hover:underline">⬇ Open</a>
            )}
            <button onClick={() => fileRef.current?.click()} disabled={busy} className="font-medium text-[#2E6B4E] hover:underline disabled:opacity-50">
              {busy ? "Uploading…" : submitted ? "Resubmit" : "Submit answer"}
            </button>
            <input ref={fileRef} type="file" className="hidden" onChange={onFile} />
          </>
        )}
      </span>

      {error && <span className="sr-only">{error}</span>}

      {playing && item.video && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPlaying(false)}>
          <div className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
            <video src={item.video} controls autoPlay onEnded={markComplete} className="w-full rounded-lg bg-black" />
            <div className="flex items-center justify-between mt-2">
              <p className="text-xs text-white/70">Watch to the end to mark this lesson complete.</p>
              <button onClick={() => setPlaying(false)} className="text-xs text-white/90 hover:underline">Close</button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
