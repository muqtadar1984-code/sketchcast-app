"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Dictionary } from "@/i18n/dictionaries";
import {
  EMPTY_ANSWERS,
  MOST_USED_OPTIONS,
  RATING_KEYS,
  answersComplete,
  buildSubmitBody,
  type QuestionnaireAnswers,
  type RatingKey,
} from "@/utils/feedback-questionnaire";

// The founder-requested feedback questionnaire (feedback_requests, 0083).
// Renders as soon as the dashboard finds an OPEN request for this user and
// closes through exactly two doors, both of which stamp the request so it
// stops re-appearing:
//   Send        → POST /api/feedback {action:'submit', …} (responds_at set)
//   Maybe later → POST /api/feedback {action:'later'} (snoozed 3 days)
// Clicking the backdrop only hides it for THIS render — no network call, so
// the same request simply shows again on the next dashboard visit. Nothing is
// hard-blocked; the page behind stays fully rendered.
//
// Same overlay pattern as junk-gate-dialog.tsx (fixed inset-0 + card), and the
// same numbered-button star rows as feedback-widget.tsx — RTL-safe: logical
// spacing only, and the row direction follows the document like every other
// dialog. All words arrive via the feedbackAsk dictionary slice (type-only
// import; the server-only dictionary module never reaches this bundle).

export type FeedbackAskMessages = Dictionary["feedbackAsk"];

const RATING_QUESTION: Record<RatingKey, "q1" | "q2" | "q3"> = {
  ease: "q1",
  usefulness: "q2",
  quality: "q3",
};

export default function FeedbackQuestionnaire({
  requestId,
  t,
}: {
  requestId: string;
  t: FeedbackAskMessages;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<QuestionnaireAnswers>(EMPTY_ANSWERS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      setHidden(true);
      router.refresh();
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  function send() {
    const body = buildSubmitBody(requestId, answers);
    if (!body) return; // button is disabled while incomplete; belt and braces
    void post(body);
  }

  const later = () => void post({ action: "later", request_id: requestId });

  const stars = (key: RatingKey) => (
    <span className="inline-flex gap-1" role="radiogroup" aria-label={t[RATING_QUESTION[key]]}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={answers[key] === n}
          aria-label={`${n}`}
          onClick={() => setAnswers((a) => ({ ...a, [key]: n }))}
          className={`h-8 w-8 rounded-lg border text-sm font-medium transition-colors ${
            answers[key] >= n
              ? "border-[#1FB8A6] bg-[#E2F4F1] text-[#0C8175]"
              : "border-[#E6E8E4] bg-white text-[#98A0A9] hover:border-[#98A0A9]"
          }`}
        >
          {n}
        </button>
      ))}
    </span>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#14181F]/40" onClick={() => !busy && setHidden(true)} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.intro}
        className="relative card w-full max-w-md p-6 max-h-[90dvh] overflow-y-auto"
      >
        <p className="font-display text-base font-medium mb-4">{t.intro}</p>

        <div className="space-y-4">
          {RATING_KEYS.map((key) => (
            <div key={key}>
              <p className="text-sm mb-1.5">{t[RATING_QUESTION[key]]}</p>
              {stars(key)}
              {key === "ease" && (
                <div className="flex justify-between text-xs text-[#98A0A9] mt-1 max-w-[12rem]">
                  <span>{t.q1Low}</span>
                  <span>{t.q1High}</span>
                </div>
              )}
            </div>
          ))}

          <fieldset>
            <legend className="text-sm mb-1.5">{t.q4}</legend>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t.q4}>
              {MOST_USED_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  role="radio"
                  aria-checked={answers.mostUsed === opt}
                  onClick={() => setAnswers((a) => ({ ...a, mostUsed: opt }))}
                  className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                    answers.mostUsed === opt
                      ? "border-[#1FB8A6] bg-[#E2F4F1] text-[#0C8175] font-medium"
                      : "border-[#E6E8E4] bg-white text-[#5B6470] hover:border-[#98A0A9]"
                  }`}
                >
                  {t.q4Options[opt]}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="text-sm">{t.q5}</span>
            <textarea
              value={answers.blocker}
              onChange={(e) => setAnswers((a) => ({ ...a, blocker: e.target.value }))}
              rows={2}
              className="field w-full px-3 py-2 mt-1 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-sm">{t.q6}</span>
            <textarea
              value={answers.wish}
              onChange={(e) => setAnswers((a) => ({ ...a, wish: e.target.value }))}
              rows={2}
              className="field w-full px-3 py-2 mt-1 text-sm"
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-[#5B6470]">
            <input
              type="checkbox"
              checked={answers.contactOk}
              onChange={(e) => setAnswers((a) => ({ ...a, contactOk: e.target.checked }))}
              className="h-4 w-4 accent-[#1FB8A6]"
            />
            {t.contact}
          </label>

          {error && <p className="text-sm text-[#B42318]">{t.error}</p>}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button onClick={later} disabled={busy} className="btn-ghost h-9 px-3 text-sm">
              {t.later}
            </button>
            <button
              onClick={send}
              disabled={busy || !answersComplete(answers)}
              className="btn-primary h-9 px-3 text-sm disabled:opacity-50"
            >
              {t.send}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
