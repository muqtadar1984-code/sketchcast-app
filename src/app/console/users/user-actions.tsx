"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FeedbackButtonState, RemindButtonState } from "@/utils/console-actions";

// Per-row actions on the real-users roster (staff-only, English-only): request
// the in-app feedback questionnaire, and manually send the lifecycle reminder
// email. States are derived SERVER-SIDE (src/utils/console-actions.ts) from the
// page's batched selects — this component only renders them and fires the
// routes, then router.refresh() re-derives from the database.

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

const ACTIVE = "h-6 px-2 text-[11px] rounded-md font-medium bg-[#14181F] text-white hover:bg-[#2A303B] whitespace-nowrap";
const DISABLED = "h-6 px-2 text-[11px] rounded-md font-medium bg-[#EEF0EC] text-[#98A0A9] whitespace-nowrap cursor-default";

export default function UserActions({
  userId,
  feedback,
  remind,
}: {
  userId: string;
  feedback: FeedbackButtonState;
  remind: RemindButtonState;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"feedback" | "remind" | null>(null);
  // Optimistic post-click labels, held until the refreshed server state lands.
  const [sent, setSent] = useState<{ feedback?: boolean; remind?: boolean }>({});
  const [error, setError] = useState<string | null>(null);

  async function call(kind: "feedback" | "remind", url: string) {
    setBusy(kind);
    setError(null);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError((json as { error?: string }).error ?? "Failed.");
      return;
    }
    setSent((s) => ({ ...s, [kind]: true }));
    router.refresh();
  }

  const fbDone = sent.feedback === true;
  const fbActive = !fbDone && (feedback.kind === "request" || feedback.kind === "answered");
  const fbLabel = fbDone
    ? "Requested"
    : feedback.kind === "request"
      ? "Request feedback"
      : feedback.kind === "requested"
        ? "Requested"
        : feedback.kind === "snoozed"
          ? `Snoozed until ${fmtDate(feedback.until)}`
          : "Answered ✓"; // active — a new request is allowed after an answer

  const rmDone = sent.remind === true;
  const rmActive = !rmDone && remind.kind === "ready";
  const rmLabel = rmDone
    ? `Sent ${fmtDate(new Date().toISOString())}`
    : remind.kind === "ready"
      ? remind.segment === "no_upload"
        ? "Remind: upload"
        : "Remind: generate"
      : remind.kind === "cooldown"
        ? `Sent ${fmtDate(remind.sentAt)}`
        : "Opted out";

  return (
    <span className="flex flex-col items-start gap-1 min-w-0">
      {feedback.kind !== "hidden" && (
        <button
          onClick={() => fbActive && call("feedback", "/api/console/feedback-request")}
          disabled={!fbActive || busy !== null}
          className={fbActive ? ACTIVE : DISABLED}
        >
          {busy === "feedback" ? "…" : fbLabel}
        </button>
      )}
      {remind.kind !== "hidden" && (
        <button
          onClick={() => rmActive && call("remind", "/api/console/remind")}
          disabled={!rmActive || busy !== null}
          className={rmActive ? ACTIVE : DISABLED}
        >
          {busy === "remind" ? "…" : rmLabel}
        </button>
      )}
      {error && (
        <span className="text-[10px] text-red-600 max-w-40 truncate" title={error}>
          {error}
        </span>
      )}
    </span>
  );
}
