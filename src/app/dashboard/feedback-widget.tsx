"use client";

import { useState } from "react";

// Beta feedback: a persistent "Give feedback" button + a short structured form.
// Entirely voluntary — the form opens only when the teacher clicks the button.
// After submitting, the button becomes a "received" state (single submission
// is enforced by the DB).

type Ratings = { overall: number; lesson_quality: number; deck_quality: number; ease_of_use: number };
const RATING_FIELDS: { key: keyof Ratings; label: string }[] = [
  { key: "overall", label: "Overall experience" },
  { key: "lesson_quality", label: "Lesson (video) quality" },
  { key: "deck_quality", label: "Deck & documents quality" },
  { key: "ease_of_use", label: "Ease of use" },
];

export default function FeedbackWidget({
  submitted: submittedInitial,
}: {
  submitted: boolean;
}) {
  const [submitted, setSubmitted] = useState(submittedInitial);
  const [open, setOpen] = useState(false);
  const [ratings, setRatings] = useState<Ratings>({ overall: 0, lesson_quality: 0, deck_quality: 0, ease_of_use: 0 });
  const [workedWell, setWorkedWell] = useState("");
  const [improve, setImprove] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (RATING_FIELDS.some((f) => !ratings[f.key])) {
      setError("Please rate all four items.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...ratings,
        worked_well: workedWell.trim() || null,
        improve: improve.trim() || null,
        trigger_type: "manual",
      }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok && res.status !== 409) {
      setError(json.error ?? "Could not submit — please try again.");
      return;
    }
    setSubmitted(true); // 409 = already submitted → same end state
    setOpen(false);
  }

  const stars = (key: keyof Ratings) => (
    <span className="inline-flex gap-1" role="radiogroup" aria-label={RATING_FIELDS.find((f) => f.key === key)?.label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={ratings[key] === n}
          aria-label={`${n} of 5`}
          onClick={() => setRatings((r) => ({ ...r, [key]: n }))}
          className={`h-8 w-8 rounded-lg border text-sm font-medium transition-colors ${
            ratings[key] >= n
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
    <>
      {/* Persistent entry point (bottom-right) — stacked ABOVE the AI Assistant
          launcher (which sits at bottom-4 right-4) so the two don't collide. */}
      <div className="fixed bottom-20 right-4 z-40">
        {submitted ? (
          <span className="inline-flex items-center gap-2 rounded-full bg-white border border-[#E6E8E4] px-4 h-10 text-sm text-[#0C8175] shadow-sm">
            ✓ Feedback received — thank you!
          </span>
        ) : (
          /* Collapsed to its mark like the other floating controls; the label
             returns on hover/focus. */
          <button
            onClick={() => setOpen(true)}
            title="Give feedback"
            aria-label="Give feedback"
            className="group btn-primary h-10 px-3 hover:px-4 focus-visible:px-4 text-sm rounded-full shadow-lg flex items-center transition-all"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
              <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.6-.7L3 21l1.9-4.6A8.1 8.1 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
            </svg>
            <span className="max-w-0 group-hover:max-w-[10rem] group-focus-visible:max-w-[10rem] ml-0 group-hover:ml-2 group-focus-visible:ml-2 overflow-hidden whitespace-nowrap transition-all duration-200">
              Give feedback
            </span>
          </button>
        )}
      </div>

      {open && !submitted && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && close()}>
          <div
            className="bg-white rounded-xl border border-[#E6E8E4] p-6 w-full max-w-md max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Beta feedback"
          >
            <h3 className="font-display font-medium text-lg mb-1">How was your beta experience?</h3>
            <p className="text-sm text-[#5B6470] mb-4">
              Two minutes of your thoughts would help us enormously.
            </p>

            <form onSubmit={submit} className="space-y-3">
              {RATING_FIELDS.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-3">
                  <span className="text-sm">{f.label}</span>
                  {stars(f.key)}
                </div>
              ))}
              <label className="block pt-1">
                <span className="text-xs text-[#5B6470]">What worked well?</span>
                <textarea
                  value={workedWell}
                  onChange={(e) => setWorkedWell(e.target.value)}
                  rows={2}
                  className="field w-full px-3 py-2 mt-1 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-[#5B6470]">What should we improve?</span>
                <textarea
                  value={improve}
                  onChange={(e) => setImprove(e.target.value)}
                  rows={2}
                  className="field w-full px-3 py-2 mt-1 text-sm"
                />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={close} disabled={busy} className="btn-ghost h-10 px-4 text-sm">
                  Not now
                </button>
                <button type="submit" disabled={busy} className="btn-primary h-10 px-4 text-sm">
                  {busy ? "Sending…" : "Send feedback"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
