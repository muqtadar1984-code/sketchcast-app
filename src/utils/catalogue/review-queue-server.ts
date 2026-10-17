import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogueColumnMissing, catalogueMissing } from "./status";
import { inboxHref, queueRowsOf, type QueueKitRow, type ReviewQueue } from "./review-queue";

// The review queue's rows, read for the inbox (the topic page's left pane)
// and the /library/review door. Two selects: with the Kit Translator's
// columns (0134), and — when a database does not carry them yet — the English
// kits alone, so the page still lists what it can.

const QUEUE_LIMIT = 200;
const BASE = "id, topic_id, language, status, updated_at, created_at, topics(id, title, subject, status)";

/** Where the Topics tab (and /library/review) opens: the inbox on the newest
 *  kit awaiting review, else on the most recently updated topic in all-topics
 *  mode, else the plain list (an empty catalogue). */
export async function inboxDoorHref(admin: SupabaseClient): Promise<string> {
  const queue = await loadReviewQueue(admin);
  const first = queue.rows[0];
  if (first) return inboxHref(first.topicId, { lang: first.translation ? first.language : null });
  const { data } = await admin.from("topics").select("id").order("updated_at", { ascending: false }).limit(1).maybeSingle();
  const row = data as { id: string } | null;
  return row ? inboxHref(row.id, { queue: "all" }) : "/library/topics?view=list";
}

export async function loadReviewQueue(admin: SupabaseClient): Promise<ReviewQueue> {
  const withTranslations = await admin
    .from("topic_kits")
    .select(`${BASE}, translation_status, precheck`)
    .or("status.eq.in_review,translation_status.eq.in_review")
    .order("updated_at", { ascending: false })
    .limit(QUEUE_LIMIT);
  if (!withTranslations.error) {
    return { rows: queueRowsOf((withTranslations.data ?? []) as unknown as QueueKitRow[]), error: null, translationsMissing: false };
  }
  if (!catalogueColumnMissing(withTranslations.error)) {
    return { rows: [], error: catalogueMissing(withTranslations.error) ? null : (withTranslations.error.message ?? "unknown error"), translationsMissing: false };
  }
  const englishOnly = await admin.from("topic_kits").select(BASE).eq("status", "in_review").order("updated_at", { ascending: false }).limit(QUEUE_LIMIT);
  if (englishOnly.error) {
    return { rows: [], error: catalogueMissing(englishOnly.error) ? null : (englishOnly.error.message ?? "unknown error"), translationsMissing: true };
  }
  return { rows: queueRowsOf((englishOnly.data ?? []) as unknown as QueueKitRow[]), error: null, translationsMissing: true };
}
