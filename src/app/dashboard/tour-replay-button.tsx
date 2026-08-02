"use client";

import { useTour } from "@/tour/TourProvider";

// The permanent "Take a tour" control (Section 7). Lives in the app header near
// the account controls. Hidden entirely when no tour is available for the role or
// the feature flag is off. Carries data-tour="tour-replay" so the coordinator
// tour can point its "need help?" step at it.
//
// Two words, two jobs: `label` is the short one that fits in the bar, `hint` is
// the sentence the tooltip and screen readers get. Both come from the header's
// dictionary — the tour itself is translated separately (its steps live in
// src/tour/definitions).
export default function TourReplayButton({ label, hint }: { label: string; hint: string }) {
  const { available, replay } = useTour();
  if (!available) return null;
  return (
    <button
      data-tour="tour-replay"
      onClick={replay}
      className="btn-ghost h-9 px-2.5 text-sm inline-flex items-center gap-1"
      aria-label={hint}
      title={hint}
    >
      <span aria-hidden>🧭</span> {label}
    </button>
  );
}
