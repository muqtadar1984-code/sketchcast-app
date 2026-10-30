// SK's own onboarding tour (Final Plan 2026-10-28 §4.6): on a role's first
// visit SK introduces itself and shows the role round. Seen-state lives in
// `user_tour_progress` under this key, exactly like the five driver.js tours,
// so `shouldAutoStart(seen, version)` from src/tour/logic.ts is the one rule
// that decides whether it plays: never seen → play; seen an OLDER version →
// play again; same version → silent. Bump `version` after a material change
// and every user sees it once more.
//
// v1 (2026-10-28): the narration only — the driver.js sentences read into the
//   transcript, no highlights, once the panel was opened.
// v2 (2026-10-30, founder decision 9): the first-login WALKTHROUGH
//   (sk-walkthrough.tsx) — per-role stops, page by page, highlighted, from the
//   home hero. Bumped so everyone who heard v1 (the founder, Sara, her student)
//   gets it once. Replays ("Show me around", "Take the tour") never write it.
//
// SERVER-SAFE on purpose (no "use client", no DOM): the dashboard layout reads
// the seen row by `key` and compares against `version` on the server, and the
// client posts the same pair to /api/tour/seen when the first-login run ends.
// A constant a server layout needs can never live in a client module (see
// src/__tests__/server-client-boundary.test.ts).

export const SK_INTRO_TOUR = { key: "sk-intro", version: 2 } as const;
