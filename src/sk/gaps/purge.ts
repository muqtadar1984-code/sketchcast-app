// SK gap tracker — the retention purge (migration 0177; founder decision: the
// raw text is kept SK_GAP_TEXT_DAYS, then cleared). The row, its signal, role,
// page and theme link stay, so the console's counts are unchanged. SERVER ONLY.
import { SK_GAP_TEXT_DAYS } from "./store";
import type { GapsDb } from "./group";

/** The text columns the purge clears. */
export const PURGED_COLUMNS = { question: null, reply: null, wanted: null, context: null } as const;

/** The creation time before which a miss's text is cleared. */
export function purgeCutoff(now: Date, days = SK_GAP_TEXT_DAYS): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** Clears the text of every miss older than the cutoff that still has it.
 *  Returns how many rows were cleared. Throws on a database error. */
export async function purgeGapText(db: GapsDb, now: Date = new Date()): Promise<{ purged: number; cutoff: string }> {
  const cutoff = purgeCutoff(now);
  const { count, error } = await db
    .from("sk_gaps")
    .update({ ...PURGED_COLUMNS, text_purged_at: now.toISOString() }, { count: "exact" })
    .lt("created_at", cutoff)
    .is("text_purged_at", null);
  if (error) throw new Error(`sk_gaps purge failed: ${error.message}`);
  return { purged: count ?? 0, cutoff };
}
