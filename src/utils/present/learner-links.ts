// "Learn with SK" on the student's My lessons (SK student Board plan
// 2026-10-31, phase 1): one link per ASSIGNED kit, opening that kit on the
// student Board in learner mode. PURE, and grouped by the same key the Board
// uses (learner.ts learnerKitKey), so a link always lands on the kit it names:
// `?learn=<piece>` resolves to the kit holding that piece.

import { kitPrefix } from "./kit";
import { learnerKitKey, LEARNER_EXCLUDED_KINDS } from "./learner";

export type LearnLinkGen = { id: string; kind: string; title?: string | null; chapter_ref: string | null; book_id: string | null };
export type LearnLink = { href: string; label: string | null };

/** The Board deep link for one assigned piece's kit. */
export const learnHref = (generationId: string): string => `/present?${new URLSearchParams({ learn: generationId, autostart: "1" }).toString()}`;

/**
 * The links for one My lessons chapter group: one per kit among `gens` (its
 * lesson video when assigned, else its first piece). A label (the kit's
 * name) only when the group holds more than one kit — the ready-made kits all
 * share the "no chapter" heading. Pieces that never reach the student Board
 * (a plan, a question bank, a test paper) make no link of their own.
 */
export function learnLinks(gens: LearnLinkGen[]): LearnLink[] {
  const byKey = new Map<string, LearnLinkGen[]>();
  for (const g of gens) {
    if (!g?.id || LEARNER_EXCLUDED_KINDS.has(g.kind)) continue;
    const k = learnerKitKey({ id: g.id, book_id: g.book_id, chapter_ref: g.chapter_ref, title: g.title ?? null });
    const list = byKey.get(k);
    if (list) list.push(g);
    else byKey.set(k, [g]);
  }
  const many = byKey.size > 1;
  return [...byKey.entries()].map(([key, list]) => {
    const head = list.find((g) => g.kind === "presentation") ?? list[0];
    const label = many ? (key.startsWith("t:") ? kitPrefix(head.title) || null : null) : null;
    return { href: learnHref(head.id), label };
  });
}
