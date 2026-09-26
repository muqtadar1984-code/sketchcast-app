import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueMissing } from "@/utils/catalogue/status";
import { loadOutdatedVideos, loadVideoFormat } from "@/utils/catalogue/format-server";
import { changesSince, formatVersionOf } from "@/utils/catalogue/format";

// Portal overview: the review queues (Phase 2b: articles awaiting review,
// drafts in progress; Phase 3: kits awaiting review, question items awaiting
// review) and the doors into the screens. Every screen is readable by every
// member (the header shows every tab); the doors say where a role can only
// read, matching the read-only note the screen itself shows. Later phases add
// translations, publish failures and the quota-window indicator.

export const dynamic = "force-dynamic";

export default async function LibraryOverviewPage() {
  const member = await requireLibraryMember();
  const can = (a: Parameters<typeof libraryAllows>[1]) => libraryAllows(member.role, a);
  const admin = createAdminClient();

  // Four head counts, not a scan: the queue numbers stay cheap as the knowledge
  // base grows. A missing 0112 leaves the queues unshown (the screens explain).
  const [inReviewQ, draftQ, kitsQ, itemsQ] = await Promise.all([
    admin.from("topic_articles").select("id", { count: "exact", head: true }).eq("status", "in_review"),
    admin.from("topic_articles").select("id", { count: "exact", head: true }).eq("status", "draft"),
    admin.from("topic_kits").select("id", { count: "exact", head: true }).eq("status", "in_review"),
    admin.from("topic_questions").select("id", { count: "exact", head: true }).eq("status", "draft"),
  ]);
  const queueErrors = [inReviewQ.error, draftQ.error, kitsQ.error, itemsQ.error];
  const queuesReady = queueErrors.every((e) => !e);
  const queuesMissing = queueErrors.some((e) => catalogueMissing(e));
  const queueError = queueErrors.find((e) => !!e) ?? null;
  // Videos on the channel that predate the format the worker renders now
  // (0122). A file on YouTube cannot be replaced, so each is the founder's
  // own decision to re-render and supersede — this card only makes sure the
  // list is never missed.
  const videoFormat = await loadVideoFormat(admin);
  const outdated = await loadOutdatedVideos(admin, videoFormat?.version ?? null);
  const outdatedTopics = new Map<string, { title: string; parts: number; oldest: number }>();
  for (const o of outdated.rows) {
    const cur = outdatedTopics.get(o.topicId) ?? { title: o.topicTitle, parts: 0, oldest: Number.MAX_SAFE_INTEGER };
    cur.parts += 1;
    cur.oldest = Math.min(cur.oldest, formatVersionOf(o.publication));
    outdatedTopics.set(o.topicId, cur);
  }
  const awaitingReview = inReviewQ.count ?? 0;
  const drafts = draftQ.count ?? 0;
  const kitsAwaiting = kitsQ.count ?? 0;
  const itemsAwaiting = itemsQ.count ?? 0;

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
    {
      href: "/library/blueprints",
      title: "Blueprints",
      body: "The worksheet presets the composer renders from the question bank: objective / subjective split, difficulty mix, count, marks.",
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
          <Link href="/library/topics?status=in_review" className="card p-5 hover:shadow-md transition-shadow flex items-center justify-between gap-4">
            <span>
              <span className="font-medium block">Kits awaiting review</span>
              <span className="text-sm text-[#5B6470]">
                Video, deck, plan and documents finished by the worker — gate 2 before anything reaches YouTube. {can("approve") ? "You can approve or reject them." : ""}
              </span>
            </span>
            <span className={`text-3xl font-display tabular ${kitsAwaiting > 0 ? "text-[#5B3FBF]" : "text-[#98A0A9]"}`}>{kitsAwaiting}</span>
          </Link>
          <Link href="/library/topics" className="card p-5 hover:shadow-md transition-shadow flex items-center justify-between gap-4">
            <span>
              <span className="font-medium block">Question items awaiting review</span>
              <span className="text-sm text-[#5B6470]">Draft items in the bank across every topic — open a topic&apos;s Question bank to approve or reject them.</span>
            </span>
            <span className={`text-3xl font-display tabular ${itemsAwaiting > 0 ? "text-[#9A6400]" : "text-[#98A0A9]"}`}>{itemsAwaiting}</span>
          </Link>
        </div>
      ) : (
        <p className="text-sm text-[#9A6400] bg-[#FFF9EE] rounded-lg px-4 py-3 mb-8">
          {queuesMissing
            ? "The review queues appear once the topic-catalogue tables (migration 0112) are applied."
            : `Could not read the review queues: ${queueError?.message ?? "unknown error"}`}
        </p>
      )}

      {videoFormat && (
        <>
          <h2 className="text-xs font-medium text-[#5B6470] uppercase tracking-wide mb-2">Videos on the channel</h2>
          <div className={`card p-5 mb-8 ${outdated.rows.length > 0 ? "border-[#F5E3B8] bg-[#FFF9EE]" : ""}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-medium">
                  {outdated.rows.length > 0
                    ? `${outdated.rows.length} published video${outdated.rows.length === 1 ? "" : "s"} predate the current video format (v${videoFormat.version})`
                    : `Every published video is on the current video format (v${videoFormat.version})`}
                </p>
                <p className="text-sm text-[#5B6470] mt-1">
                  A video&apos;s file on YouTube cannot be replaced, so an upgrade only reaches new uploads. Whether an older video is worth re-rendering and superseding is your call, video by video — open the topic, regenerate the kit, post it, then Supersede the older one from its publish block.
                </p>
                {outdated.error && <p className="text-xs text-[#B3401F] mt-1">Could not read the list: {outdated.error}</p>}
              </div>
              <span className={`text-3xl font-display tabular ${outdated.rows.length > 0 ? "text-[#9A6400]" : "text-[#98A0A9]"}`}>{outdated.rows.length}</span>
            </div>
            {outdatedTopics.size > 0 && (
              <ul className="mt-3 grid gap-1 sm:grid-cols-2 text-sm">
                {[...outdatedTopics.entries()].slice(0, 12).map(([tid, t]) => (
                  <li key={tid}>
                    <Link href={`/library/topics/${tid}`} className="hover:underline">
                      {t.title}
                    </Link>
                    <span className="text-xs text-[#5B6470]">
                      {" "}
                      · {t.parts} video{t.parts === 1 ? "" : "s"} · format v{t.oldest}
                    </span>
                  </li>
                ))}
                {outdatedTopics.size > 12 && <li className="text-xs text-[#5B6470]">…and {outdatedTopics.size - 12} more topics.</li>}
              </ul>
            )}
            {outdated.rows.length > 0 && (
              <p className="text-xs text-[#5B6470] mt-3">
                What changed since the oldest ({`v${Math.min(...outdated.rows.map((o) => formatVersionOf(o.publication)))}`}):{" "}
                {changesSince(videoFormat, Math.min(...outdated.rows.map((o) => formatVersionOf(o.publication)))).join(" · ") || "no changelog recorded"}
              </p>
            )}
          </div>
        </>
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
