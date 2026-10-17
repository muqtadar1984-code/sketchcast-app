import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogueColumnMissing, catalogueMissing } from "./status";
import { queueRowsOf, type QueueKitRow, type ReviewQueue } from "./review-queue";

// The review queue's rows, read for the inbox (the topic page's left pane)
// and the /library/review door. Two selects: with the Kit Translator's
// columns (0134), and — when a database does not carry them yet — the English
// kits alone, so the page still lists what it can.

const QUEUE_LIMIT = 200;
const BASE = "id, topic_id, language, status, updated_at, created_at, topics(id, title, subject, status)";

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
