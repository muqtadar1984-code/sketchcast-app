"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Approve a compiled book at Gate E: exactly this PDF (its hash), which can never be changed afterwards.
export default function ApproveGateE({ slug, run, sha, pages }: { slug: string; run: number; sha: string; pages: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/pub/gate-e", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ book: slug, run, note }) });
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(body.error ?? `Not approved (${r.status}).`);
    setConfirming(false);
    router.refresh();
  }

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="rounded-md bg-[#24543A] px-3 py-1.5 text-sm text-white">
        Approve Gate E…
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-[#BCD5C2] bg-[#F3F8F4] p-3 text-xs">
      <p>
        You are approving this compiled book exactly as built ({pages} pages, PDF hash <span className="font-mono">{sha.slice(0, 12)}…</span>). A later change to
        any chapter needs a new compile and a new Gate E. An approval cannot be edited or removed.
      </p>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note (optional): what you checked" className="w-full rounded-md border border-[#E4DCC8] px-2 py-1 text-sm" />
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={approve} className="rounded-md bg-[#24543A] px-3 py-1 text-white disabled:opacity-40">
          {busy ? "Approving…" : "Approve"}
        </button>
        <button type="button" onClick={() => setConfirming(false)} className="text-[#7A7363]">
          Cancel
        </button>
        {error && <span className="text-[#8E2A21]">{error}</span>}
      </div>
    </div>
  );
}
