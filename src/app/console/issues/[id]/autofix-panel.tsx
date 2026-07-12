"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type AutofixRun = {
  status: string;
  pr_url: string | null;
  pr_number: number | null;
  ci_passed: boolean | null;
  sensitive: boolean;
  decided_via: string | null;
  created_at: string;
} | null;

const LABEL: Record<string, { text: string; tone: string }> = {
  dispatched: { text: "Fix in progress — writing the code…", tone: "text-[#9A6400]" },
  pr_open: { text: "PR ready — approval email sent to the founder", tone: "text-[#0C8175]" },
  ci_failed: { text: "CI failed — needs a human", tone: "text-[#B42318]" },
  approved: { text: "Approved (merge pending)", tone: "text-[#0C8175]" },
  merged: { text: "Approved & released to production 🚀", tone: "text-[#0C8175]" },
  rejected: { text: "Rejected — PR closed", tone: "text-[#5B6470]" },
  error: { text: "Errored — see the run / logs", tone: "text-[#B42318]" },
};

// Staff control: fire an auto-fix attempt at this issue (a GitHub Action drafts a
// PR; the founder approves the release by email). Only rendered when
// NEXT_PUBLIC_FEATURE_AUTOFIX is on. An in-progress run hides the button.
export default function AutofixPanel({ issueId, run }: { issueId: string; run: AutofixRun }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (process.env.NEXT_PUBLIC_FEATURE_AUTOFIX !== "true") return null;

  const active = run && ["dispatched", "pr_open", "approved"].includes(run.status);
  const canAttempt = !active; // merged/rejected/ci_failed/error/none → can (re)attempt

  async function attempt() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/autofix/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId }),
      });
      const data = (await res.json().catch(() => ({}))) as { note?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not start the auto-fix.");
      } else {
        setMsg(data.note ?? "Auto-fix started.");
        router.refresh();
      }
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  const info = run ? LABEL[run.status] : null;

  return (
    <div className="card p-5 mb-6 border-l-4 border-l-[#1FB8A6]">
      <h2 className="font-display font-medium text-lg mb-1">🔧 Auto-fix</h2>
      <p className="text-sm text-[#5B6470] mb-3">
        Have an AI draft a code fix for this issue on a branch. You approve the release from the
        email — nothing ships to production until you do.
      </p>

      {run && info && (
        <div className="text-sm mb-3 space-y-1">
          <p className={info.tone}>
            {info.text}
            {run.sensitive && <span className="ml-2 chip font-sans bg-[#FCEBEA] text-[#B42318]">⚠️ sensitive diff</span>}
          </p>
          {run.pr_url && (
            <p>
              <a href={run.pr_url} target="_blank" rel="noopener noreferrer" className="text-[#0C8175] hover:underline">
                View pull request{run.pr_number ? ` #${run.pr_number}` : ""} →
              </a>
            </p>
          )}
          {run.decided_via && <p className="text-xs text-[#98A0A9]">decided via {run.decided_via}</p>}
        </div>
      )}

      {canAttempt && (
        <button onClick={attempt} disabled={busy} className="btn-primary h-9 px-4 text-sm">
          {busy ? "Starting…" : run ? "Attempt auto-fix again" : "🔧 Attempt auto-fix"}
        </button>
      )}

      {msg && <p className="text-sm text-[#0C8175] mt-2">{msg}</p>}
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
    </div>
  );
}
