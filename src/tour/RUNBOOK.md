# Onboarding Product Tour — RUNBOOK

A first-run, role-aware coach-mark tour (spotlight + one-line tooltip → clear
first action) for all five roles, built as **one config-driven engine**. The three
load-bearing decisions — **content-as-data**, **library-behind-a-wrapper**, and
**versioned seen-state** — are what let it scale by editing data, not code.

## Files
| File | What it is |
|---|---|
| `src/tour/types.ts` | `TourStep` / `TourDefinition` / event + seen types |
| `src/tour/definitions.ts` | **the five tours as DATA** — the only file you edit for content |
| `src/tour/logic.ts` | pure gate + missing-target logic (unit-tested) |
| `src/tour/engine.ts` | the **only** file that imports the library (driver.js) — swap here |
| `src/tour/TourProvider.tsx` | runtime: auto-start, replay, skip-on-missing, telemetry |
| `src/tour/analytics.ts` | `emitTourEvent()` — the single swappable telemetry seam |
| `src/app/api/tour/{event,seen}/route.ts` | record events / seen-state (RLS user-scoped) |
| `supabase/migrations/0037_onboarding_tour.sql` | `user_tour_progress` + `tour_events` |
| `src/app/dashboard/tour-replay-button.tsx` | the permanent "🧭 Tour" control (in the header) |

The launcher is mounted once in `src/app/dashboard/layout.tsx` (wraps every dashboard page).

## Enable it (flag + migration)
1. Run migration **0037** in Supabase.
2. Set **`NEXT_PUBLIC_FEATURE_TOUR=true`** on Vercel and redeploy (client flag → baked at build time).
   Off by default → the tour and the replay button are entirely absent (dark-launch safe).

## Add a STEP  *(config edit only)*
In `definitions.ts`, push to a role's `steps` array:
```ts
{ id: "assign", target: '[data-tour="assign-chapter"]', order: 4,
  placement: "top", title: "Assign to a class", body: "One short, jargon-free line." }
```
Then add the marker to the real element: `data-tour="assign-chapter"`. Missing marker
→ the step is **skipped gracefully** and a `tour_step_target_missing` event is logged
(never a frozen or empty spotlight). Use `target: ""` for a centered, no-highlight step.

## Add a ROLE  *(config edit only)*
1. Add a `TourDefinition` in `definitions.ts` and register it in `TOURS`.
2. Set its `homePath` to the screen the tour runs on, and add `data-tour` markers there.
No engine change. (The `Role` union in `types.ts` is the one type to extend for a brand-new role.)

## Bump a VERSION (re-show an improved tour to everyone)
Increase the definition's `version` (e.g. `version: 1 → 2`). Anyone who completed/skipped
v1 auto-sees v2 on their next visit to the home screen; v2-completers won't see it again.
(Logic: `shouldAutoStart` — auto-start when unseen OR stored version < current.)

## Read drop-off analytics
Events land in `tour_events` (read with the service role / console). Drop-off per tour:
```sql
select tour_key, version, event, count(*)
from public.tour_events
group by 1, 2, 3
order by 1, 2, 3;
-- Funnel: started → step_viewed(index) → completed. Where step_viewed drops between
-- indexes = where people quit. tour_skipped.meta->>'at_step' = the exact quit step.
```

## Swap the tour library
Rewrite `engine.ts` (`createDriverEngine` → the `TourEngine` interface) for shepherd.js
or another engine. `definitions.ts`, `TourProvider`, and every call site are untouched.

## Known TODOs / placeholders
- **Copy** in `definitions.ts` is a short, benefit-first **placeholder** — refine with Muqtadar/Sara.
- **Coordinator** tour is a minimal 3-step welcome, flagged `// TODO: refine` (scope still being defined).
- Marker inventory currently placed: `book-card, generate-lesson, lesson-output, assign-chapter,
  classes, branding, book-health, school-nav, assistant, assignments, open-lesson, progress,
  child-assignments, progress-recap, test-papers-nav, tour-replay`. Add more as the UI evolves —
  the engine handles any that are absent.
- A first-time teacher with an empty library will see a shorter tour (generate/output/assign markers
  don't exist yet) — by design; it fills in as they use the product.
