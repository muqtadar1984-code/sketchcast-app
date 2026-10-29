// S4 slice E — the data behind the "This week" card on /dashboard/children
// (design 2026-10-29, decision 1: in-app only, no email). Server-only, called
// from the page with the page's OWN session client and the work rows the page
// already read; the numbers and steps come from the SAME digest builder as
// SK's child.week (parent-digest.ts weekCardsFor → weekNumbers + nextSteps).
//
// Reads:
//   - diary_notes through the parent's SESSION (RLS: her children's notes and
//     their classes' notes), the same two reads child.diary makes, cut per
//     child in code (cutChildDiary);
//   - mastery through parent-mastery.ts linkedChildMastery — the ONE admin
//     read, behind the verified-link check, one child at a time.
// Plain dashboard UI: not gated by SK_ROLES / SK at all; the page's own
// parent-portal flag is the only gate.

import type { SupabaseClient } from "@supabase/supabase-js";
import { childrenFromLinks } from "@/sk/shell/context";
import { linkedChildMastery } from "@/sk/parent-mastery";
import { diarySince, weekCardsFor, type WeekCard } from "@/sk/parent-digest";
import type { ChildMasteryRow } from "@/sk/parent-mastery";
import type { ChildWorkRows } from "@/utils/child-work";

const NOTE_COLS = "id, author_id, class_id, student_id, note_type, body, entry_date, created_at";

export async function loadWeekCards(
  supabase: SupabaseClient,
  userId: string,
  links: Array<Record<string, unknown>>,
  rows: ChildWorkRows,
  locale: string,
  now: number,
): Promise<Record<string, WeekCard>> {
  // This parent's OWN links only (childrenFromLinks drops any other parent's row).
  const children = childrenFromLinks(userId, links);
  const verified = children.filter((c) => c.verified);
  if (!verified.length) return {};
  const ids = verified.map((c) => c.id);
  const kids = new Set(ids);
  const classIds = [...new Set(rows.enrollments.filter((e) => kids.has(e.student_id)).map((e) => e.class_id))];
  const since = diarySince(now);

  const [ownQ, classQ, mastery] = await Promise.all([
    supabase.from("diary_notes").select(NOTE_COLS).in("student_id", ids).gte("entry_date", since).order("created_at", { ascending: false }).limit(200),
    classIds.length
      ? supabase.from("diary_notes").select(NOTE_COLS).in("class_id", classIds).is("student_id", null).gte("entry_date", since).order("created_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    Promise.all(verified.map(async (c) => [c.id, await linkedChildMastery(children, c.id)] as const)),
  ]);
  const noteRows = [...((ownQ.data ?? []) as Array<Record<string, unknown>>), ...((classQ.data ?? []) as Array<Record<string, unknown>>)];

  const cards = weekCardsFor({
    children,
    rows,
    noteRows,
    mastery: Object.fromEntries(mastery) as Record<string, ChildMasteryRow[] | null>,
    locale,
    now,
  });
  return Object.fromEntries(cards.map((c) => [c.childId, c]));
}
