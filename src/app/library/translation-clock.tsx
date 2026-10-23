"use client";

import { useEffect, useState } from "react";
import { clockText, fmtMinutes, translationClock, translationProgress, type ClockPhase } from "@/utils/catalogue/translation-eta";

// The ticking clock on a translation in flight: "6 min · ~9 min left",
// "starts in ~20 min · ~35 min to review", or "18 min · longer than usual".
// The server hands it the phase, when the phase started and the typical run
// (translation-timing-server.ts); it re-reads the time every 15 s, so the
// minutes move between the page's own refreshes. The first render uses the
// server's `nowMs`, so the HTML hydrates without a mismatch.

const TICK_MS = 15_000;

/** The browser's clock, ticking every TICK_MS; the server's `nowMs` first
 *  (so the HTML hydrates), and never earlier than it (a page refresh hands a
 *  newer server time — never count backwards from it). */
function useNow(nowMs: number): number {
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
  return Math.max(now, nowMs);
}

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
  const now = useNow(nowMs);
  const clock = translationClock({ phase, since, typicalMin, nowMs: now, ahead, runningSince });
  const text = clockText(clock);
  return (
    <span className={`tabular-nums ${clock.overdue ? "text-[#9A6400]" : ""} ${className}`} title={text.long}>
      {compact ? text.tiny : text.short}
    </span>
  );
}

/** The Totals table's bar under Translating: "62% · ~6 min left" for the run
 *  furthest along in a language (translation-eta.ts translationProgress —
 *  staging = the job's own progress, building = the typical run spent), plus
 *  "+N" for the rest of the column. Ticks like the clock. Renders nothing for
 *  a queued run. */
export function TranslationProgressBar({
  phase,
  since,
  typicalMin,
  jobProgress = null,
  nowMs,
  others = 0,
  othersTitle = "",
  className = "",
}: {
  phase: ClockPhase;
  since: string | null;
  typicalMin: number;
  /** staging: the translate job's progress, 0–100 */
  jobProgress?: number | null;
  /** the server's clock when the page was rendered */
  nowMs: number;
  /** the rest of the column (running or queued) beside the one shown */
  others?: number;
  othersTitle?: string;
  className?: string;
}) {
  const now = useNow(nowMs);
  const p = translationProgress({ phase, since, typicalMin, nowMs: now, jobProgress });
  if (!p) return null;
  const what =
    p.phase === "translating"
      ? `Translating the words — the translate job is at ${Math.round(jobProgress ?? 0)}% (the first part of the bar).`
      : `Building the video and documents — estimated from a typical ${fmtMinutes(typicalMin)} run.`;
  const when = p.finishing ? "Past the typical run: finishing any minute (a retried piece or a busy image service stretches a run)." : "";
  return (
    <span className={`block w-36 ${className}`} title={[what, when].filter(Boolean).join(" ")}>
      <span
        className="block h-1.5 rounded-full bg-[#EDE7FB] overflow-hidden"
        role="progressbar"
        aria-label="Translation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={p.pct}
      >
        <span className="block h-full rounded-full bg-[#5B3FBF] transition-[width] duration-700" style={{ width: `${p.pct}%` }} />
      </span>
      <span className={`block mt-0.5 text-[0.7rem] tabular-nums ${p.finishing ? "text-[#9A6400]" : "text-[#5B6470]"}`}>
        {p.text}
        {others > 0 && (
          <span className="text-[#8A929C]" title={othersTitle || undefined}>
            {" "}
            · +{others}
          </span>
        )}
      </span>
    </span>
  );
}
