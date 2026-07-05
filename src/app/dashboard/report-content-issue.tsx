"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// "Report an issue" for ONE lesson/paper: short form → files the issue →
// live status while the diagnosis agent works (Diagnosing… → found it →
// fixed / honest escalation). Rendered only when
// NEXT_PUBLIC_FEATURE_SUPPORT_AGENT is on; the API is the real gate.

const OPTIONS = [
  { value: "wrong_chapter", label: "Wrong chapter / different topic" },
  { value: "poor_quality", label: "Poor quality" },
  { value: "missing_parts", label: "Missing parts" },
  { value: "other", label: "Something else" },
];

type Status = {
  status: string;
  action: string | null;
  message: string | null;
  resolution: string | null;
};

export default function ReportContentIssue({ generationId }: { generationId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("wrong_chapter");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issueId, setIssueId] = useState<string | null>(null);
  const [live, setLive] = useState<Status | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const enabled = process.env.NEXT_PUBLIC_FEATURE_SUPPORT_AGENT === "true";

  useEffect(() => {
    if (!issueId) return;
    const poll = async () => {
      const res = await fetch(`/api/support?id=${issueId}`);
      if (!res.ok) return;
      const s = (await res.json()) as Status;
      setLive(s);
      const settled = s.status === "resolved" || s.status === "triaged" || !!s.action;
      if (settled && timer.current) {
        clearInterval(timer.current);
        timer.current = null;
        router.refresh(); // a regenerated item may have appeared
      }
    };
    poll();
    timer.current = setInterval(poll, 5000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [issueId, router]);

  if (!enabled) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/support", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationId, category, detail: detail.trim() || null }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Could not send the report.");
      return;
    }
    setIssueId(json.id);
  }

  const statusLine = (): { text: string; tone: string } => {
    if (!live || live.status === "open") return { text: "Report received — starting diagnosis…", tone: "text-[#5B6470]" };
    if (live.status === "in_progress" && !live.action)
      return { text: "Diagnosing…", tone: "text-[#9A6400]" };
    if (live.action === "regenerated")
      return { text: live.resolution ?? "Fixed — the correct chapter was regenerated.", tone: "text-[#0C8175]" };
    if (live.action === "regenerated_pending")
      return { text: live.resolution ?? "Corrected version generated — review it and re-assign.", tone: "text-[#0C8175]" };
    if (live.action === "self_heal_retry")
      return { text: live.resolution ?? "Retrying automatically.", tone: "text-[#0C8175]" };
    if (live.action === "user_fix")
      return { text: live.message ?? live.resolution ?? "See the suggestion below.", tone: "text-[#9A6400]" };
    return { text: live.message ?? "Flagged to the SketchCast team — you'll hear back.", tone: "text-[#5B6470]" };
  };

  return (
    <span className="inline-block">
      {!open && !issueId && (
        <button onClick={() => setOpen(true)} className="text-xs text-[#98A0A9] hover:text-[#B3401F]">
          Report an issue
        </button>
      )}

      {open && !issueId && (
        <form onSubmit={submit} className="card p-3 mt-1 w-72 shadow-lg text-left">
          <p className="text-xs font-medium mb-2">What&apos;s wrong with this item?</p>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="field h-8 px-2 text-xs w-full mb-2">
            {OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Anything that helps (optional)"
            className="field px-2 py-1.5 text-xs w-full mb-2"
          />
          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-8 px-2 text-xs">
              Cancel
            </button>
            <button type="submit" disabled={busy} className="btn-primary h-8 px-3 text-xs">
              {busy ? "Sending…" : "Diagnose it"}
            </button>
          </div>
        </form>
      )}

      {issueId && (
        <span className={`text-xs ${statusLine().tone}`}>
          {(!live || (live.status === "in_progress" && !live.action)) && (
            <span className="inline-block w-2 h-2 rounded-full bg-[#FFB020] animate-pulse mr-1.5 align-middle" />
          )}
          {statusLine().text}
        </span>
      )}
    </span>
  );
}
