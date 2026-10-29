// SK S3 — the mastery key for kit items (design decision 3): the ARTICLE
// objective, "<topic_articles.id>:<objective_ref>", stored in
// mastery_state.objective_key / item_attempts.objective_key (migration 0170)
// next to the book path's teaching_objective_id. Pure; not wired into the loop
// yet (slice C writes it).
//
// The article id is part of the key because objective refs ("o1", "o2", …) are
// renumbered per article VERSION: "o2" on version 2 and "o2" on version 3 are
// different objectives (kit-map rule I1, src/sk/manifest/derive.ts).

import { UUID_RE } from "./ids";

const REF_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** "<article_id>:<objective_ref>", or null when either part is unusable (no key, no evidence). */
export function objectiveKey(articleId: string | null | undefined, objectiveRef: string | null | undefined): string | null {
  const a = typeof articleId === "string" ? articleId.trim().toLowerCase() : "";
  const r = typeof objectiveRef === "string" ? objectiveRef.trim() : "";
  if (!UUID_RE.test(a) || !REF_RE.test(r)) return null;
  return `${a}:${r}`;
}

/** The inverse, for reads: null for anything objectiveKey() would not produce. */
export function parseObjectiveKey(key: string | null | undefined): { articleId: string; objectiveRef: string } | null {
  if (typeof key !== "string") return null;
  const i = key.indexOf(":");
  if (i < 0) return null;
  const articleId = key.slice(0, i);
  const objectiveRef = key.slice(i + 1);
  return objectiveKey(articleId, objectiveRef) === key ? { articleId, objectiveRef } : null;
}
