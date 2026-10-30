"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { StageAction } from "@/utils/books/workbench";

// The workbench's one step button (direction C): starts a run, or the final approval. Used by the spine and by the
// reader when it shows the next chapter to draft.
export default function ActionButton({ slug, action, allowed, primary = true }: { slug: string; action: StageAction; allowed: boolean; primary?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!allowed || action.kind === "view") return null;
  const label = action.kind === "gate_e" ? "Approve book" : action.label;

  async function go() {
    const cost = action.kind === "run" && action.usd ? ` It costs about $${action.usd.toFixed(2)}.` : " It is free.";
    if (!confirm(`${label}?${cost}`)) return;
    setBusy(true);
    setError(null);
    const r =
      action.kind === "gate_e"
        ? await fetch("/api/pub/gate-e", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ book: slug, run: action.run }) })
        : await fetch("/api/pub/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ book: slug, stage: action.kind === "run" ? action.stage : "", params: action.kind === "run" ? action.params : {} }) });
    const b = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(b.error ?? `Not started (${r.status}).`);
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        disabled={busy}
        onClick={go}
        className={`rounded-md px-2.5 py-1 text-xs disabled:opacity-50 ${primary ? "bg-[#3B6FD8] text-white" : "border border-[#D8D3C6] text-[#5F5A4E] hover:border-[#B8862F]"}`}
      >
        {busy ? "Starting…" : label}
        {action.kind === "run" && action.usd ? ` · $${action.usd.toFixed(2)}` : ""}
      </button>
      {error && <span className="mt-1 max-w-[11rem] text-[11px] leading-snug text-[#8E2A21]">{error}</span>}
    </span>
  );
}
