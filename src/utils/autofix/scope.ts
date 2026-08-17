// Which platform_issues.category values the autofix pipeline must refuse.
//
// Autofix is scoped to sketchcast-app: the GitHub Action checks out THIS repo,
// so it can only ever change web-app code. Categories that describe the
// generation pipeline live in the worker repo — chapter detection, generated
// content quality, part chunking, generation failures — and an app-repo PR for
// one of those is doomed by construction. Live incident (run ee0fb99628f13098,
// issue 8b79d4e0): a generation_failed issue was dispatched anyway and produced
// junk PR #24. Extending autofix to the worker is Phase 2 — see docs/AUTOFIX.md.
//
// Category taxonomy: migration 0020_support_agent.sql. Deliberately NOT listed
// here: "video" / "deck_docs" / "quiz" — users (and report-failure.tsx) file
// both app-side player/viewer bugs and worker-side output bugs under those, so
// staff judgement stays in the loop there.
export const WORKER_SIDE_CATEGORIES: ReadonlySet<string> = new Set([
  "generation_failed", // auto-filed by the worker when a generation errors
  "wrong_chapter", // chapter detection / indexing — worker
  "poor_quality", // generated-content quality (prompts, models) — worker
  "missing_parts", // part estimation + chunking — worker
]);

export const WORKER_SCOPE_REFUSAL =
  "This is a generation-pipeline (worker) issue — autofix only covers the web app. Fix it in the worker repo.";

/** The refusal message when autofix must not dispatch for this category, else null. */
export function workerScopeRefusal(category: string | null | undefined): string | null {
  return category && WORKER_SIDE_CATEGORIES.has(category) ? WORKER_SCOPE_REFUSAL : null;
}
