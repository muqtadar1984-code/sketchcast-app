// SK's FOCUS concepts for a student and her "how am I doing?" from practice
// (SK student Board plan 2026-10-31, phase 4). Server only.
//
// An APPROVED plan's re-teach items become sk_learn_focus rows (0179,
// sk_learn_plan_decide): the concepts SK should teach her next, per kit, for
// 14 days. This module is what SK's learner turns read — NOT wired into the
// turn route here (the phase 3 builder owns src/app/api/sk/shell/turn/route.ts
// and src/sk/shell/prompt.ts): the turn should call
//     readFocus(sessionDb, ctx.user.id, { kitId: ctx.board?.generationId })
// for a student on her Board and append focusLine(rows) to the learner rules
// (SK_STUDENT_BOARD_RULES) — one line, no model call, her own rows by RLS.

import type { DbRow, SkDb } from "@/sk/store-supabase";
import { bandCounts, type ConceptMastery } from "./mastery";

export type FocusRow = { kitId: string; key: string; name: string; until: string };

/** Her focus concepts still in force, newest first (her session: RLS = own rows). */
export async function readFocus(db: SkDb, studentId: string, opts: { kitId?: string | null; now?: number } = {}): Promise<FocusRow[]> {
  try {
    let q = db.from("sk_learn_focus").select("kit_id, concept_key, concept_name, until, created_at").eq("student_id", studentId);
    if (opts.kitId) q = q.eq("kit_id", opts.kitId);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(20);
    if (error) return [];
    const now = opts.now ?? Date.now();
    return ((data ?? []) as DbRow[])
      .filter((r) => Date.parse(String(r.until)) > now)
      .map((r) => ({ kitId: String(r.kit_id), key: String(r.concept_key), name: String(r.concept_name), until: String(r.until) }));
  } catch {
    return [];
  }
}

/** The one line for SK's learner rules, or "" when there is no focus. */
export function focusLine(rows: readonly FocusRow[]): string {
  const names = [...new Set(rows.map((r) => r.name.trim()).filter(Boolean))].slice(0, 5);
  if (!names.length) return "";
  return `S6. FOCUS (her teacher or parent approved this plan): when it fits what she is doing, teach these ideas again first and check them with a question — ${names.join("; ")}. Never say she is weak at them; just teach.`;
}

/** Her practice mastery as SK's "how am I doing?" groups (names per band). */
export function progressFromPractice(rows: readonly ConceptMastery[]): { secure: string[]; learning: string[]; fresh: string[]; counts: ReturnType<typeof bandCounts> } {
  const by = (b: ConceptMastery["band"]) => [...new Set(rows.filter((r) => r.band === b).map((r) => r.name))];
  return { secure: by("secure"), learning: by("learning"), fresh: by("new"), counts: bandCounts(rows) };
}
