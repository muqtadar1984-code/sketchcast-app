// The student Board ("learner mode", SK student Board plan 2026-10-31, phase 1).
//
// A student learns her ASSIGNED kits on the same Board teachers use. This
// module is the pure half: which kits she has, what each one's rail holds, and
// what never reaches her. No Supabase, no signing, no React — the server
// loaders (learner-server.ts), the kit route (/api/present/learn/kit) and the
// tests all go through it.
//
// ASSIGNED MEANS SHARED, EXPLICITLY. A student's RLS view of `generations` is
// wider than her assignments in a school (school-wide reads exist for other
// surfaces), so nothing here trusts "she can read it": a generation counts only
// when one of HER generation_shares rows names it — the same rule the
// student's My lessons applies (dashboard/page.tsx shareByGen).
//
// ONE KIT PER CHAPTER OR PER READY-MADE KIT. Assignment is per generation (a
// kit's video, deck and documents are shared one row each), so the kits are
// re-assembled here exactly as the teacher's Board assembles them:
//   - an uploaded / scanned book's kit → its book and chapter (every part of
//     the chapter is a unit of the one kit, like the teacher's chapter rail);
//   - a ready-made kit (an adopted catalogue kit or SketchCast book chapter:
//     book-less copies) → its title prefix (railForKit's key).
//
// WHAT NEVER REACHES THE STUDENT BOARD: the teacher's plan and question bank
// (teacher-only, the Library's rule), the answer key (an artifact of the
// worksheet that is never signed for a student — the worksheet reaches the
// Board through the answer-STRIPPED /api/quiz route), and test papers (a paper
// taught on the Board is no longer a test — kit.ts NEVER_PROJECT). What is
// left: the lesson video, the deck (pages), and the worksheets.

import { boardEligible, chapterOf, hasArtifact, isRevision, kitPrefix, NEVER_PROJECT, unitsOf, type KitGeneration, type RailUnit } from "./kit";

/** Kinds that never reach the student Board, whatever was shared. */
export const LEARNER_EXCLUDED_KINDS: ReadonlySet<string> = new Set(["lesson_plan", "question_bank", "answer_key", ...NEVER_PROJECT]);

/** A generation as the learner loaders read it (her own session). */
export type LearnerGen = KitGeneration & {
  book_id: string | null;
  status?: string | null;
  withdrawn_at?: string | null;
  created_at?: string | null;
};

/** One of HER generation_shares rows (RLS: shares to her classes or to her). */
export type LearnerShare = { generation_id: string; due_at: string | null; created_at?: string | null };

export type LearnerKit = {
  /** The kit's id on the Board: its lesson video's generation (else its first piece). */
  id: string;
  /** "b:<book>:<chapter>" or "t:<title prefix>" — the grouping key. */
  key: string;
  /** Every assigned piece of the kit (deep links may name any of them). */
  members: string[];
  /** A ready-made kit's name; null for a book chapter (the caller names it). */
  title: string | null;
  bookId: string | null;
  /** 0-based chapter (the database's chapter_ref) for a book chapter. */
  chapterNum: number | null;
  /** The EARLIEST due date of its pieces (the deadline), ISO; null = none. */
  due: string | null;
  /** The newest share of any piece (orders the undated kits). */
  sharedAt: string | null;
  units: RailUnit[];
};

/** The grouping key of one generation. */
export function learnerKitKey(g: Pick<LearnerGen, "id" | "book_id" | "chapter_ref" | "title">): string {
  if (g.book_id && g.chapter_ref !== null && g.chapter_ref !== undefined && String(g.chapter_ref).trim() !== "") return `b:${g.book_id}:${g.chapter_ref}`;
  const p = kitPrefix(g.title);
  return p ? `t:${p}` : `g:${g.id}`;
}

/** May this generation reach the student Board at all? */
export function learnerVisible(g: LearnerGen): boolean {
  if (LEARNER_EXCLUDED_KINDS.has(g.kind)) return false;
  if (isRevision(g)) return false;
  if (g.status != null && g.status !== "done") return false;
  if (g.withdrawn_at) return false;
  return true;
}

/**
 * A kit's rail for the student: the units of its pieces, each with its video
 * and ONLY the documents the student Board shows — the deck (as pages) and the
 * worksheets that may be projected. Units left with nothing are dropped.
 */
