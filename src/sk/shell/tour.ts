// SK's own onboarding tour (Final Plan 2026-10-28 §4.6): on a role's first
// visit SK introduces itself, narrates the role tour's steps and offers the
// first task. Seen-state lives in `user_tour_progress` under this key, exactly
// like the five driver.js tours, so `shouldAutoStart(seen, version)` from
// src/tour/logic.ts is the one rule that decides whether it plays: never
// seen → play; seen an OLDER version → play again; same version → silent.
// Bump `version` after a material change to the narration and every user
// hears it once more.
//
// SERVER-SAFE on purpose (no "use client", no DOM): the dashboard layout reads
// the seen row by `key` and compares against `version` on the server, and the
// client panel posts the same pair to /api/tour/seen when the narration ends.
// A constant a server layout needs can never live in a client module (see
// src/__tests__/server-client-boundary.test.ts).

export const SK_INTRO_TOUR = { key: "sk-intro", version: 1 } as const;
