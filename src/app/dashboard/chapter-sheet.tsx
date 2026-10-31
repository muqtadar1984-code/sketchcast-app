"use client";

import { useRef, useState, type ReactNode } from "react";
import { useSkReveal } from "@/sk/walkthrough/use-reveal";

// One chapter of an open book. On a desktop, and on every phone that has no
// teacher tab bar, it renders exactly as before: the chapter's title line,
// then its controls (`children`: ChapterGenerate and the part cards) inline.
//
// On a teacher's phone (the `tabbar:` variant, 2026-10-31) a chapter is ONE
// row — number, title, one status, a chevron — and a tap opens its controls
// in a bottom sheet. `children` render once, in one place, either way: the
// same components and the same data-tour marks, only the box around them
// changes. The sheet answers the SK tour too (useSkReveal): a stop whose
// control is in a closed chapter opens that chapter, and closes it after.
export default function ChapterSheet({
  num,
  title,
  status,
  tone,
  closeLabel,
  children,
}: {
  /** 1-based, as the chapter list prints it. */
  num: number;
  title: string;
  /** The chapter's state in a word or two ("Done · Parts 1–3"). */
  status: string;
  tone: "ready" | "busy" | "none";
  closeLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const mine = useSkReveal(box, open, setOpen);
  const close = () => {
    mine();
    setOpen(false);
  };
  const headId = `chapter-sheet-${num}`;
  return (
    <>
      <span className="text-sm text-[#14181F] block truncate tabbar:max-md:hidden">
        <span className="text-[#98A0A9]">{num}.</span> {title}
      </span>
      <button
        type="button"
        onClick={() => {
          mine();
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="hidden tabbar:max-md:flex w-full min-h-14 items-center gap-3 text-start"
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-[13px] ${
            tone === "ready" ? "bg-[#E2F4F1] text-[#0C8175]" : tone === "busy" ? "border-2 border-[#1FB8A6] text-[#0C8175]" : "border border-dashed border-[#C3D0CB] text-[#98A0A9]"
          }`}
        >
          {num}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-[#14181F]">{title}</span>
          <span className={`block truncate text-xs ${tone === "ready" ? "text-[#0C8175]" : "text-[#5B6470]"}`}>{status}</span>
        </span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#98A0A9" strokeWidth="2" strokeLinecap="round" className="rtl-flip shrink-0" aria-hidden>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>

      {open && <div aria-hidden className="hidden tabbar:max-md:block fixed inset-0 z-[44] bg-[#14181F]/40" onClick={close} />}
      <div
        ref={box}
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-labelledby={open ? headId : undefined}
        onKeyDown={(e) => {
          if (open && e.key === "Escape") close();
        }}
        className={
          open
            ? "tabbar:max-md:fixed tabbar:max-md:inset-x-0 tabbar:max-md:bottom-0 tabbar:max-md:z-[45] tabbar:max-md:max-h-[85dvh] tabbar:max-md:overflow-y-auto tabbar:max-md:overscroll-contain tabbar:max-md:rounded-t-2xl tabbar:max-md:bg-white tabbar:max-md:px-4 tabbar:max-md:pb-[max(1.5rem,env(safe-area-inset-bottom))] tabbar:max-md:shadow-[0_-12px_40px_-12px_rgba(20,24,31,0.35)]"
            : "tabbar:max-md:hidden"
        }
      >
        <div className="hidden tabbar:max-md:block pt-2">
          <span aria-hidden className="mx-auto mb-2 block h-1.5 w-10 rounded-full bg-[#D5D9D2]" />
          <div className="flex items-start gap-3 pb-2">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[11px] uppercase tracking-wider text-[#0C8175]">{num}</p>
              <p id={headId} className="font-display text-xl leading-tight text-[#14181F]">
                {title}
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label={closeLabel}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#F5F6F3] text-[#14181F]"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </div>
        </div>
        {children}
      </div>
    </>
  );
}
