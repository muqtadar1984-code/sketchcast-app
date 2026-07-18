"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";

// The issue-status bell: every report the user has made, with its live triage
// status — the loop-closer for "I reported it, then heard nothing". Data
// arrives from the server header (RLS: reporters read their own
// platform_issues rows); opening the bell advances the profile's
// notifications_seen_at watermark, which is what the badge counts against.

export type IssueNotification = {
  id: string;
  title: string;
  category: string | null;
  status: string;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  open: "Received",
  triaged: "Being reviewed",
  in_progress: "Being fixed",
  resolved: "Resolved",
};
const STATUS_STYLE: Record<string, string> = {
  open: "bg-[#EEF0EC] text-[#5B6470]",
  triaged: "bg-[#FFF1D6] text-[#9A6400]",
  in_progress: "bg-[#FFF1D6] text-[#9A6400]",
  resolved: "bg-[#E2F4F1] text-[#0C8175]",
};

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function NotificationsBell({
  userId,
  issues,
  initialUnread,
}: {
  userId: string;
  issues: IssueNotification[];
  initialUnread: number;
}) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      setUnread(0);
      // Best-effort watermark advance — a pre-0055 deploy (missing column)
      // must not surface an error; the badge just reappears next load.
      try {
        await createClient()
          .from("profiles")
          .update({ notifications_seen_at: new Date().toISOString() })
          .eq("id", userId);
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => void toggle()}
        className="relative h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-[#EEF0EC] text-base"
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        title="Your reported issues"
      >
        🔔
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-[#B42318] text-white text-[10px] leading-[1.1rem] text-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-80 max-h-96 overflow-y-auto card p-3 shadow-lg">
          <p className="text-xs font-medium text-[#5B6470] mb-2">Your reported issues</p>
          {issues.length === 0 ? (
            <p className="text-sm text-[#5B6470]">
              Nothing here yet — when you report a problem, its progress shows up right here until
              it&apos;s resolved.
            </p>
          ) : (
            <ul className="space-y-2">
              {issues.map((i) => (
                <li key={i.id} className="border-t first:border-t-0 border-[#EEF0EC] pt-2 first:pt-0">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm text-[#14181F] leading-5">{i.title}</span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 ${STATUS_STYLE[i.status] ?? "bg-[#EEF0EC] text-[#5B6470]"}`}
                    >
                      {STATUS_LABEL[i.status] ?? i.status}
                    </span>
                  </div>
                  {i.status === "resolved" && i.resolution_note && (
                    <p className="text-xs text-[#0C8175] mt-0.5">✓ {i.resolution_note}</p>
                  )}
                  <p className="text-[10px] text-[#98A0A9] mt-0.5">
                    {i.category ? `${i.category} · ` : ""}
                    reported {ago(i.created_at)}
                    {i.updated_at !== i.created_at ? ` · updated ${ago(i.updated_at)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
