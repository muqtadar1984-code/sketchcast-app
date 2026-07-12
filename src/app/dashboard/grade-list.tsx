"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { type Question, type QuizData } from "./quiz-player";

export type PendingSub = {
  id: string;
  studentName: string;
  label: string;
  mode: string;
  auto: number | null;
  max: number | null;
  answers?: Record<string, unknown> | null; // the student's interactive responses (by question id)
  quizUrl?: string | null; // signed URL of the quiz questions.json, for interactive submissions
};

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

// How the student answered a given question, as readable text.
function formatAnswer(q: Question, val: unknown): string {
  if (val == null || val === "") return "— (no answer)";
  if (q.type === "true_false") return val === true ? "True" : val === false ? "False" : String(val);
  if (q.type === "match") {
    const picked = (val as Record<number, string>) || {};
    return q.pairs.map((p, i) => `${p.left} → ${picked[i] || "—"}`).join("; ");
  }
  return String(val);
}

// Is an objective question correct? (null for short/subjective — those need a human.)
function objectiveCorrect(q: Question, val: unknown): boolean | null {
  if (q.type === "fill_blank") return norm(val) !== "" && norm(val) === norm(q.answer);
  if (q.type === "true_false") return typeof val === "boolean" && val === q.answer;
  if (q.type === "match") {
    const picked = (val as Record<number, string>) || {};
    return q.pairs.every((p, i) => norm(picked[i]) === norm(p.right));
  }
  return null; // short / subjective
}

// Teacher grading of submitted worksheets/exams that still need a mark. For a file
// submission it opens the student's uploaded file; for an in-app (interactive) quiz it
// shows each question with the student's written answer so short/subjective responses can
// be marked instead of scored blind. Saves a score + optional feedback (RLS sub_teacher_grade).
export default function GradeList({ pending }: { pending: PendingSub[] }) {
  const [rows, setRows] = useState(pending);
  const [score, setScore] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [quiz, setQuiz] = useState<Record<string, QuizData | "loading" | "error">>({});

  async function openFile(id: string) {
    setError(null);
    const res = await fetch(`/api/submission-url?id=${encodeURIComponent(id)}`);
    const json = await res.json();
    if (json.url) window.open(json.url, "_blank");
    else setError(json.error || "Could not open file.");
  }

  async function toggleReview(r: PendingSub) {
    if (openRow === r.id) {
      setOpenRow(null);
      return;
    }
    setOpenRow(r.id);
    if (!quiz[r.id] && r.quizUrl) {
      setQuiz((q) => ({ ...q, [r.id]: "loading" }));
      try {
        const res = await fetch(r.quizUrl);
        const data = (await res.json()) as QuizData;
        setQuiz((q) => ({ ...q, [r.id]: data?.questions?.length ? data : "error" }));
      } catch {
        setQuiz((q) => ({ ...q, [r.id]: "error" }));
      }
    }
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
    return <p className="text-sm text-[#5B6470]">Nothing to grade right now.</p>;
  }

  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const q = quiz[r.id];
        return (
          <div key={r.id} className="border border-[#EEF0EC] rounded-lg px-3 py-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm min-w-0">
                <span className="font-medium">{r.studentName}</span>
                <span className="text-[#5B6470]"> · {r.label}</span>
              </span>
              {r.mode === "file" ? (
                <button onClick={() => openFile(r.id)} className="text-xs font-medium text-[#0C8175] hover:underline">
                  Open file
                </button>
              ) : (
                <>
                  <span className="text-xs text-[#5B6470]">Auto-scored {r.auto ?? 0}/{r.max ?? 0}</span>
                  {r.quizUrl && (
                    <button onClick={() => toggleReview(r)} className="text-xs font-medium text-[#0C8175] hover:underline">
                      {openRow === r.id ? "Hide answers" : "Review answers"}
                    </button>
                  )}
                </>
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

            {openRow === r.id && (
              <div className="mt-2 border-t border-[#EEF0EC] pt-2 space-y-2">
                {q === "loading" && <p className="text-xs text-[#5B6470]">Loading answers…</p>}
                {q === "error" && <p className="text-xs text-red-600">Couldn’t load the quiz questions.</p>}
                {q && q !== "loading" && q !== "error" && (
                  <>
                    {q.questions.map((question, i) => {
                      const val = (r.answers ?? {})[question.id];
                      const correct = objectiveCorrect(question, val);
                      const needsMark = correct === null;
                      return (
                        <div key={question.id} className="text-xs">
                          <p className="text-[#14181F]">
                            <span className="text-[#98A0A9]">{i + 1}.</span> {question.prompt}
                            <span className="text-[#98A0A9]"> ({question.marks} mark{question.marks === 1 ? "" : "s"})</span>
                          </p>
                          <p className="text-[#5B6470] mt-0.5">
                            <span className="font-medium">Answer:</span> {formatAnswer(question, val)}{" "}
                            {correct === true && <span className="text-[#0C8175]">✓ correct</span>}
                            {correct === false && <span className="text-red-600">✗ incorrect</span>}
                            {needsMark && <span className="text-[#9A6400]">• mark this</span>}
                          </p>
                          {needsMark && "answer_outline" in question && question.answer_outline && (
                            <p className="text-[#98A0A9] mt-0.5"><span className="font-medium">Model:</span> {question.answer_outline}</p>
                          )}
                        </div>
                      );
                    })}
                    <p className="text-[11px] text-[#98A0A9]">
                      Objective questions are auto-scored ({r.auto ?? 0}/{r.max ?? 0}); add marks for the written answers above, then enter the total and Save.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
