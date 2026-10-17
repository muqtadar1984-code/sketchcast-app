import { redirect } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { loadReviewQueue } from "@/utils/catalogue/review-queue-server";
import { inboxHref } from "@/utils/catalogue/review-queue";

// /library/review — the door into the review inbox. The inbox lives on the
// topic page (/library/topics/[id], layout D): this opens it on the newest
// kit awaiting review, or on the topics list when nothing is waiting.

export const dynamic = "force-dynamic";

export default async function ReviewInboxDoor() {
  await requireLibraryMember();
  const queue = await loadReviewQueue(createAdminClient());
  const first = queue.rows[0];
  redirect(first ? inboxHref(first.topicId, { lang: first.translation ? first.language : null }) : "/library/topics?status=in_review");
}
