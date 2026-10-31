"use client";

// SK gap tracker — signal E: the 👎 under one of SK's replies (founder
// 2026-10-31). A small icon button, always visible (never hover-only: a
// hover-revealed control does not exist on touch). It opens a tiny optional
// "What did you want?" box with Send; after Send, a short "Thanks". The
// Shell owns the state per reply (it survives the conversation sheet closing)
// and does the POST to /api/sk/gap-feedback.

import { useState } from "react";
import { GAP_NOTE_MAX } from "@/sk/gaps/feedback";

export type GapThumbState = "idle" | "open" | "sending" | "sent" | "failed";

export type GapThumbCopy = { thumb: string; ask: string; placeholder: string; send: string; thanks: string; failed: string };

export function SkGapThumbIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5h7.2a1.6 1.6 0 0 1 1.57 1.3l1.1 5.6A1.6 1.6 0 0 1 14.3 12.3H11l.6 3a1.5 1.5 0 0 1-2.75 1.07L6 11.5" />
      <path d="M3.5 3.5H6v8H3.5z" />
    </svg>
  );
}

export function SkGapThumb({
  state,
  copy,
  onOpen,
  onSend,
}: {
  state: GapThumbState;
  copy: GapThumbCopy;
  onOpen: () => void;
  onSend: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  if (state === "sent") {
    return (
      <p className="text-[11px] text-slate-500 mt-1 ms-1" role="status" data-sk="gap-thanks">
        {copy.thanks}
      </p>
    );
  }
  if (state === "idle") {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={copy.thumb}
        title={copy.thumb}
        className="mt-1 ms-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0C8175]"
        data-sk="gap-thumb"
      >
        <SkGapThumbIcon />
      </button>
    );
  }
  const sending = state === "sending";
  return (
    <form
      className="mt-1 ms-1 w-full max-w-[85%] rounded-xl border border-[#E6E8E4] bg-white p-2"
      data-sk="gap-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sending) onSend(note.trim());
      }}
    >
      <label className="block text-[11px] font-medium text-slate-600 mb-1">
        {copy.ask}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, GAP_NOTE_MAX))}
          maxLength={GAP_NOTE_MAX}
          rows={2}
          autoFocus
          placeholder={copy.placeholder}
          dir="auto"
          className="mt-1 block w-full resize-none rounded-lg border border-[#E6E8E4] px-2 py-1 text-xs font-normal text-slate-900 focus:outline-none focus:ring-1 focus:ring-[#0C8175]"
          data-sk="gap-note"
        />
      </label>
      <div className="mt-1 flex items-center gap-2">
        <button type="submit" disabled={sending} className="btn-primary h-7 px-3 text-xs text-white disabled:opacity-60" data-sk="gap-send">
          {copy.send}
        </button>
        {state === "failed" && (
          <span className="text-[11px] text-[#B42318]" role="alert">
            {copy.failed}
          </span>
        )}
      </div>
    </form>
  );
}
