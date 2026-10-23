import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { ErrorBanner } from "../catalogue-ui";
import { MissingPinterestBanner, PinterestHeading, PinterestNav } from "./chrome";
import { loadPinterest } from "./load";
import { ReviewStack } from "./review-stack";

// /library/pinterest — the Pinterest Pin Engine's review (feature guide §8,
// build plan §4.1, migration 0154). The worker drafts pins from approved
// catalogue content; here a platform admin looks at each one — image, the
// title as a feed cuts it, description, alt text, board, link, the worker's
// prechecks and, for other languages, the English back-translation — and
// approves, edits or rejects it. ONE PIN AT A TIME, by design: Pinterest's
// Developer Guidelines require the user to "choose each Pin to be published"
// (decision D1), so there is no select-all and no bulk approve.
//
// Every Library member can look; only admins (`publish`) act. Approving does
// not post: the worker posts approved pins in its daily rounds.

export const dynamic = "force-dynamic";

export default async function PinterestReviewPage() {
  const member = await requireLibraryMember();
  const admin = createAdminClient();
  let load;
  try {
    load = await loadPinterest(admin);
  } catch (e) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <PinterestHeading />
        <PinterestNav active="review" />
        <ErrorBanner message={e instanceof Error ? e.message : "Could not load the Pinterest pins."} />
      </main>
    );
  }
  if (!load.available) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-10">
        <PinterestHeading />
        <PinterestNav active="review" />
        <MissingPinterestBanner />
      </main>
    );
  }

  const canAct = libraryAllows(member.role, "publish");
  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <PinterestHeading settings={load.settings} />
      <PinterestNav active="review" counts={load.counts} />
      {load.review.length === 0 ? (
        <div className="rounded-xl border border-[#E3E6E0] bg-white px-6 py-10 text-center">
          <p className="font-medium">No pins waiting for review.</p>
          <p className="text-sm text-[#5B6470] mt-1">
            The worker drafts a few pins at a time from approved topics, and only while fewer than{" "}
            {load.settings.max_waiting_per_language ?? 14} wait per language.
            {!load.settings.enabled ? " The agent is off, so nothing is being drafted." : ""}
          </p>
        </div>
      ) : (
        <ReviewStack pins={load.review} canAct={canAct} />
      )}
    </main>
  );
}
