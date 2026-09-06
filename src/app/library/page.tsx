import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueMissing } from "@/utils/catalogue/status";

// Portal overview: the review queues that exist so far (Phase 2b: articles
// awaiting review, drafts in progress) and the doors into the screens. Every
// screen is readable by every member (the header shows every tab); the doors
// say where a role can only read, matching the read-only note the screen
// itself shows. Later phases add kits awaiting review, translations, publish
// failures and the quota-window indicator.

export const dynamic = "force-dynamic";

export default async function LibraryOverviewPage() {
  const member = await requireLibraryMember();
  const can = (a: Parameters<typeof libraryAllows>[1]) => libraryAllows(member.role, a);
  const admin = createAdminClient();

  // Two head counts, not a scan: the queue numbers stay cheap as the knowledge
  // base grows. A missing 0112 leaves the queues unshown (the screens explain).
  const [inReviewQ, draftQ] = await Promise.all([
    admin.from("topic_articles").select("id", { count: "exact", head: true }).eq("status", "in_review"),
    admin.from("topic_articles").select("id", { count: "exact", head: true }).eq("status", "draft"),
  ]);
  const queuesReady = !inReviewQ.error && !draftQ.error;
  const queuesMissing = catalogueMissing(inReviewQ.error) || catalogueMissing(draftQ.error);
  const awaitingReview = inReviewQ.count ?? 0;
  const drafts = draftQ.count ?? 0;

  const doors: { href: string; title: string; body: string; readOnly: boolean }[] = [
    {
      href: "/library/topics",
      title: "Topics",
      body: "The canonical topics: one knowledge article, one kit, many curricula.",
      readOnly: false,
    },
    {
      href: "/library/curricula",
      title: "Curricula",
      body: "Cambridge and CBSE nodes, and which topics cover them.",
      readOnly: false,
    },
    {
      href: "/library/candidates",
      title: "Candidates",
      body: "Topic names harvested from books and syllabi, waiting to be merged or created.",
      readOnly: !can("curate"),
    },
    {
      href: "/library/harvest",
      title: "Harvest",
      body: "Pick a book on the platform and pull out its topic names. Names only — never its text.",
      readOnly: !can("curate"),
    },
  ];

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-display mb-1">Library</h1>
      <InkUnderline className="block h-3 w-28 mb-3" color="#7FD8A8" />
      <p className="text-[#5B6470] mb-8">
        Signed in as {member.email} · role <span className="font-medium">{member.role}</span>
      </p>

      <h2 className="text-xs font-medium text-[#5B6470] uppercase tracking-wide mb-2">Review queues</h2>
      {queuesReady ? (
        <div className="grid gap-4 sm:grid-cols-2 mb-8">
          <Link href="/library/topics?article=in_review" className="card p-5 hover:shadow-md transition-shadow flex items-center justify-between gap-4">
            <span>
              <span className="font-medium block">Articles awaiting review</span>
              <span className="text-sm text-[#5B6470]">
                Versions submitted for a named reviewer&apos;s approval. {can("approve") ? "You can approve or reject them." : ""}
              </span>
            </span>
            <span className={`text-3xl font-display tabular ${awaitingReview > 0 ? "text-[#5B3FBF]" : "text-[#98A0A9]"}`}>{awaitingReview}</span>
          </Link>
          <Link href="/library/topics?article=draft" className="card p-5 hover:shadow-md transition-shadow flex items-center justify-between gap-4">
            <span>
              <span className="font-medium block">Article drafts</span>
              <span className="text-sm text-[#5B6470]">Written by the worker or by hand, not yet submitted for review.</span>
            </span>
            <span className={`text-3xl font-display tabular ${drafts > 0 ? "text-[#9A6400]" : "text-[#98A0A9]"}`}>{drafts}</span>
          </Link>
        </div>
      ) : (
        <p className="text-sm text-[#9A6400] bg-[#FFF9EE] rounded-lg px-4 py-3 mb-8">
          {queuesMissing
            ? "The review queues appear once the topic-catalogue tables (migration 0112) are applied."
            : `Could not read the review queues: ${inReviewQ.error?.message ?? draftQ.error?.message ?? "unknown error"}`}
        </p>
      )}

      <h2 className="text-xs font-medium text-[#5B6470] uppercase tracking-wide mb-2">Screens</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {doors.map((d) => (
          <Link key={d.href} href={d.href} className="card p-5 hover:shadow-md transition-shadow">
            <p className="font-medium mb-1">{d.title}</p>
            <p className="text-sm text-[#5B6470]">{d.body}</p>
            {d.readOnly && <p className="text-xs text-[#9A6400] mt-2">Read-only for your role — editors and admins act here.</p>}
          </Link>
        ))}
      </div>
    </main>
  );
}
