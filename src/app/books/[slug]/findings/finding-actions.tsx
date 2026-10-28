"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Rule on one finding: accept, reject (a reason is required), defer, or reopen. The ruling and its reason are kept,
// append-only, with who made it and when (pub_finding_decisions).
const ACTIONS: { to: string; label: string; tone: string }[] = [
  { to: "accepted", label: "Accept", tone: "border-[#BCD5C2] text-[#24543A]" },
  { to: "rejected", label: "Reject…", tone: "border-[#E2BAB5] text-[#8E2A21]" },
  { to: "deferred", label: "Defer", tone: "border-[#D8D3C6] text-[#5F5A4E]" },
  { to: "open", label: "Reopen", tone: "border-[#EDCB9C] text-[#8A4B10]" },
];

export default function FindingActions({ slug, id, status }: { slug: string; id: number; status: string }) {
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rule(to: string) {
    if (to === "rejected" && !rejecting) {
      setRejecting(true);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/pub/findings/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: slug, to, reason }),
    });
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(body.error ?? `Not saved (${r.status}).`);
    setRejecting(false);
    setReason("");
    router.refresh();
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {ACTIONS.filter((a) => a.to !== status && !(a.to === "open" && status === "open")).map((a) => (
          <button key={a.to} type="button" disabled={busy} onClick={() => rule(a.to)} className={`rounded-md border bg-white px-2.5 py-0.5 text-xs disabled:opacity-40 ${a.tone}`}>
            {a.label}
          </button>
        ))}
        {error && <span className="text-xs text-[#8E2A21]">{error}</span>}
      </div>
      {rejecting && (
        <div className="flex flex-wrap items-start gap-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why is this finding wrong? (required, kept with the ruling)"
            className="min-w-0 flex-1 rounded-md border border-[#E4DCC8] px-2 py-1 text-sm"
          />
          <button type="button" disabled={busy || !reason.trim()} onClick={() => rule("rejected")} className="rounded-md bg-[#8E2A21] px-3 py-1 text-xs text-white disabled:opacity-40">
            Reject
          </button>
          <button type="button" onClick={() => setRejecting(false)} className="text-xs text-[#7A7363]">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
