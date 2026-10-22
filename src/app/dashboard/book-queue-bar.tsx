"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";

// The teacher's own queue on one book (surge plan D3, 2026-10-22): after a
// big Generate all, ~250 chips sat "queued" for two hours and the only way to
// stop them was staff SQL. Pause holds this teacher's work on this book (never
// another teacher's on a shared school book); Cancel queued removes what has
// not started and returns its credits — the ✕, in bulk. Builds already running
// finish. Both are RPCs that act only on auth.uid()'s rows (migration 0153).

type Msgs = Dictionary["library"]["queueBar"];

export default function BookQueueBar({
  bookId,
  state,
  t,
}: {
  bookId: string;
  state: { queued: number; processing: number; paused: boolean };
  t: Msgs;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function togglePause() {
    setBusy(true);
    setNote(null);
    const { error } = await createClient().rpc("pause_my_book", { p_book: bookId, p_paused: !state.paused });
    setBusy(false);
    if (error) setNote(t.failed);
    router.refresh();
  }

  async function cancelQueued() {
    if (!window.confirm(fmt(t.confirmCancel, { n: state.queued }))) return;
    setBusy(true);
    setNote(null);
    const { data, error } = await createClient().rpc("cancel_my_queued", { p_book: bookId });
    setBusy(false);
    if (error) setNote(t.failed);
    else setNote(fmt(t.cancelled, { n: (data as { cancelled?: number } | null)?.cancelled ?? 0 }));
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2 py-1.5 text-[13px] text-[#5B6470]">
      <span className="tabular-nums">
        {state.paused ? t.paused : fmt(t.summary, { queued: state.queued, building: state.processing })}
      </span>
      <button type="button" onClick={togglePause} disabled={busy} className="btn-ghost h-7 px-2.5 text-[13px]">
        {state.paused ? t.resume : t.pause}
      </button>
      {state.queued > 0 && (
        <button type="button" onClick={cancelQueued} disabled={busy} className="btn-ghost h-7 px-2.5 text-[13px] text-[#B3401F]">
          {t.cancel}
        </button>
      )}
      {note && <span>{note}</span>}
    </div>
  );
}
