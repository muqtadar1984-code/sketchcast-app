"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Withdraw a release (approvers): asks for the reason, which is kept with who withdrew it. Cannot be undone.
export default function WithdrawRelease({ slug, id }: { slug: string; id: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/pub/releases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ book: slug, action: "withdraw", id, reason }) });
    const b = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(b.error ?? `Not withdrawn (${r.status}).`);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-[#8E2A21] underline">
        Withdraw…
      </button>
    );
  }
  return (
    <div className="mt-1 w-full space-y-1.5 rounded-md border border-[#E2BAB5] bg-[#FBF3F2] p-2 text-xs">
      <p>SK will show this release to no new reader. This cannot be undone.</p>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why it is withdrawn (required)" className="w-full rounded-md border border-[#E4DCC8] px-2 py-1 text-sm" />
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy || reason.trim().length < 10} onClick={withdraw} className="rounded-md bg-[#8E2A21] px-3 py-1 text-white disabled:opacity-40">
          Withdraw
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-[#7A7363]">
          Cancel
        </button>
        {error && <span className="text-[#8E2A21]">{error}</span>}
      </div>
    </div>
  );
}
