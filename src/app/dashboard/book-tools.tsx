"use client";

import { useEffect, useRef, useState } from "react";
import { type LibraryMessages } from "./labels";

// "Calm the hierarchy" (founder 2026-07-21): a book header used to present up to
// seven same-weight buttons — Generate all, Revision papers, Exam, Generate full
// kit, Generate kit, Assign chapter, Assign — so nothing read as the main path.
// The occasional book-level TOOLS (revision papers, exam papers) now live behind
// one "More" disclosure, leaving a single primary action visible. The tools
// themselves are unchanged; this only decides when they're on screen.
export default function BookTools({ children, t }: { children: React.ReactNode; t: LibraryMessages }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Click-away + Escape, so an open panel never traps the page.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-[#5B6470] hover:text-[#14181F] h-8 px-2.5 rounded-lg hover:bg-[#EEF0EC]"
        title={t.tools.hint}
      >
        {t.tools.more}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute end-0 z-30 mt-1 w-[22rem] max-w-[calc(100vw-3rem)] rounded-xl border border-[#E6E8E4] bg-white p-3 shadow-lg">
          <p className="text-[10px] uppercase tracking-wide text-[#98A0A9] mb-1.5">{t.tools.heading}</p>
          <div className="space-y-1">{children}</div>
        </div>
      )}
    </div>
  );
}
