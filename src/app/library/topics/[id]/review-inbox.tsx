"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { TopicKit } from "@/utils/catalogue/types";
import { KitReviewBox, useKitPost } from "./kit-panel";
import { TranslationReviewBox } from "./translations-panel";

// The review inbox's interactive bits (layout D, 2026-10-17). The page
// (page.tsx, a Server Component) lays the two panes out and renders the
// queue, the video and the status line itself; these two components hold
// the browser state it cannot: the article drawer's open/closed, and the
// reviewer's verdict box with its busy / error / notice surface.

/** A button that opens a drawer from the right edge with `children` inside —
 *  the article panel, which is long and is read, not scanned. The drawer is
 *  a sheet over the page: Escape or the backdrop closes it; the page's state
 *  (and the panels inside, which keep their own) survives a router.refresh. */
export function Drawer({ label, title, children }: { label: ReactNode; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost h-9 px-3 text-sm inline-flex items-center gap-2" aria-haspopup="dialog" aria-expanded={open}>
        {label}
      </button>
      {open && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="absolute inset-0 bg-[#14181F]/40" />
          <div className="absolute inset-y-0 right-0 w-full max-w-4xl bg-[#FBFCFA] shadow-2xl flex flex-col">
            <div className="flex items-center justify-between gap-3 px-5 h-14 border-b border-[#EEF0EC] bg-white shrink-0">
              <p className="font-medium">{title}</p>
              <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-8 px-3 text-xs">
                Close
              </button>
            </div>
            <div className="overflow-y-auto p-5 grow">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}

/** The reviewer's verdict on the kit under review — the English kit's
 *  Approve video / Reject, or a translation's Approve translation / Reject —
 *  posting the kit route's actions exactly as the folded panels do, with the
 *  same busy / error / notice surface (useKitPost). */
export function ReviewVerdict({
  topicId,
  topicStatus,
  kit,
  translation,
  kitArticleStatus,
  canApprove,
}: {
  topicId: string;
  topicStatus: string;
  kit: TopicKit;
  /** the kit is a translation (reviewed through its own acceptance rules) */
  translation: boolean;
  /** the status of the English kit's article version (null when it is gone) */
  kitArticleStatus: string | null;
  canApprove: boolean;
}) {
  const { post, busy, error, errors, notice, setNotice } = useKitPost(topicId);
  return (
    <div className="space-y-2">
      {translation ? (
        <TranslationReviewBox kit={kit} topicStatus={topicStatus} canApprove={canApprove} post={post} busy={busy} setNotice={setNotice} />
      ) : (
        <KitReviewBox kit={kit} topicStatus={topicStatus} kitArticleStatus={kitArticleStatus} canApprove={canApprove} busy={busy} post={post} setNotice={setNotice} />
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {errors.length > 1 && (
        <ul className="text-xs text-red-600 list-disc pl-5 space-y-0.5">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {notice && <p className="text-sm text-[#0F7A68]">{notice}</p>}
    </div>
  );
}
