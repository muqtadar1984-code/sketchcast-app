"use client";

import { useTour } from "@/tour/TourProvider";

// The permanent "Take a tour" control (Section 7). Lives in the app header near
// the account controls. Hidden entirely when no tour is available for the role or
// the feature flag is off. Carries data-tour="tour-replay" so the coordinator
// tour can point its "need help?" step at it.
export default function TourReplayButton() {
  const { available, replay } = useTour();
  if (!available) return null;
  return (
    <button
      data-tour="tour-replay"
      onClick={replay}
      className="btn-ghost h-9 px-2.5 text-sm inline-flex items-center gap-1"
      aria-label="Take a tour"
      title="Take a tour"
    >
      <span aria-hidden>🧭</span> Tour
    </button>
  );
}
