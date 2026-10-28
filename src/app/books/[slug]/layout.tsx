import Link from "next/link";
import { loadBook } from "./load";
import BookTabs from "./book-tabs";

export default async function BookLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { work, revisions } = await loadBook(slug);
  const current = revisions.find((r) => r.key === work.current_revision);
  return (
    <div>
      <div className="border-b border-[#E4DCC8] bg-[#F4EEDF]">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 pt-5">
          <Link href="/books" className="text-xs text-[#7A7363] hover:text-[#1F2A24]">
            ← All books
          </Link>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mt-1 mb-4">
            <h1 className="font-display text-2xl leading-tight">{work.title}</h1>
            {current && <span className="text-sm text-[#5F5A4E]">Current: {current.label}</span>}
          </div>
          <BookTabs slug={slug} />
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6">{children}</div>
    </div>
  );
}
