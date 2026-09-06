import Link from "next/link";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";

// Portal overview. Phase 1 (taxonomy): what you can do here as your role, and
// the doors into the taxonomy screens. Later phases replace the cards with the
// live queues (articles awaiting review, kits awaiting review, translations,
// publish failures) and the quota-window indicator.

export const dynamic = "force-dynamic";

export default async function LibraryOverviewPage() {
  const member = await requireLibraryMember();
  const can = (a: Parameters<typeof libraryAllows>[1]) => libraryAllows(member.role, a);

  const doors: { href: string; title: string; body: string; enabled: boolean }[] = [
    {
      href: "/library/topics",
      title: "Topics",
      body: "The canonical topics: one knowledge article, one kit, many curricula.",
      enabled: true,
    },
    {
      href: "/library/curricula",
      title: "Curricula",
      body: "Cambridge and CBSE nodes, and which topics cover them.",
      enabled: true,
    },
    {
      href: "/library/candidates",
      title: "Candidates",
      body: "Topic names harvested from books and syllabi, waiting to be merged or created.",
      enabled: can("curate"),
    },
    {
      href: "/library/harvest",
      title: "Harvest",
      body: "Pick a book on the platform and pull out its topic names. Names only — never its text.",
      enabled: can("curate"),
    },
  ];

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-display mb-1">Library</h1>
      <InkUnderline className="block h-3 w-28 mb-3" color="#7FD8A8" />
      <p className="text-[#5B6470] mb-8">
        Signed in as {member.email} · role <span className="font-medium">{member.role}</span>
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {doors.map((d) =>
          d.enabled ? (
            <Link key={d.href} href={d.href} className="card p-5 hover:shadow-md transition-shadow">
              <p className="font-medium mb-1">{d.title}</p>
              <p className="text-sm text-[#5B6470]">{d.body}</p>
            </Link>
          ) : (
            <div key={d.href} className="card p-5 opacity-60">
              <p className="font-medium mb-1">{d.title}</p>
              <p className="text-sm text-[#5B6470]">{d.body}</p>
              <p className="text-xs text-[#9A6400] mt-2">Editors and admins only.</p>
            </div>
          ),
        )}
      </div>
    </main>
  );
}
