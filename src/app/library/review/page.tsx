import { redirect } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLibraryMember } from "@/utils/library-access";
import { inboxDoorHref } from "@/utils/catalogue/review-queue-server";

// /library/review — a door into the review inbox, kept for the overview's
// "Kits awaiting review" card and old links. The inbox lives on the topic
// page (/library/topics/[id], layout D), and the Topics tab itself opens it
// (topics/page.tsx redirects a bare /library/topics the same way).

export const dynamic = "force-dynamic";

export default async function ReviewInboxDoor() {
  await requireLibraryMember();
  redirect(await inboxDoorHref(createAdminClient()));
}
