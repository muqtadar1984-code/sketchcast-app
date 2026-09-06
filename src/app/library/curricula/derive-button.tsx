"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Enqueue a topic_derive job for one curriculum — POST /api/library/derive,
// then router.refresh() so the row shows the queued job. Disabled while a
// derive is already queued or processing (the route refuses that with 409
// too), and while 0113 (jobs.params) is not applied.

export default function DeriveButton({ curriculumId, live, disabled = false }: { curriculumId: string; live: boolean; disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function derive() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/library/derive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ curriculumId }),
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
        onClick={derive}
        disabled={busy || live || disabled}
        className="btn-primary h-8 px-3 text-xs whitespace-nowrap"
        title={
          disabled
            ? "Apply migration 0113 first"
            : live
              ? "A derive is already running for this curriculum"
              : "Ask the model to propose one topic per group of objectives; the proposals land in Candidates"
        }
      >
        {busy ? "…" : live ? "Deriving…" : "Derive topics"}
      </button>
      {error && <span className="text-xs text-red-600 max-w-xs text-right">{error}</span>}
    </span>
  );
}
