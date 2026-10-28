"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Approve the chapter's current text at Gate D. Two clicks: the first shows what is being approved (the text's hash)
// and an optional note; the second records the approval, which can never be changed afterwards.
export default function ApproveGateD({ slug, chapter, rev, sha }: { slug: string; chapter: number; rev: string; sha: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/pub/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: slug, chapter, rev, note }),
    });
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(body.error ?? `Not approved (${r.status}).`);
    setConfirming(false);
    router.refresh();
  }

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="mt-3 w-full rounded-md bg-[#24543A] px-3 py-1.5 text-sm text-white">
        Approve Gate D…
      </button>
    );
  }
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-[#BCD5C2] bg-[#F3F8F4] p-3 text-xs">
      <p>
        You are approving Chapter {chapter} exactly as shown, text hash <span className="font-mono">{sha.slice(0, 12)}…</span>. Any later change to
        it becomes a controlled revision that needs approval again. An approval cannot be edited or removed.
      </p>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note (optional): what you checked, anything waived" className="w-full rounded-md border border-[#E4DCC8] px-2 py-1 text-sm" />
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={approve} className="rounded-md bg-[#24543A] px-3 py-1 text-white disabled:opacity-40">
          {busy ? "Approving…" : "Approve"}
        </button>
        <button type="button" onClick={() => setConfirming(false)} className="text-[#7A7363]">
          Cancel
        </button>
      </div>
      {error && <p className="text-[#8E2A21]">{error}</p>}
    </div>
  );
}
