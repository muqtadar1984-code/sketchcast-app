"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The right column: how many changes and findings this chapter has (a count, opened on demand), and the approval.
export type ChangeItem = { id: string; tone: "must" | "should" | "note"; text: string; where?: string | null };
const DOT = { must: "bg-[#8E2A21]", should: "bg-[#B8862F]", note: "bg-[#A39C8C]" };

export default function Changes(props: {
  slug: string;
  chapter: number | null;
  rev: string | null;
  items: ChangeItem[];
  approved: boolean;
  approvedOn: string | null;
  canApprove: boolean;
  bookView: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    if (!props.chapter || !props.rev) return;
    if (!confirm(`Approve chapter ${props.chapter} exactly as it reads now?`)) return;
    setBusy(true);
    setError(null);
    const r = await fetch("/api/pub/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ book: props.slug, chapter: props.chapter, rev: props.rev }) });
    const b = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(b.error ?? `Not approved (${r.status}).`);
    router.refresh();
  }

  return (
    <aside className="flex h-full flex-col gap-3 text-sm" aria-label="Changes">
      <button type="button" onClick={() => setOpen((o) => !o)} className="rounded-xl border border-[#E4DCC8] bg-white px-3 py-3 text-center hover:border-[#B8862F]" aria-expanded={open}>
        <span className="block font-display text-3xl leading-none tabular-nums">{props.items.length}</span>
        <span className="mt-1 block text-xs text-[#7A7363]">{props.items.length === 1 ? "change" : "changes"}</span>
        <span className="mt-2 flex justify-center gap-1" aria-hidden="true">
          {props.items.slice(0, 12).map((i) => (
            <span key={i.id} className={`h-2 w-2 rounded-full ${DOT[i.tone]}`} />
          ))}
        </span>
      </button>
      {open && (
        <ul className="space-y-2">
          {props.items.length === 0 && <li className="text-xs text-[#7A7363]">Nothing to review.</li>}
          {props.items.map((i) => (
            <li key={i.id} className="flex gap-2 text-xs leading-snug">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[i.tone]}`} aria-hidden="true" />
              <span>
                {i.text}
                {i.where && <span className="block text-[#A39C8C]">{i.where}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto">
        {props.bookView ? null : props.approved ? (
          <p className="rounded-lg bg-[#E3EEE5] px-3 py-2 text-center text-xs text-[#24543A]">Approved{props.approvedOn ? ` ${props.approvedOn}` : ""}</p>
        ) : props.canApprove && props.chapter ? (
          <button type="button" disabled={busy} onClick={approve} className="w-full rounded-lg bg-[#3B6FD8] px-3 py-2 text-sm text-white disabled:opacity-50">
            {busy ? "Approving…" : "Approve"}
          </button>
        ) : null}
        {error && <p className="mt-1 text-xs text-[#8E2A21]">{error}</p>}
      </div>
    </aside>
  );
}