export function learnerUnits(members: LearnerGen[]): RailUnit[] {
  const usable = members.filter(learnerVisible);
  const units = unitsOf(usable);
  return units
    .map((u) => ({ ...u, docs: u.docs.filter((d) => d.note === "deck" || (d.projects && !LEARNER_EXCLUDED_KINDS.has(d.kind))) }))
    .filter((u) => !!u.video || u.docs.length > 0);
}

const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/**
 * Her assigned kits. `gens` is what her session can read; only those one of
 * `shares` names are used. Ordered NEWEST DUE FIRST (the latest due date at the
 * top, the plan's wording), then the undated ones, newest share first.
 */
export function learnerKits(gens: LearnerGen[], shares: LearnerShare[]): LearnerKit[] {
  const dueOf = new Map<string, string | null>();
  const sharedOf = new Map<string, string | null>();
  for (const s of shares) {
    if (!s || typeof s.generation_id !== "string") continue;
    const prev = dueOf.get(s.generation_id);
    const due = s.due_at ?? null;
    // The earliest due date of a piece shared twice (class + direct) wins, as on My lessons.
    if (!dueOf.has(s.generation_id) || (due && (!prev || time(due) < time(prev)))) dueOf.set(s.generation_id, due ?? prev ?? null);
    const at = s.created_at ?? null;
    const prevAt = sharedOf.get(s.generation_id) ?? null;
    if (!prevAt || (at && time(at) > time(prevAt))) sharedOf.set(s.generation_id, at);
  }
  const groups = new Map<string, LearnerGen[]>();
  for (const g of gens) {
    if (!g || !dueOf.has(g.id) || !learnerVisible(g)) continue;
    const k = learnerKitKey(g);
    const list = groups.get(k);
    if (list) list.push(g);
    else groups.set(k, [g]);
  }
  const out: LearnerKit[] = [];
  for (const [key, members] of groups) {
    const units = learnerUnits(members);
    if (!units.length) continue;
    const video = units.find((u) => u.video)?.video?.id ?? null;
    const sorted = [...members].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.id.localeCompare(b.id));
    const id = video ?? sorted[0].id;
    const book = key.startsWith("b:") ? members[0] : null;
    const dues = members.map((m) => dueOf.get(m.id) ?? null).filter((d): d is string => !!d && Number.isFinite(time(d)));
    const due = dues.length ? dues.reduce((a, b) => (time(b) < time(a) ? b : a)) : null;
    const ats = members.map((m) => sharedOf.get(m.id) ?? null).filter((d): d is string => !!d && Number.isFinite(time(d)));
    const sharedAt = ats.length ? ats.reduce((a, b) => (time(b) > time(a) ? b : a)) : null;
    out.push({
      id,
      key,
      members: sorted.map((m) => m.id),
      title: book ? null : kitPrefix(members.find((m) => m.id === id)?.title ?? sorted[0].title) || null,
      bookId: book?.book_id ?? null,
      chapterNum: book ? chapterOf(book) : null,
      due,
      sharedAt,
      units,
    });
  }
  return out.sort((a, b) => {
    if (a.due && b.due) return time(b.due) - time(a.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return (time(b.sharedAt) || 0) - (time(a.sharedAt) || 0) || a.key.localeCompare(b.key);
  });
}

/** The kit a deep link names: its id, or any of its pieces. */
export function learnerKitFor(kits: LearnerKit[], id: string | null | undefined): LearnerKit | null {
  if (!id) return null;
  return kits.find((k) => k.id === id) ?? kits.find((k) => k.members.includes(id)) ?? null;
}

/** Does this worksheet carry questions the Board can show (answer-stripped)? */
export const learnerHasQuestions = (g: KitGeneration | undefined): boolean => !!g && boardEligible(g) && hasArtifact(g, "questions_json");

/**
 * Who may open the Board as a learner: a STUDENT for whom the SK Shell is on.
 * Her school's (or teacher's) entitlement is what put the kit in front of her;
 * she has no plan of her own and needs none. Everybody else keeps the Board's
 * own gate (presentEntitled) — a student without SK keeps today's refusal.
 */
export function learnerAllowed(f: { role: string | null; skOn: boolean }): boolean {
  return f.role === "student" && f.skOn;
}
