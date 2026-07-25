"use client";

import { useState } from "react";
import AskCoach from "./ask-coach";

// A small launcher for the Ask Coach panel, reusable on any surface that shows a
// lesson (teacher library, parent children page, …). Server-side access is
// authoritative (resolveTutorContext allows the owner, an assigned student, or a
// verified parent); this button only opens the panel. Pass `studentId` only for
// the assigned student — that adds their personal recap inside the panel.
const AI_TUTOR = process.env.NEXT_PUBLIC_FEATURE_AI_TUTOR === "true";

export default function AskCoachButton({
  generationId,
  chapterLabel,
  studentId,
  className,
}: {
  generationId: string;
  chapterLabel: string;
  studentId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!AI_TUTOR) return null;
  return (
    <>
      {/* A drawn mark, not an emoji: this sits in the lesson card's chip row
          beside the download/new-version glyphs, and an emoji renders at a
          different size per platform and can't take the row's colour. */}
      <button
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1 ${className ?? "font-medium text-[#0C8175] hover:underline"}`}
        title="Try the AI coach on this lesson"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
          <path d="M22 9 12 5 2 9l10 4 10-4z" />
          <path d="M6 11.5V16c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4.5" />
        </svg>
        Assistant
      </button>
      {open && (
        <AskCoach generationId={generationId} chapterLabel={chapterLabel} studentId={studentId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
