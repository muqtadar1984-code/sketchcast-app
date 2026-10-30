"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The right column: a count of this chapter's changes (reader edits waiting to apply, notes, audit findings), opened on
// demand; "Apply" turns accepted edits into the chapter's new text; "Approve" approves the text as it reads now.
export type ChangeItem = {
  id: string;
  tone: "edit" | "must" | "should" | "note";
  text: string;
  before?: string | null;
  where?: string | null;
  editId?: number;
  decide?: "rejected" | "resolved";
};
const DOT = { edit: "bg-[#3B6FD8]", must: "bg-[#8E2A21]", should: "bg-[#B8862F]", note: "bg-[#A39C8C]" };

export default function Changes(props: {
  slug: string;
  chapter: number | null;
  rev: string | null;
  items: ChangeItem[];
  toApply: number;
  approved: boolean;
  approvedOn: string | null;
  canApprove: boolean;
  canEdit: boolean;
  bookView: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(props.toApply > 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(url: string, body: Record<string, unknown>, what: string) {
    setBusy(what);
    setError(null);
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ book: props.slug, ...body }) });
    const b = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    if (!r.ok) return setError(b.error ?? `Not done (${r.status}).`);
    router.refresh();
  }

  return (
    <aside className="flex h-full flex-col gap-3 text-sm" aria-label="Changes">
      <button type="button" onClick={() => setOpen((o) => !o)} className="rounded-xl border border-[#E4DCC8] bg-white px-3 py-3 text-center hover:border-[#B8862F]" aria-expanded={open}>
        <span className="block font-display text-3xl leading-none tabular-nums">{props.items.length}</span>
        <span className="mt-1 block text-xs text-[#7A7363]">{props.items.length === 1 ? "change" : "changes"}</span>
        <span className="mt-2 flex flex-wrap justify-center gap-1" aria-hidden="true">
          {props.items.slice(0, 16).map((i) => (
            <span key={i.id} className={`h-2 w-2 rounded-full ${DOT[i.tone]}`} />
          ))}
        </span>
      </button>
      {open && (
        <ul className="space-y-2.5">
          {props.items.length === 0 && <li className="text-xs text-[#7A7363]">Select text in the page to change it.</li>}
          {props.items.map((i) => (
            <li key={i.id} className="flex gap-2 text-xs leading-snug">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[i.tone]}`} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                {i.before && <span className="block text-[#A39C8C] line-through">{i.before}</span>}
                <span className="block">{i.text}</span>
                {i.where && <span className="block text-[#A39C8C]">{i.where}</span>}
              </span>
              {i.editId && i.decide && props.canEdit && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => call("/api/pub/edits", { action: "decide", id: i.editId, to: i.decide }, `d${i.editId}`)}
                  className="h-5 shrink-0 px-1 text-[#A39C8C] hover:text-[#8E2A21]"
                  aria-label={i.decide === "rejected" ? "Remove this change" : "Mark this note done"}
                  title={i.decide === "rejected" ? "Remove" : "Done"}
                >
                  {i.decide === "rejected" ? "✕" : "✓"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto space-y-2">
        {!props.bookView && props.toApply > 0 && props.canEdit && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => confirm(`Apply ${props.toApply} change(s)? The chapter gets new text and needs approving again.`) && call("/api/pub/edits", { action: "apply", chapter: props.chapter }, "apply")}
            className="w-full rounded-lg border border-[#3B6FD8] px-3 py-2 text-sm text-[#3B6FD8] disabled:opacity-50"
          >
            {busy === "apply" ? "Applying…" : `Apply ${props.toApply}`}
          </button>
        )}
        {props.bookView ? null : props.approved ? (
          <p className="rounded-lg bg-[#E3EEE5] px-3 py-2 text-center text-xs text-[#24543A]">Approved{props.approvedOn ? ` ${props.approvedOn}` : ""}</p>
        ) : props.canApprove && props.chapter && props.toApply === 0 ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => confirm(`Approve chapter ${props.chapter} exactly as it reads now?`) && call("/api/pub/approvals", { chapter: props.chapter, rev: props.rev }, "approve")}
            className="w-full rounded-lg bg-[#3B6FD8] px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
        ) : null}
        {error && <p className="text-xs text-[#8E2A21]">{error}</p>}
      </div>
    </aside>
  );
}
