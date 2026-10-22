"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Staff queue controls (surge plan §4.2–4.4). Each button POSTs to
// /api/console/queue; every action is audited server-side. Cancels only ever
// remove work that never started (refunded like the teacher's ✕); "Stop" also
// asks running builds to abort at their next stage. Chrome is English (staff).

type Action = "cancel" | "stop" | "cancel_duplicates" | "hold" | "release";

const CONFIRM: Record<Action, string> = {
  cancel: "Cancel every QUEUED generation in this scope? Credits are refunded; nothing already building is touched.",
  stop: "Cancel everything queued AND stop every running build in this scope? Running builds abort at their next stage and are refunded.",
  cancel_duplicates: "Cancel queued duplicate kits on this book (keeping the most advanced copy of each)?",
  hold: "Pause this queue? Nothing in scope will start until you resume (auto-expires in 24 h).",
  release: "Resume this queue?",
};

export default function QueueActions({
  ownerId,
  bookId,
  held,
  queued,
  processing,
}: {
  ownerId?: string;
  bookId?: string;
  held: boolean;
  queued: number;
  processing: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(action: Action) {
    if (!window.confirm(CONFIRM[action])) return;
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch("/api/console/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ownerId, bookId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        cancelled?: number;
        refunded?: number;
        stopping?: number;
      };
      if (!res.ok) setMsg(data.error ?? "Failed.");
      else if (action === "hold" || action === "release") setMsg(action === "hold" ? "Paused." : "Resumed.");
      else
        setMsg(
          `Cancelled ${data.cancelled ?? 0} (${data.refunded ?? 0} credits refunded)` +
            (data.stopping ? ` · stopping ${data.stopping}` : ""),
        );
      router.refresh();
    } catch {
      setMsg("Network error.");
    } finally {
      setBusy(null);
    }
  }

  const btn = "chip font-sans normal-case tracking-normal cursor-pointer disabled:opacity-50";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button className={`${btn} bg-[#EEF0EC] text-[#14181F]`} disabled={!!busy} onClick={() => run(held ? "release" : "hold")}>
        {held ? "Resume" : "Pause"}
      </button>
      {queued > 0 && (
        <button className={`${btn} bg-[#FFF1D6] text-[#9A6400]`} disabled={!!busy} onClick={() => run("cancel")}>
          Cancel queued
        </button>
      )}
      {processing > 0 && (
        <button className={`${btn} bg-[#FFE9E3] text-[#B3401F]`} disabled={!!busy} onClick={() => run("stop")}>
          Stop all
        </button>
      )}
      {bookId && !ownerId && (
        <button className={`${btn} bg-[#EEF0EC] text-[#14181F]`} disabled={!!busy} onClick={() => run("cancel_duplicates")}>
          Cancel duplicates
        </button>
      )}
      {busy && <span className="text-xs text-[#5B6470]">Working…</span>}
      {msg && <span className="text-xs text-[#5B6470]">{msg}</span>}
    </span>
  );
}
