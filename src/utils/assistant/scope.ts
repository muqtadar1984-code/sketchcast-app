// Option-B grounding scope for the AI Teaching Assistant. The student's
// IN-SCOPE BOOKS are the primary source, and the boundary is the curriculum
// TOPICS those books cover (their chapter/topic metadata) — not the exact
// sentences, and not the whole library. Retrieval is lexical scoring over
// chapter titles + grounding concepts: cheap, fast, no new deps — and the
// decision function is pure so the in-scope/off-topic/no-book branches are
// unit-tested without a database.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ScopedBook = { id: string; title: string; subject: string | null; grade: string | null };
export type Topic = { bookId: string; bookTitle: string; chapterNum: number; title: string };

/** Books in scope for THIS user: a student's assigned lessons' books first;
 * an adult (teacher/parent previewing) falls back to books they own. Capped —
 * scope is "what we're studying", not the whole library. */
export async function inScopeBooks(admin: SupabaseClient, userId: string): Promise<ScopedBook[]> {
  const ids = new Set<string>();
  const { data: assigned } = await admin
    .from("student_progress")
    .select("generations(book_id)")
    .eq("student_id", userId)
    .limit(200);
  for (const r of assigned ?? []) {
    const bookId = (r as { generations?: { book_id?: string } | { book_id?: string }[] }).generations;
    const v = Array.isArray(bookId) ? bookId[0]?.book_id : bookId?.book_id;
    if (v) ids.add(v);
  }
  if (ids.size === 0) {
    const { data: owned } = await admin.from("books").select("id").eq("owner_id", userId).limit(12);
    for (const r of owned ?? []) ids.add((r as { id: string }).id);
  }
  if (ids.size === 0) return [];
  const { data: books } = await admin
    .from("books")
    .select("id, title, subject, grade")
    .in("id", [...ids].slice(0, 12));
  return (books ?? []) as ScopedBook[];
}

/** Every chapter of the in-scope books, as topics (from books.chapters metadata —
 * present for every indexed book, generated lesson or not). */
export async function scopeTopics(admin: SupabaseClient, books: ScopedBook[]): Promise<Topic[]> {
  if (!books.length) return [];
  const { data } = await admin
    .from("books")
    .select("id, title, chapters")
    .in("id", books.map((b) => b.id));
  const topics: Topic[] = [];
  for (const b of data ?? []) {
    const chapters = (b as { chapters?: { num?: number; title?: string }[] }).chapters ?? [];
    for (const c of chapters) {
      if (typeof c?.num === "number" && c?.title) {
        topics.push({ bookId: (b as { id: string }).id, bookTitle: (b as { title: string }).title, chapterNum: c.num, title: String(c.title) });
      }
    }
  }
  return topics;
}

// ── Pure retrieval scoring ───────────────────────────────────────────────────

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "to", "is", "are", "was", "were", "what", "whats", "why",
  "how", "who", "when", "where", "which", "do", "does", "did", "can", "could", "will", "would", "me", "my",
  "you", "your", "i", "we", "it", "this", "that", "these", "those", "about", "tell", "explain", "please",
  "with", "for", "from", "into", "be", "have", "has", "had",
]);

export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z-]{1,}/g) ?? []).filter((w) => !STOP.has(w) && w.length >= 3);
}

/** Simple stem so "cells" matches "cell", "dividing" ~ "divide". */
const stem = (w: string): string => w.replace(/(ing|ed|es|s)$/i, "");

export type ScoredTopic = Topic & { score: number };

/** Rank topics by content-word overlap with the question (keywords may add the
 * chapter's grounding concepts). Deterministic; ties keep input order. */
export function scoreTopics(question: string, topics: (Topic & { keywords?: string[] })[]): ScoredTopic[] {
  const qWords = new Set(contentWords(question).map(stem));
  return topics
    .map((t) => {
      const words = new Set([...contentWords(t.title), ...(t.keywords ?? []).flatMap(contentWords)].map(stem));
      let score = 0;
      for (const w of qWords) if (words.has(w)) score += 1;
      return { ...t, score };
    })
    .sort((a, b) => b.score - a.score);
}

export type ScopeDecision =
  | { kind: "no_book" }
  | { kind: "off_topic"; suggestTopics: Topic[] }
  | { kind: "in_scope"; best: ScoredTopic; alternates: ScoredTopic[] };

/** The Option-B decision: no books → no_book; no topic overlap → off_topic (with
 * real topics to redirect to); else the best-matching chapter grounds the answer.
 * `alwaysInScope` covers follow-ups that carry no topical words ("explain that
 * again") — with an active conversation they stay in scope on the same topic. */
export function decideScope(question: string, topics: Topic[], opts: { activeTopic?: Topic | null } = {}): ScopeDecision {
  if (!topics.length) return { kind: "no_book" };
  const ranked = scoreTopics(question, topics);
  const best = ranked[0]!;
  if (best.score > 0) return { kind: "in_scope", best, alternates: ranked.slice(1, 3).filter((t) => t.score > 0) };
  // No topical overlap. A follow-up inside a conversation keeps the active topic;
  // a fresh question with no overlap is off-topic → decline and redirect.
  if (opts.activeTopic) {
    return { kind: "in_scope", best: { ...opts.activeTopic, score: 0 }, alternates: [] };
  }
  return { kind: "off_topic", suggestTopics: topics.slice(0, 3) };
}
