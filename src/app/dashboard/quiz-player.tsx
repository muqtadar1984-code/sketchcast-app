"use client";

import { useState } from "react";
import type { StudentQuestion, StudentQuizData } from "@/app/api/quiz/logic";

/** The RAW quiz shape — answer key included. Only the TEACHER's surfaces
 * (grade-list) ever hold one of these; it is re-exported from here purely
 * because that is where they have always imported it from. A student payload
 * is `StudentQuizData`, which has no answers in it at all. */
export type { RawQuestion as Question, RawQuiz as QuizData } from "@/app/api/quiz/logic";
export type { StudentQuestion, StudentQuizData };

// In-app interactive quiz. Renders each question by type and hands the raw
// answers back to the caller, which posts them to /api/quiz/submit.
//
// THIS COMPONENT NO LONGER GRADES, and no longer receives anything it could
// grade with. Two things used to leak here:
//   * every `answer` / `answer_outline` arrived in the payload so the browser
//     could compute the mark — and the browser then told the database what the
//     mark was;
//   * match questions arrived as `pairs` with left and right ADJACENT, so the
//     pairing could be read straight out of the network response no matter how
//     the <select> options were ordered.
// Now the server sends prompts, an unpaired shuffled option bag, and marks;
// the score comes back from the route and is never computed here.
export default function QuizPlayer({
  data,
  onClose,
  onSubmit,
}: {
  data: StudentQuizData;
  onClose: () => void;
  onSubmit: (answers: Record<string, unknown>) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (id: string, v: unknown) => setAnswers((a) => ({ ...a, [id]: v }));

  async function submit() {
    if (busy) return; // one in flight at a time (0076: a double-tap really happens)
    setBusy(true);
    setError(null);
    // A rejected write must SHOW — the answers stay on screen for a retry.
    // (The original swallowed the error and the player sat busy forever.)
    try {
      await onSubmit(answers);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't submit — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl max-h-[88dvh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-xl font-display mb-1">{data.title}</h3>
        {data.instructions && <p className="text-sm text-[#5B6470] mb-4">{data.instructions}</p>}

        <ol className="space-y-4">
          {data.questions.map((q: StudentQuestion, qi: number) => (
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
                  {q.left.map((left, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-sm min-w-0 flex-1 truncate">{i + 1}. {left}</span>
                      <select
                        value={((answers[q.id] as Record<number, string>) || {})[i] ?? ""}
                        onChange={(e) => set(q.id, { ...((answers[q.id] as Record<number, string>) || {}), [i]: e.target.value })}
                        className="field h-9 px-2 text-sm max-w-[55%]"
                      >
                        <option value="">— choose —</option>
                        {/* Server-shuffled, unpaired: the option order carries no answer. */}
                        {q.options.map((r, ri) => (
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

        {error && <p className="text-xs text-red-600 mt-4 text-end">{error}</p>}
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
