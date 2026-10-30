"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { WorkChapter } from "@/utils/books/workbench";

// The reader's header (direction C): where you are, the chapters in sequence (open the list; each marked by state),
// previous / next, and the whole book with its front matter.
const DOT: Record<WorkChapter["state"], string> = {
  approved: "bg-[#2F8F5B]",
  ready: "bg-[#B8862F]",
  drafting: "bg-[#3B6FD8] animate-pulse",
  not_drafted: "border border-[#C9C2B2]",
};
const STATE: Record<WorkChapter["state"], string> = { approved: "approved", ready: "to approve", drafting: "drafting", not_drafted: "not drafted" };

export default function ChapterBar({ slug, chapters, active, view }: { slug: string; chapters: WorkChapter[]; active: number | null; view: "chapter" | "book" | "front" }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const i = chapters.findIndex((c) => c.chapter === active);
  const cur = i >= 0 ? chapters[i] : undefined;
  const prev = i > 0 ? chapters[i - 1] : undefined;
  const next = i >= 0 && i < chapters.length - 1 ? chapters[i + 1] : undefined;
  const href = (n: number) => `/books/${slug}?ch=${n}`;
  const tab = (on: boolean) => `rounded-md px-2 py-0.5 ${on ? "bg-[#F4EEDF] text-[#1F2A24]" : "hover:text-[#1F2A24]"}`;

  return (
    <div className="flex items-center gap-1 text-xs text-[#7A7363]" ref={box}>
      {view === "chapter" && (
        <Link href={prev ? href(prev.chapter) : "#"} aria-disabled={!prev} aria-label="Previous chapter" className={`px-1 ${prev ? "hover:text-[#1F2A24]" : "pointer-events-none opacity-30"}`}>‹</Link>
      )}
      <div className="relative">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-[#F4EEDF]">
          {view === "chapter" && cur ? (
            <>
              <span className={`h-2 w-2 rounded-full ${DOT[cur.state]}`} aria-hidden="true" />
              Chapter {cur.chapter} of {chapters.length}
            </>
          ) : (
            "Chapters"
          )}
          <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <ol className="absolute left-0 top-7 z-30 max-h-[70vh] w-72 overflow-auto rounded-xl border border-[#E4DCC8] bg-white p-1.5 shadow-lg">
            {chapters.map((c) => (
              <li key={c.chapter}>
                <Link
                  href={href(c.chapter)}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-[#F4EEDF] ${c.chapter === active && view === "chapter" ? "bg-[#F4EEDF]" : ""} ${c.state === "not_drafted" ? "text-[#A39C8C]" : "text-[#1F2A24]"}`}
                  title={STATE[c.state]}
                >
                  <span className="w-5 shrink-0 text-right tabular-nums text-[#A39C8C]">{c.chapter}</span>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[c.state]}`} aria-label={STATE[c.state]} />
                  <span className="truncate">{c.title}</span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
      {view === "chapter" && (
        <Link href={next ? href(next.chapter) : "#"} aria-disabled={!next} aria-label="Next chapter" className={`px-1 ${next ? "hover:text-[#1F2A24]" : "pointer-events-none opacity-30"}`}>›</Link>
      )}
      <span className="mx-1 text-[#E4DCC8]" aria-hidden="true">|</span>
      <Link href={`/books/${slug}?view=book`} className={tab(view === "book")}>Whole book</Link>
      <Link href={`/books/${slug}?view=front`} className={tab(view === "front")}>Front matter</Link>
    </div>
  );
}
