// SK gap tracker (founder 2026-10-31; design: Edtech/"SK - Gap tracker design
// 2026-10-31.md"; table: migration 0177). One row per (turn, signal) where SK
// could not help. SERVER ONLY — written with the service role, never from a
// browser. Students are included and the question is stored as asked (book
// codes NOT masked — founder decision, so a miss can be replayed exactly).
import type { SupabaseClient } from "@supabase/supabase-js";

export type SkGapSignal = "self" | "refusal" | "tool_failed" | "grounding" | "phrase" | "thumbs_down";

export type SkGapInput = {
  turnId: string;
  userId: string | null;
  role: string | null;
  locale?: string | null;
  page?: string | null;
  modality?: string | null;
  signal: SkGapSignal;
  question?: string | null;
  reply?: string | null;
  /** What the user wanted, in one line: SK's own (sk.note_gap) or the 👎 note. */
  wanted?: string | null;
  route?: string | null;
  tools?: string[];
  context?: Record<string, unknown> | null;
};

/** Raw text is kept this long, then cleared (counts and themes stay). */
export const SK_GAP_TEXT_DAYS = 90;

const cut = (s: string | null | undefined, n: number): string | null => {
  const t = (s ?? "").trim();
  return t ? t.slice(0, n) : null;
};

/** The row as stored (limits match 0177's checks). */
export function gapRow(g: SkGapInput) {
  return {
    turn_id: g.turnId.slice(0, 100),
    user_id: g.userId,
    role: cut(g.role, 40),
    locale: cut(g.locale, 20),
    page: cut(g.page, 500),
    modality: cut(g.modality, 20),
    signal: g.signal,
    question: cut(g.question, 4000),
    reply: cut(g.reply, 1000),
    wanted: cut(g.wanted, 500),
    route: cut(g.route, 60),
    tools: (g.tools ?? []).slice(0, 30).map((t) => t.slice(0, 80)),
    context: g.context ?? null,
  };
}

/** Best-effort: records the gaps and NEVER throws or slows a turn's reply
 *  (call it from after()). A repeat of the same (turn, signal) is ignored. */
export async function recordGaps(admin: SupabaseClient, gaps: SkGapInput[]): Promise<void> {
  if (!gaps.length) return;
  try {
    const { error } = await admin
      .from("sk_gaps")
      .upsert(gaps.map(gapRow), { onConflict: "turn_id,signal", ignoreDuplicates: true });
    if (error) console.warn("sk-gaps.record", error.message);
  } catch (e) {
    console.warn("sk-gaps.record", (e as Error).message);
  }
}
