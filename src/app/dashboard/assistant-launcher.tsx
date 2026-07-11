"use client";

import { useState } from "react";
import AssistantPanel from "./assistant-panel";

// Floating launcher for the AI Teaching Assistant — bottom-right, stacked just
// above the feedback widget (which sits at bottom-5 right-5) so they don't
// collide. Behind NEXT_PUBLIC_FEATURE_AI_ASSISTANT (build-time); the /api/assistant
// route is the authoritative gate. Lazy: the panel only mounts when opened.
const ASSISTANT_ON = process.env.NEXT_PUBLIC_FEATURE_AI_ASSISTANT === "true";

export default function AssistantLauncher() {
  const [open, setOpen] = useState(false);
  if (!ASSISTANT_ON) return null;

  return (
    <>
      <div className="fixed bottom-20 right-5 z-40">
        <button
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
