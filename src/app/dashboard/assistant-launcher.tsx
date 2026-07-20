"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import AssistantPanel from "./assistant-panel";

// Floating launcher for the AI Teaching Assistant — bottom-RIGHT, on the same
// baseline as the bottom-LEFT "Report a problem" widget (both at bottom-4) so
// the two corners line up. The beta "Give feedback" widget stacks ABOVE this one
// (bottom-20 right) when present. Behind NEXT_PUBLIC_FEATURE_AI_ASSISTANT
// (build-time); the /api/assistant route is the authoritative gate. Lazy: the
// panel only mounts when opened.
const ASSISTANT_ON = process.env.NEXT_PUBLIC_FEATURE_AI_ASSISTANT === "true";

export default function AssistantLauncher() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  if (!ASSISTANT_ON) return null;
  // The leadership School pages surface their own bottom-right launcher (the
  // School-briefing bot); hide the teaching Assistant there so the two don't
  // overlap (and a principal isn't offered a book tutor they don't use).
  if (pathname?.startsWith("/dashboard/school")) return null;

  return (
    <>
      <div className="fixed bottom-4 right-4 z-40">
        <button
          data-tour="assistant"
          onClick={() => setOpen(true)}
          className="btn-primary h-11 px-4 text-sm rounded-full shadow-lg flex items-center gap-2"
          aria-label="Open the AI Teaching Assistant"
        >
          <span aria-hidden>🎓</span> Assistant
        </button>
      </div>
      {open && <AssistantPanel onClose={() => setOpen(false)} />}
    </>
  );
}
