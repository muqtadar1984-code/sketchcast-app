import Link from "next/link";
import { requireBookMember, roleOn } from "@/utils/books-access";
import { listWorks } from "@/utils/books/store";
import { Chip, Empty } from "./ui";

// /books — every book the member may read, with where it stands.
export default async function BooksHome() {
  const member = await requireBookMember();
  const works = (await listWorks()).filter((w) => roleOn(member, w.uid));
  return (
    <main className="mx-auto max-w-5xl px-4 sm:px-6 py-8">
      <h1 className="font-display text-2xl mb-1">Books</h1>
      <p className="text-sm text-[#7A7363] mb-6">Study-guide books, from scope to print. Read-only in this first release.</p>
      {works.length === 0 ? (
        <Empty>No books yet, or none you have been given access to.</Empty>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {works.map((w) => (
            <li key={w.uid}>
              <Link href={`/books/${w.slug}`} className="block rounded-xl border border-[#E4DCC8] bg-white p-5 hover:border-[#C9A96B] transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-display text-lg leading-snug">{w.title}</h2>
                  <Chip label={w.status} tone={w.status === "compiled" ? "done" : "open"} />
                </div>
                {w.subtitle && <p className="text-sm text-[#5F5A4E] mt-1">{w.subtitle}</p>}
                <p className="text-xs text-[#7A7363] mt-3">
                  {[w.facts.chapters && `${w.facts.chapters} chapters`, w.facts.kdp_pages && `${w.facts.kdp_pages} pp`, w.facts.questions && `${w.facts.questions} questions`]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
