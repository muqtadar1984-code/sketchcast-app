"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Takedown / restore one book or generation via /api/console/ops.
export default function TakedownButton({
  targetId,
  targetKind,
  removed,
}: {
  targetId: string;
  targetKind: "book" | "generation";
  removed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (!removed && !window.confirm(`Take down this ${targetKind}? It disappears for everyone (recoverable).`)) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/console/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: removed ? "restore" : "takedown", targetId, targetKind }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Failed.");
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        onClick={toggle}
        disabled={busy}
        className={`h-8 px-3 text-xs rounded-lg font-medium ${
          removed ? "bg-[#E2F4F1] text-[#0C8175] hover:bg-[#D2EEE9]" : "bg-[#FFE9E3] text-[#B3401F] hover:bg-[#FFDCD2]"
        }`}
      >
        {busy ? "…" : removed ? "Restore" : "Take down"}
      </button>
    </span>
  );
}
