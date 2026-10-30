import Link from "next/link";
import type { Dictionary } from "@/i18n/dictionaries";
import { fmt } from "@/i18n/format";
import type { ChapterEntry } from "@/sk/kit-view";

// The chapter buttons of one book, shared by /sk and /sk/[product] (SK S3
// slice B). A chapter with one kit is one link; a chapter with several kits
// (the Biology book's chapter 8 has three) lists each kit under its chapter,
// each opening the player on that kit.

const link = "inline-flex min-h-10 items-center rounded-lg border border-[#14181F] px-3 py-1.5 text-sm text-[#14181F] hover:bg-[#14181F] hover:text-white";

export default function ChapterLinks({ slug, entries, t }: { slug: string; entries: ChapterEntry[]; t: Dictionary["sk"]["player"] }) {
  return (
    <ul data-tour="sk-books" className="mt-3 flex flex-col gap-2">
      {entries.map((c) => {
        const href = `/sk/${slug}/${encodeURIComponent(c.chapterRef)}`;
        if (c.kits.length <= 1) {
          return (
            <li key={c.chapterRef}>
              <Link href={href} className={link}>
                {fmt(t.chapterN, { n: c.chapterRef })}
                {c.kits[0] ? ` · ${c.kits[0].label || c.kits[0].title}` : ""}
              </Link>
            </li>
          );
        }
        return (
          <li key={c.chapterRef}>
            <div className="text-sm font-medium text-[#14181F]">
              {fmt(t.chapterN, { n: c.chapterRef })} · {fmt(t.lessonsN, { n: c.kits.length })}
            </div>
            <ul className="mt-1 flex flex-wrap gap-2">
              {c.kits.map((k) => (
                <li key={k.generationId}>
                  <Link href={`${href}?kit=${k.generationId}`} className={link}>
                    {k.label || k.title}
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
