import type { Approval } from "@/utils/books/types";

/**
 * What approves a chapter at a revision — the same rule as the engine's
 * sk_bundle._approval: the book-level approval of that revision, else the
 * chapter's own Gate D stamp, and only when the stamp's hash matches THAT
 * revision's text (the importer verified it and recorded which revision it matched).
 */
export function approvalFor(approvals: Approval[], chapter: number, revisionKey: string, contentSha: string): Approval | null {
  const book = approvals.find((a) => a.kind === "book" && a.revision_key === revisionKey);
  if (book) return book;
  const stamps = approvals.filter((a) => a.kind === "gate_d" && a.chapter === chapter && a.hash_verified && a.content_sha256 === contentSha);
  return stamps[stamps.length - 1] ?? null;
}

/** The latest verified Gate D stamp of a chapter, whichever revision it covers (the lock that applies to its text). */
export function latestGateD(approvals: Approval[], chapter: number): Approval | null {
  const s = approvals.filter((a) => a.kind === "gate_d" && a.chapter === chapter);
  return s[s.length - 1] ?? null;
}
