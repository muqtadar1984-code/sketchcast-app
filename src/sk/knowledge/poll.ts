// SK S7 K1 — the guarded release poll for the daily cron
// (/api/lifecycle/reminders). It never throws: a missing pub_releases (the
// book app's 0172 not applied yet) answers waiting_for_book_app quietly; any
// other failure is logged and the cron carries on. It sends nothing.

import { pollReleases, type PollResult } from "./release";
import type { KnowledgeDb } from "./store";

export async function runSkKnowledgePoll(admin: () => KnowledgeDb): Promise<PollResult | null> {
  try {
    return await pollReleases(admin());
  } catch (e) {
    console.error("[sk knowledge] release poll failed:", (e as Error).message);
    return null;
  }
}
