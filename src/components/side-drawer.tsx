"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A sheet from the right edge of the page, CONTROLLED by its parent (`open`
// / `onClose`): the review inbox's Drawer wraps it with its own button, and
// Library → Fixes opens it on a clicked row or in review mode. Escape or the
// backdrop closes it; the body does not scroll behind it.
//
// Portalled to document.body on purpose: a sticky parent (the inbox's queue
// pane) makes a stacking context, and a sheet rendered inside it would be
// painted through by the page's own sticky bars.

export function SideDrawer({
  open,
  onClose,
  title,
  children,
  wide = true,
  bar,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
  /** a strip under the title (Library → Fixes' review controls) */
  bar?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-[#14181F]/40" />
      <div className={`absolute inset-y-0 right-0 w-full ${wide ? "max-w-4xl" : "max-w-2xl"} bg-[#FBFCFA] shadow-2xl flex flex-col`}>
        <div className="flex items-center justify-between gap-3 px-5 h-14 border-b border-[#EEF0EC] bg-white shrink-0">
          <p className="font-medium truncate">{title}</p>
          <button type="button" onClick={onClose} className="btn-ghost h-8 px-3 text-xs shrink-0">
            Close
          </button>
        </div>
        {bar && <div className="px-5 py-3 border-b border-[#EEF0EC] bg-white shrink-0">{bar}</div>}
        <div className="overflow-y-auto p-5 grow">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
