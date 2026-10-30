"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import BookTabs from "./book-tabs";

// The book's workbench (/books/[slug]) runs full width with no tabs; the Records pages (owner only) keep the
// header and the tab bar, with a way back to the workbench.
export default function BookChrome({ slug, title, current, children }: { slug: string; title: string; current: string | null; children: React.ReactNode }) {
  const path = usePathname();
  if (path === `/books/${slug}`) return <div className="mx-auto max-w-[96rem] px-3 sm:px-5 py-4">{children}</div>;
  return (
    <div>
      <div className="border-b border-[#E4DCC8] bg-[#F4EEDF]">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 pt-5">
          <Link href={`/books/${slug}`} className="text-xs text-[#7A7363] hover:text-[#1F2A24]">
            ← Workbench
          </Link>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mt-1 mb-4">
            <h1 className="font-display text-2xl leading-tight">{title} · records</h1>
            {current && <span className="text-sm text-[#5F5A4E]">Current: {current}</span>}
          </div>
          <BookTabs slug={slug} />
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6">{children}</div>
    </div>
  );
}
