// The five role tours, as EDITABLE DATA. This is the only file the team
// (Muqtadar/Sara) edits to change what the tour DOES — which element a step
// points at, in what order, on which screen. The engine never changes.
//
// What a step SAYS lives in the message files instead (`app.tour.<tourKey>.<stepId>`
// in src/i18n/messages/*.json), because the tour is read by parents and students
// in ten languages. Editing copy is editing en.json; adding a step is adding an
// entry here AND its title/body there. To re-show a tour to everyone after a
// material change, bump its `version`.
//
// Every `target` is a dedicated `data-tour="..."` marker on the real UI element
// (see the markers added across the dashboard screens). A missing target is
// skipped gracefully at runtime — never a frozen or empty spotlight.

import type { Role, TourDefinition, TourStep } from "./types";

/** A step without its words — the shape this file authors. */
type StepDef = Omit<TourStep, "title" | "body">;

/** A tour without its words. */
type Definition = Omit<TourDefinition, "steps"> & { steps: StepDef[] };

/** The tour slice of a dictionary: tour key → step id → its two sentences.
 * Deliberately loose (plain Records) so this module stays dependency-free and
 * importable from the tests, the client provider and a server layout alike. */
export type TourCopy = Record<string, Record<string, { title: string; body: string }>>;

const teacher: Definition = {
  key: "teacher_onboarding",
  role: "teacher",
  version: 1,
  homePath: "/dashboard",
  steps: [
    { id: "library", target: '[data-tour="book-card"]', order: 1, placement: "bottom" },
    { id: "generate", target: '[data-tour="generate-lesson"]', order: 2, placement: "left" },
    { id: "output", target: '[data-tour="lesson-output"]', order: 3, placement: "top" },
    { id: "assign", target: '[data-tour="assign-chapter"]', order: 4, placement: "top" },
    { id: "assistant", target: '[data-tour="assistant"]', order: 5, placement: "left" },
    { id: "classes", target: '[data-tour="classes"]', order: 6, placement: "bottom" },
  ],
};

const student: Definition = {
  key: "student_onboarding",
  role: "student",
  version: 1,
  homePath: "/dashboard",
  steps: [
    { id: "assignments", target: '[data-tour="assignments"]', order: 1, placement: "bottom" },
    { id: "open", target: '[data-tour="open-lesson"]', order: 2, placement: "top" },
    { id: "assistant", target: '[data-tour="assistant"]', order: 3, placement: "left" },
    { id: "progress", target: '[data-tour="progress"]', order: 4, placement: "top" },
  ],
};

const parent: Definition = {
  key: "parent_onboarding",
  role: "parent",
  version: 1,
  homePath: "/dashboard/children",
  steps: [
    { id: "assignments", target: '[data-tour="child-assignments"]', order: 1, placement: "bottom" },
    { id: "recap", target: '[data-tour="progress-recap"]', order: 2, placement: "top" },
    { id: "practice", target: '[data-tour="test-papers-nav"]', order: 3, placement: "bottom" },
  ],
};

// NOTE: kept entirely on /dashboard (where a school admin lands, wearing their
// teacher hat) so the whole tour runs on one screen. The "School" nav tab is the
// jump-off to the school-management area. Refine as the admin surface evolves.
const schoolAdmin: Definition = {
  key: "school_admin_onboarding",
  role: "school_admin",
  version: 1,
  homePath: "/dashboard",
  steps: [
    { id: "school", target: '[data-tour="school-nav"]', order: 1, placement: "bottom" },
    { id: "branding", target: '[data-tour="branding"]', order: 2, placement: "top" },
    { id: "health", target: '[data-tour="book-health"]', order: 3, placement: "left" },
    { id: "classes", target: '[data-tour="classes"]', order: 4, placement: "bottom" },
  ],
};

// TODO: refine coordinator tour — its day-to-day scope is still being defined
// (needs product input). Minimal 3-step welcome for now.
const coordinator: Definition = {
  key: "coordinator_onboarding",
  role: "coordinator",
  version: 1,
  homePath: "/dashboard",
  steps: [
    { id: "welcome", target: "", order: 1 },
    { id: "oversight", target: '[data-tour="classes"]', order: 2, placement: "bottom" },
    { id: "help", target: '[data-tour="tour-replay"]', order: 3, placement: "bottom" },
  ],
};

export const TOURS: Record<Role, Definition> = {
  teacher,
  student,
  parent,
  school_admin: schoolAdmin,
  coordinator,
};

/** The tour for a role, or null (unknown role → no tour, never a crash). Steps
 * are returned pre-sorted by `order` so definitions can be written in any order,
 * and carry the words from `copy` — a step the dictionary doesn't cover comes
 * back with empty text, which the engine renders as a bare popover rather than
 * crashing. Omit `copy` when you only need the tour's shape (its key, version or
 * home path), as the dashboard layout does. */
export function tourForRole(role: string | null | undefined, copy?: TourCopy): TourDefinition | null {
  if (!role) return null;
  const def = TOURS[role as Role];
  if (!def) return null;
  const words = copy?.[def.key];
  const steps: TourStep[] = def.steps
    .map((s) => ({ ...s, title: words?.[s.id]?.title ?? "", body: words?.[s.id]?.body ?? "" }))
    .sort((a, b) => a.order - b.order);
  return { ...def, steps };
}
