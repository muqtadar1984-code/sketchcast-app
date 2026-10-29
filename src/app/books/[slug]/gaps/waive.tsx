"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Waive one failing readiness check for this book (a reason is required and kept with who waived it), or revoke a
// waiver. The next Readiness re-check or Gate R honours it (pub_readiness_waivers, migration 0168).
async function post(body: Record<string, unknown>): Promise<string | null> {
  const r = await fetch("/api/pub/waivers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const b = (await r.json().catch(() => ({}))) as { error?: string };
  return r.ok ? null : (b.error ?? `Not saved (${r.status}).`);
}

export function WaiveCheck(props: { slug: string; topicId: string; topicTitle: string; check: string; language: string | null; subStatus: string | null; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function waive() {
    setBusy(true);
    setError(null);
    const e = await post({ book: props.slug, action: "waive", topic_id: props.topicId, topic_title: props.topicTitle, check: props.check, language: props.language, sub_status: props.subStatus, reason });
    setBusy(false);
    if (e) return setError(e);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button type="button" title={props.label} onClick={() => setOpen(true)} className="rounded-md border border-[#D8D3C6] bg-white px-2 py-0.5 text-xs text-[#5F5A4E] hover:border-[#B8862F]">
        Waive {props.check}
        {props.language ? `/${props.language}` : ""} for this book…
      </button>
    );
  }
  return (
    <div className="mt-1 w-full space-y-1.5 rounded-md border border-[#EDCB9C] bg-[#FFFBF3] p-2">
      <p className="text-xs text-[#5F5A4E]">
        Waive <span className="font-medium">{props.label}</span> for this book only. The check still runs; the next Readiness re-check or Gate R records it as a
        warning with your name and reason instead of a gap.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="Why this should not block the book (required, kept with the waiver)"
        className="w-full rounded-md border border-[#E4DCC8] px-2 py-1 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || reason.trim().length < 10} onClick={waive} className="rounded-md bg-[#8A4B10] px-3 py-1 text-xs text-white disabled:opacity-40">
          Waive
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-[#7A7363]">
          Cancel
        </button>
        {error && <span className="text-xs text-[#8E2A21]">{error}</span>}
      </div>
    </div>
  );
}

export function RevokeWaiver({ slug, id }: { slug: string; id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function revoke() {
    if (!confirm("Revoke this waiver? The next Readiness re-check or Gate R will count the check again.")) return;
    setBusy(true);
    const e = await post({ book: slug, action: "revoke", id });
    setBusy(false);
    if (e) return setError(e);
    router.refresh();
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled={busy} onClick={revoke} className="text-xs text-[#8E2A21] underline disabled:opacity-40">
        Revoke
      </button>
      {error && <span className="text-xs text-[#8E2A21]">{error}</span>}
    </span>
  );
}
