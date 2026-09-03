// What a teacher is told before a book is deleted, and why they might be
// refused — the pure half of src/app/dashboard/delete-book.tsx.
//
// Deleting a book takes every kit generated from it (0100), and a kit can
// carry work students submitted. The confirm has to say so in numbers, not
// adjectives: "3 kits" and "12 pieces of student work" are what let a teacher
// decide, and they come from my_book_impact() rather than from anything the
// page happens to know. Kept out of the component so the wording for every
// shape (empty book, kits only, kits with student work) is pinned by a test
// that needs no React and no dictionary.

import { fmt } from "@/i18n/format";

/** The row my_book_impact(p_book) returns (migration 0100). */
export type BookImpact = {
  kits: number;
  /** Kits on this book made by OTHER teachers — a school-shelf book. */
  others: number;
  processing: number;
  indexing: boolean;
  submissions: number;
  students: number;
  classes: number;
};

/** The delete-book strings — `library.deleteBook` in the dictionary. */
export type DeleteBookMessages = {
  delete: string;
  confirmEmpty: string;
  confirm: string;
  studentWork: string;
  shared: string;
  building: string;
  indexing: string;
};

export type BlockedReason = "shared" | "indexing" | "building";

/** The error tokens delete_my_book raises. The client checks the impact
 * first, but the RPC is the authority — this maps its refusal back to the
 * same messages. */
export const BLOCKED_TOKENS: Record<string, BlockedReason> = {
  shared_kits: "shared",
  book_indexing: "indexing",
  kit_building: "building",
};

/**
 * Why the delete must not go ahead, or null when it may. In order:
 *   shared    — other teachers made kits from this book; retiring a school
 *               book is leadership's act (withdraw), never a delete
 *   indexing  — the book is still being indexed
 *   building  — a kit is still being built
 * The last two would leave a worker writing into rows that no longer exist —
 * the exact failure behind the chapter_grounding storm of 2026-09-02.
 */
export function bookDeleteBlockedReason(i: BookImpact): BlockedReason | null {
  if (i.others > 0) return "shared";
  if (i.indexing) return "indexing";
  if (i.processing > 0) return "building";
  return null;
}

/** The refusal to show for an RPC error message, or null if it is not one of
 * the known tokens (a genuine failure, shown as-is). */
export function blockedReasonFromError(message: string | null | undefined): BlockedReason | null {
  if (!message) return null;
  for (const [token, reason] of Object.entries(BLOCKED_TOKENS)) {
    if (message.includes(token)) return reason;
  }
  return null;
}

/**
 * The confirm text. Three shapes, deliberately distinct:
 *   • no kits          — the short form; "0 kits and their files" is noise
 *   • kits, no work    — names the count and that credits are not returned
 *   • kits with work   — adds the sentence about students' submissions, with
 *                        its own number, because that is the one a teacher
 *                        may not have expected and must not miss
 */
export function bookDeleteConfirmText(t: DeleteBookMessages, title: string, i: BookImpact): string {
  if (i.kits <= 0) return fmt(t.confirmEmpty, { title });
  const base = fmt(t.confirm, { title, kits: i.kits });
  if (i.submissions <= 0) return base;
  return `${base} ${fmt(t.studentWork, { submissions: i.submissions })}`;
}
