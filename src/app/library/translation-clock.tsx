"use client";

import { useEffect, useState } from "react";
import { clockText, translationClock, type ClockPhase } from "@/utils/catalogue/translation-eta";

// The ticking clock on a translation in flight: "6 min · ~9 min left",
// "starts in ~20 min · ~35 min to review", or "18 min · longer than usual".
// The server hands it the phase, when the phase started and the typical run
// (translation-timing-server.ts); it re-reads the time every 15 s, so the
// minutes move between the page's own refreshes. The first render uses the
// server's `nowMs`, so the HTML hydrates without a mismatch.

const TICK_MS = 15_000;

export function TranslationClock({
  phase,
  since,
  typicalMin,
  nowMs,
  ahead = 0,
  runningSince = null,
  compact = false,
  className = "",
}: {
  phase: ClockPhase;
  since: string | null;
  typicalMin: number;
  /** the server's clock when the page was rendered */
  nowMs: number;
  /** queued: jobs ahead of this one */
  ahead?: number;
  /** queued: when the running translation started */
  runningSince?: string | null;
  /** the matrix cell's form: "~9 min left", "in ~20 min" */
  compact?: boolean;
  className?: string;
}) {
  const [now, setNow] = useState(nowMs);
  useEffect(() => {
    // the first read soon after mount (the browser's clock replaces the
    // server's), then every TICK_MS
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 1000);
    const t = setInterval(tick, TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  // a page refresh hands a newer server time; never count backwards from it
  const clock = translationClock({ phase, since, typicalMin, nowMs: Math.max(now, nowMs), ahead, runningSince });
  const text = clockText(clock);
  return (
    <span className={`tabular-nums ${clock.overdue ? "text-[#9A6400]" : ""} ${className}`} title={text.long}>
      {compact ? text.tiny : text.short}
    </span>
  );
}
