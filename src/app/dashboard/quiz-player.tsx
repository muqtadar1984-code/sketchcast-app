"use client";

import { useMemo, useState } from "react";

export type Question =
  | { id: string; type: "fill_blank" | "short"; prompt: string; answer?: string; marks: number }
  | { id: string; type: "true_false"; prompt: string; answer?: boolean; marks: number }
  | { id: string; type: "match"; prompt: string; pairs: { left: string; right: string }[]; marks: number }
  | { id: string; type: "subjective"; prompt: string; answer_outline?: string; marks: number };

export type QuizData = { title: string; instructions: string; questions: Question[] };

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

// In-app interactive quiz. Renders each question by type; on submit it
// auto-grades the objective questions (fill_blank / true_false / match) and
// hands the answers + score back to the caller, which records the submission.
// short / subjective answers are collected but left for the teacher to mark.
export default function QuizPlayer({
  data,
  onClose,
  onSubmit,
}: {
  data: QuizData;
  onClose: () => void;
  onSubmit: (answers: Record<string, unknown>, auto: number, max: number, needsReview: boolean) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const set = (id: string, v: unknown) => setAnswers((a) => ({ ...a, [id]: v }));

  // Right-hand options per match question, ordered deterministically (alphabetical)
  // so they don't simply line up with the prompts — and so render stays pure.
  const matchOptions = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const q of data.questions) {
      if (q.type === "match") {
        m[q.id] = q.pairs.map((p) => p.right).sort((a, b) => a.localeCompare(b));
      }
    }
    return m;
  }, [data]);

  async function submit() {
    setBusy(true);
    let auto = 0;
    let max = 0;
    let needsReview = false;
    for (const q of data.questions) {
      max += q.marks || 0;
      if (q.type === "fill_blank") {
        if (norm(answers[q.id]) && norm(answers[q.id]) === norm(q.answer)) auto += q.marks || 1;
      } else if (q.type === "true_false") {
        if (typeof answers[q.id] === "boolean" && answers[q.id] === q.answer) auto += q.marks || 1;
      } else if (q.type === "match") {
        const picked = (answers[q.id] as Record<number, string>) || {};
        q.pairs.forEach((p, i) => {
          if (norm(picked[i]) === norm(p.right)) auto += 1;
        });
      } else {
        needsReview = true; // short / subjective → teacher marks
      }
    }
    await onSubmit(answers, auto, max, needsReview);
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl max-h-[88vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-xl font-display mb-1">{data.title}</h3>
        {data.instructions && <p className="text-sm text-[#5B6470] mb-4">{data.instructions}</p>}

        <ol className="space-y-4">
          {data.questions.map((q, qi) => (
            <li key={q.id}>
              <p className="text-sm font-medium mb-1.5">
                <span className="text-[#98A0A9]">{qi + 1}.</span> {q.prompt}
                {q.marks ? <span className="text-[#98A0A9] font-normal"> [{q.marks}]</span> : null}
              </p>

              {(q.type === "fill_blank" || q.type === "short") && (
                <input
                  value={(answers[q.id] as string) ?? ""}
                  onChange={(e) => set(q.id, e.target.value)}
                  placeholder="Your answer"
                  className="field h-9 px-3 text-sm w-full max-w-md"
                />
              )}

              {q.type === "true_false" && (
                <div className="flex gap-2">
                  {[true, false].map((v) => (
                    <button
                      key={String(v)}
                      onClick={() => set(q.id, v)}
                      className={`h-8 px-4 rounded-lg border text-sm ${
                        answers[q.id] === v
                          ? "border-[#1FB8A6] bg-[#E2F4F1] text-[#0C8175]"
                          : "border-[#E6E8E4] text-[#5B6470]"
                      }`}
                    >
                      {v ? "True" : "False"}
                    </button>
                  ))}
                </div>
              )}

              {q.type === "match" && (
                <div className="space-y-1.5">
                  {q.pairs.map((p, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-sm min-w-0 flex-1 truncate">{i + 1}. {p.left}</span>
                      <select
                        value={((answers[q.id] as Record<number, string>) || {})[i] ?? ""}
                        onChange={(e) => set(q.id, { ...((answers[q.id] as Record<number, string>) || {}), [i]: e.target.value })}
                        className="field h-9 px-2 text-sm max-w-[55%]"
                      >
                        <option value="">— choose —</option>
                        {matchOptions[q.id]?.map((r, ri) => (
                          <option key={ri} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}

              {q.type === "subjective" && (
                <textarea
                  value={(answers[q.id] as string) ?? ""}
                  onChange={(e) => set(q.id, e.target.value)}
                  rows={3}
                  placeholder="Your answer"
                  className="field px-3 py-2 text-sm w-full"
                />
              )}
            </li>
          ))}
        </ol>

        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={onClose} disabled={busy} className="btn-ghost h-9 px-3 text-sm">Cancel</button>
          <button onClick={submit} disabled={busy} className="btn-primary h-9 px-4 text-sm">
            {busy ? "Submitting…" : "Submit answers"}
          </button>
        </div>
      </div>
    </div>
  );
}
