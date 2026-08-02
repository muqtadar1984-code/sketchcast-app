"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";

// The bell carries TWO feeds, and "unread" means a DIFFERENT thing in each:
//   · ISSUES  — every report the user has made, with its live triage status
//     (the loop-closer for "I reported it, then heard nothing"). Unread means
//     the status MOVED since they last looked: updated_at > notifications_seen_at.
//   · NOTICES — the school's live announcements (school_events, 0068). Unread
//     means NEW since they last looked: created_at > notices_seen_at. A notice
//     is never re-raised because it was edited — it is an announcement, not a
//     ticket, so only its arrival is news.
// Hence TWO watermarks (profiles.notifications_seen_at from 0055,
// profiles.notices_seen_at from 0068), never one: a shared stamp would let
// glancing at a school notice silence a triage update the user never saw.
// The server computes both counts; opening the bell advances both stamps in two
// INDEPENDENT writes, so a pre-0068 deploy (column missing) still clears the
// issue badge exactly as it does today.

export type IssueNotification = {
  id: string;
  title: string;
  category: string | null;
  status: string;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
};

/** A live school notice — school_events rows with a notice audience (0068). */
export type NoticeNotification = {
  id: string;
  title: string;
  audience: string; // 'school' (Everyone) | 'staff' (Staff only)
  importance: string; // normal | important
  starts_at: string | null; // the event clock — null on a pure deadline
  action_by: string | null; // the deadline clock
  action_label: string | null; // "Register by", "Pay by"
  created_at: string;
};

/** One row of the merged feed — two shapes, one clock to sort them by. */
type BellRow =
  | { kind: "issue"; at: string; issue: IssueNotification }
  | { kind: "notice"; at: string; notice: NoticeNotification; cd: string | null };

/** Every word the bell renders, handed down by the (server) header. */
export type BellMessages = Dictionary["nav"]["bell"];

// The DB's status codes are snake_case and never translated — this maps them to
// the dictionary's camelCase keys, so a status we don't recognise falls through
// to the raw code rather than a blank chip.
const STATUS_KEY: Record<string, keyof BellMessages["status"]> = {
  open: "open",
  triaged: "triaged",
  in_progress: "inProgress",
  resolved: "resolved",
};
const STATUS_STYLE: Record<string, string> = {
  open: "bg-[#EEF0EC] text-[#5B6470]",
  triaged: "bg-[#FFF1D6] text-[#9A6400]",
  in_progress: "bg-[#FFF1D6] text-[#9A6400]",
  resolved: "bg-[#E2F4F1] text-[#0C8175]",
};
const AUDIENCE_STYLE: Record<string, string> = {
  school: "bg-[#E8F1FB] text-[#175CD3]",
  staff: "bg-[#EFE9FB] text-[#6941C6]",
};

// The relative clocks are whole messages ("{n}m ago", "in {n} days"), never a
// number glued to a suffix: word order, spacing and the unit itself all move
// between languages.
function ago(iso: string, t: BellMessages): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return fmt(t.minutesAgo, { n: mins });
  const h = Math.round(mins / 60);
  if (h < 48) return fmt(t.hoursAgo, { n: h });
  return fmt(t.daysAgo, { n: Math.round(h / 24) });
}

/** `ago` pointing the other way — how long until a clock runs out. */
function until(iso: string, t: BellMessages): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins <= 0) return t.now;
  if (mins < 60) return fmt(t.inMinutes, { n: mins });
  const h = Math.round(mins / 60);
  if (h < 48) return fmt(t.inHours, { n: h });
  return fmt(t.inDays, { n: Math.round(h / 24) });
}

// The TWO-CLOCK countdown: while the action deadline is still ahead it IS the
// clock ("Register by · in 3 days"); once it passes, the notice falls back to
// its event date ("in 2 days"). Both lapsed — or a pure deadline, which carries
// no event date at all — leaves nothing to count down, so the line disappears
// rather than reading "in 0m" at a reader who is already too late.
function countdown(n: NoticeNotification, t: BellMessages): string | null {
  const now = Date.now();
  // action_label is the poster's OWN words ("Register by") — school data, never
  // translated; only the stand-in when they left it blank comes from the file.
  if (n.action_by && new Date(n.action_by).getTime() > now)
    return `${n.action_label || t.deadlineFallback} · ${until(n.action_by, t)}`;
  if (n.starts_at && new Date(n.starts_at).getTime() > now) return until(n.starts_at, t);
  return null;
}

