"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Enqueue a topic_harvest job for one book — POST /api/library/harvest, then
// router.refresh() so the row shows the queued job. Disabled while a harvest
// is already queued or processing (the route refuses that with 409 too).

export default function HarvestButton({ bookId, live }: { bookId: string; live: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function harvest() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/library/harvest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={harvest}
        disabled={busy || live}
        className="btn-primary h-8 px-3 text-xs whitespace-nowrap"
        title={live ? "A harvest is already running for this book" : "Pull this book's topic names into Candidates"}
      >
        {busy ? "…" : live ? "Harvesting…" : "Harvest"}
      </button>
      {error && <span className="text-xs text-red-600 max-w-xs text-right">{error}</span>}
    </span>
  );
}
