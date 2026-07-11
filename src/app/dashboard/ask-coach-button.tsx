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
      <button
        onClick={() => setOpen(true)}
        className={className ?? "font-medium text-[#0C8175] hover:underline"}
        title="Try the AI coach on this lesson"
      >
        🎓 Assistant
      </button>
      {open && (
        <AskCoach generationId={generationId} chapterLabel={chapterLabel} studentId={studentId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
