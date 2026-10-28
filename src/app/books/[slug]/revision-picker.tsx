import Link from "next/link";
import type { BookRevision } from "@/utils/books/types";

/** Links to the same page at each book revision (server-rendered, no client state). */
export default function RevisionPicker({ revisions, active, hrefFor }: { revisions: BookRevision[]; active: string; hrefFor: (key: string) => string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="navigation" aria-label="Book revision">
      {revisions.map((r) => (
        <Link
          key={r.key}
          href={hrefFor(r.key)}
          aria-current={r.key === active ? "page" : undefined}
          className={
            "rounded-full border px-3 py-1 text-xs " +
            (r.key === active ? "border-[#B8862F] bg-[#B8862F] text-white" : "border-[#E4DCC8] bg-white text-[#5F5A4E] hover:border-[#C9A96B]")
          }
        >
          {r.label}
        </Link>
      ))}
    </div>
  );
}