export default function NotificationsBell({
  userId,
  issues,
  initialUnread,
  notices = [],
  noticesUnread = 0,
  noticesOn = false,
  t,
}: {
  userId: string;
  issues: IssueNotification[];
  /** Issues whose STATUS changed since notifications_seen_at. */
  initialUnread: number;
  notices?: NoticeNotification[];
  /** Notices POSTED since notices_seen_at. */
  noticesUnread?: number;
  /** The notices feature is live for this viewer — gates the second watermark
   * write, so a tenant without it never touches the 0068 column. */
  noticesOn?: boolean;
  /** The bell's words, resolved server-side by the header. */
  t: BellMessages;
}) {
  const [open, setOpen] = useState(false);
  const [issueUnread, setIssueUnread] = useState(initialUnread);
  const [noticeUnread, setNoticeUnread] = useState(noticesUnread);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const unread = issueUnread + noticeUnread;

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
    if (!next) return;
    const supabase = createClient();
    // Two watermarks, two writes — a pre-0068 deploy (missing notices_seen_at)
    // must not take the issue stamp down with it. Both best-effort: a failed
    // write just means the badge reappears on the next load.
    if (issueUnread > 0) {
      setIssueUnread(0);
      try {
        await supabase.from("profiles").update({ notifications_seen_at: new Date().toISOString() }).eq("id", userId);
      } catch {
        /* ignore */
      }
    }
    if (noticesOn && noticeUnread > 0) {
      setNoticeUnread(0);
      try {
        await supabase.from("profiles").update({ notices_seen_at: new Date().toISOString() }).eq("id", userId);
      } catch {
        /* ignore */
      }
    }
  }

  // One time-ordered feed, newest first: an issue sits at its last MOVE, a
  // notice at the moment it was posted — the same instants the two unread rules
  // are measured against.
  const rows: BellRow[] = [
    ...issues.map((i) => ({ kind: "issue" as const, at: i.updated_at, issue: i })),
    ...notices.map((n) => ({ kind: "notice" as const, at: n.created_at, notice: n, cd: countdown(n, t) })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => void toggle()}
        className="relative h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-[#EEF0EC] text-base"
        aria-label={unread ? fmt(t.titleUnread, { count: unread }) : t.title}
        title={noticesOn ? t.tooltipWithNotices : t.tooltipIssuesOnly}
      >
        🔔
        {unread > 0 && (
          <span className="absolute -top-0.5 -end-0.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-[#B42318] text-white text-[10px] leading-[1.1rem] text-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute end-0 top-11 z-50 w-80 max-h-96 overflow-y-auto card p-3 shadow-lg">
          <p className="text-xs font-medium text-[#5B6470] mb-2">
            {noticesOn ? t.headingWithNotices : t.headingIssuesOnly}
          </p>
          {rows.length === 0 ? (
            <p className="text-sm text-[#5B6470]">{noticesOn ? t.emptyWithNotices : t.emptyIssuesOnly}</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((r) =>
                r.kind === "issue" ? (
                  <li key={`i-${r.issue.id}`} className="border-t first:border-t-0 border-[#EEF0EC] pt-2 first:pt-0">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm text-[#14181F] leading-5">{r.issue.title}</span>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 ${STATUS_STYLE[r.issue.status] ?? "bg-[#EEF0EC] text-[#5B6470]"}`}
                      >
                        {STATUS_KEY[r.issue.status] ? t.status[STATUS_KEY[r.issue.status]] : r.issue.status}
                      </span>
                    </div>
                    {r.issue.status === "resolved" && r.issue.resolution_note && (
                      <p className="text-xs text-[#0C8175] mt-0.5">✓ {r.issue.resolution_note}</p>
                    )}
                    <p className="text-[10px] text-[#98A0A9] mt-0.5">
                      {r.issue.category ? `${r.issue.category} · ` : ""}
                      {fmt(t.reportedAgo, { ago: ago(r.issue.created_at, t) })}
                      {r.issue.updated_at !== r.issue.created_at
                        ? ` · ${fmt(t.updatedAgo, { ago: ago(r.issue.updated_at, t) })}`
                        : ""}
                    </p>
                  </li>
                ) : (
                  // The notice itself lives on the calendar — the bell is the
                  // nudge, not the record.
                  <li key={`n-${r.notice.id}`} className="border-t first:border-t-0 border-[#EEF0EC] pt-2 first:pt-0">
                    <Link
                      href="/dashboard/calendar"
                      onClick={() => setOpen(false)}
                      className="block rounded hover:bg-[#FAFBF9]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm text-[#14181F] leading-5">
                          <span aria-hidden>📣 </span>
                          {r.notice.title}
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 ${AUDIENCE_STYLE[r.notice.audience] ?? "bg-[#EEF0EC] text-[#5B6470]"}`}
                        >
                          {r.notice.audience === "staff" ? t.audience.staff : t.audience.school}
                        </span>
                      </div>
                      {r.cd && <p className="text-xs text-[#9A6400] mt-0.5">⏳ {r.cd}</p>}
                      <p className="text-[10px] text-[#98A0A9] mt-0.5">
                        {r.notice.importance === "important" ? `${t.important} · ` : ""}
                        {fmt(t.postedAgo, { ago: ago(r.notice.created_at, t) })}
                      </p>
                    </Link>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
