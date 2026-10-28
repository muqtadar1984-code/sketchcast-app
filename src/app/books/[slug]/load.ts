import "server-only";
import { notFound } from "next/navigation";
import { requireBookMember, roleOn, type BookMember } from "@/utils/books-access";
import { getWork, listRevisions } from "@/utils/books/store";
import type { BookRevision, Work } from "@/utils/books/types";

/** The book a /books/[slug]/* page shows, or a 404 when it does not exist or the member may not read it. */
export async function loadBook(slug: string): Promise<{ member: BookMember; work: Work; revisions: BookRevision[] }> {
  const member = await requireBookMember();
  const work = await getWork(slug);
  if (!work || !roleOn(member, work.uid)) notFound();
  return { member, work, revisions: await listRevisions(work.uid) };
}

/** A ?rev= value, defaulting to the book's current revision. */
export function pickRevision(work: Work, revisions: BookRevision[], wanted?: string | string[]): BookRevision {
  const key = typeof wanted === "string" ? wanted : work.current_revision;
  return revisions.find((r) => r.key === key) ?? revisions.find((r) => r.key === work.current_revision) ?? revisions[revisions.length - 1];
}
