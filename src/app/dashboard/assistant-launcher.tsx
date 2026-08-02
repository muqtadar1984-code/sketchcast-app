"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import AssistantPanel, { type AssistantMessages } from "./assistant-panel";

// Floating launcher for the AI Teaching Assistant — bottom-RIGHT, on the same
// baseline as the bottom-LEFT "Report a problem" widget (both at bottom-4) so
// the two corners line up. The beta "Give feedback" widget stacks ABOVE this one
// (bottom-20 right) when present. Behind NEXT_PUBLIC_FEATURE_AI_ASSISTANT
// (build-time); the /api/assistant route is the authoritative gate. Lazy: the
// panel only mounts when opened.
const ASSISTANT_ON = process.env.NEXT_PUBLIC_FEATURE_AI_ASSISTANT === "true";

export default function AssistantLauncher({ t }: { t: AssistantMessages }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  if (!ASSISTANT_ON) return null;
  // The leadership School pages surface their own bottom-right launcher (the
  // School-briefing bot); hide the teaching Assistant there so the two don't
  // overlap (and a principal isn't offered a book tutor they don't use).
  if (pathname?.startsWith("/dashboard/school")) return null;

  return (
    <>
      <div className="fixed bottom-4 end-4 z-40">
        {/* Collapsed to its mark by default, expanding on hover/focus — the same
            treatment as the bottom-left "Report a problem" widget, so neither
            floating pill sits over the content column. */}
        <button
          data-tour="assistant"
          onClick={() => setOpen(true)}
          className="group btn-primary h-11 px-3 hover:px-4 focus-visible:px-4 text-sm rounded-full shadow-lg flex items-center transition-all"
          title={t.launcherHint}
          aria-label={t.launcherHint}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
            <path d="M22 9 12 5 2 9l10 4 10-4z" />
            <path d="M6 11.5V16c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4.5" />
          </svg>
          <span className="max-w-0 group-hover:max-w-[8rem] group-focus-visible:max-w-[8rem] ms-0 group-hover:ms-2 group-focus-visible:ms-2 overflow-hidden whitespace-nowrap transition-all duration-200">
            {t.launcher}
          </span>
        </button>
      </div>
      {open && <AssistantPanel t={t} onClose={() => setOpen(false)} />}
    </>
  );
}
