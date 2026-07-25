"use client";

import { useState } from "react";

// "report" on a FAILED kit item: one click sends the failure to SketchCast staff
// by email — no form, no triage questions. Founder (2026-07-21): "just send a
// failed report with book, user and part details on email so staff can take a
// look."
//
// Reuses /api/issues rather than a new mail path: it already files the issue,
// attaches the caller's recent job errors, emails the team via Resend with a
// console triage link, and rate-limits per user. The reporter's identity comes
// from the session server-side, so nothing about who they are is trusted from
// the browser.
export default function ReportFailure({
  generationId,
  kind,
  label,
  bookId,
  bookTitle = null,
  chapterNum,
  part = null,
}: {
  generationId: string;
  kind: string;
  /** Display name of the failed item ("Worksheet", "Test paper"…). */
  label: string;
  bookId: string;
  bookTitle?: string | null;
  chapterNum: number;
  part?: number | null;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function send() {
    setState("sending");
    const item = label || kind;
    const where = [bookTitle || `Book ${bookId}`, `Chapter ${chapterNum + 1}`, part ? `Part ${part}` : null]
      .filter(Boolean)
      .join(" · ");
    try {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The API's own categories — a failed video vs a failed document.
          category: kind === "presentation" ? "video" : "deck_docs",
          title: `${item} failed — ${where}`.slice(0, 200),
          description: [
            `Generation FAILED — reported from the Library.`,
            `Item: ${item} (kind: ${kind})`,
            `Book: ${bookTitle ?? "—"} (${bookId})`,
            `Chapter: ${chapterNum + 1}`,
            part ? `Part: ${part}` : null,
            `Generation id: ${generationId}`,
          ]
            .filter(Boolean)
            .join("\n"),
          url: typeof window === "undefined" ? "" : window.location.href,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        setMessage(json.error ?? "Couldn't send the report.");
        return;
      }
      setState("sent");
    } catch {
      setState("error");
      setMessage("Network error — try again.");
    }
  }

  if (state === "sent") {
    return (
      <span className="text-[13px] text-[#0C8175]" title="Sent to the SketchCast team">
        reported
      </span>
    );
  }

  return (
    <>
      <button
        onClick={send}
        disabled={state === "sending"}
        className="text-[13px] text-[#98A0A9] hover:text-[#B3401F] disabled:opacity-60"
        title="Send this failure to the SketchCast team (book, chapter and part are included)"
      >
        {state === "sending" ? "sending…" : "report"}
      </button>
      {state === "error" && <span className="text-[11px] text-red-600">{message}</span>}
    </>
  );
}
