import Link from "next/link";
import { requireBookMember } from "@/utils/books-access";
import { LogoMark } from "../dashboard/icons";

// Book app shell (books.sketchcast.app). requireBookMember() bounces everyone
// else to the book-app login, and the whole surface is dark while
// NEXT_PUBLIC_BOOKS_HOST is unset. Layouts do NOT guard route handlers — every
// /api/pub/* route re-checks with isBookMemberRequest() itself.
// Staff-facing chrome stays English, like the console and the Library. A warm
// ink-and-paper band, distinct from the console's navy and the Library's green.
export default async function BooksLayout({ children }: { children: React.ReactNode }) {
  const member = await requireBookMember();
  return (
    <div className="min-h-screen bg-[#FAF6EC] text-[#1F2A24]">
      <header className="border-b border-[#3A3222] bg-[#221D14] text-white">
        <div className="px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <Link href="/books" className="flex items-center gap-2.5 text-lg font-display text-white">
            <LogoMark size={26} />
            Books
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-[#C9BB9C] hidden md:inline">
              {member.email}
              {member.globalRole ? ` · ${member.globalRole}` : ""}
            </span>
            <form action="/auth/signout" method="post">
              <button className="text-[#C9BB9C] hover:text-white">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
