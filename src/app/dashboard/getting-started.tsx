"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

// Inline, progress-tracking onboarding for new joiners: three steps that check
// themselves off from the user's REAL data (a book exists → a lesson exists → a
// share exists), with a one-line hint on whichever step is current. Not a
// coach-mark overlay (that's the separate driver.js tour) — a card that lives in
// the page and shrinks the "where do I even start" gap. Dismisses to a profile
// watermark (0064) so it never nags again; existing users were backfilled as
// done, so only genuinely-new accounts ever see it.

type StepsDone = { upload: boolean; generate: boolean; assign: boolean };

export default function GettingStarted({
  userId,
  variant = "teacher",
  steps,
}: {
  userId: string;
  /** Parents share papers with a child, not a class — one word of the copy differs. */
  variant?: "teacher" | "parent";
  steps: StepsDone;
}) {
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  if (hidden) return null;

  const isParent = variant === "parent";
  const list = [
    {
      key: "upload",
      title: "Upload a textbook",
      hint: "Add a PDF in the box below — chapters are detected automatically, scanned books included.",
      done: steps.upload,
    },
    {
      key: "generate",
      title: isParent ? "Generate a test paper" : "Generate a lesson kit",
      hint: isParent
        ? "Open a book, then generate a worksheet or test paper for a chapter."
        : "Open a book and press Generate full kit — a narrated video, slides, plan, worksheet and more.",
      done: steps.generate,
    },
    {
      key: "assign",
      title: isParent ? "Share it with your child" : "Assign it to your students",
      hint: isParent
        ? "Use Assign on a finished paper to send it to your child."
        : "Use Assign on a finished lesson to share it with a class and watch progress.",
      done: steps.assign,
    },
  ];
  const doneCount = list.filter((s) => s.done).length;
  const allDone = doneCount === list.length;
  const currentIdx = list.findIndex((s) => !s.done); // -1 when all done

  async function dismiss() {
    setBusy(true);
    setHidden(true); // optimistic — a failed write just means it returns next load
    try {
      const supabase = createClient();
      await supabase
        .from("profiles")
        .update({ getting_started_dismissed_at: new Date().toISOString() })
        .eq("id", userId);
    } catch {
      /* best-effort */
    }
    router.refresh();
  }

  return (
    <div className="card p-5 mb-8 relative">
      <button
        onClick={dismiss}
        disabled={busy}
        aria-label="Dismiss getting started"
        title="Dismiss"
        className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-md text-[#98A0A9] hover:bg-[#F5F6F3] hover:text-[#5B6470] disabled:opacity-50"
      >
        ✕
      </button>

      <div className="flex items-center gap-2 mb-3.5">
        <span aria-hidden className="text-lg">
          {allDone ? "🎉" : "👋"}
        </span>
        <h2 className="font-display font-medium text-[#14181F]">
          {allDone ? "You're all set!" : "Getting started"}
        </h2>
        <span className="chip bg-[#E2F4F1] text-[#0C8175] ml-1">
          {doneCount}/{list.length}
        </span>
      </div>

      <ol className="space-y-2.5">
        {list.map((s, i) => {
          const isCurrent = i === currentIdx;
          return (
            <li key={s.key} className="flex items-start gap-3">
              <span
                className={`mt-0.5 h-6 w-6 shrink-0 rounded-full inline-flex items-center justify-center text-xs font-medium ${
                  s.done
                    ? "bg-[#1FB8A6] text-white"
                    : isCurrent
                      ? "bg-[#0C8175] text-white"
                      : "bg-[#EEF0EC] text-[#98A0A9]"
                }`}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`text-sm font-medium ${s.done ? "text-[#98A0A9] line-through" : "text-[#14181F]"}`}>
                  {s.title}
                </span>
                {isCurrent && <span className="block text-xs text-[#5B6470] mt-0.5">{s.hint}</span>}
              </span>
            </li>
          );
        })}
      </ol>

      {allDone && (
        <div className="mt-4">
          <button onClick={dismiss} disabled={busy} className="btn-primary h-9 px-4 text-sm">
            Finish
          </button>
        </div>
      )}
    </div>
  );
}
