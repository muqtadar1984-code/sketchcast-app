// The five role tours, as EDITABLE DATA. This is the only file the team
// (Muqtadar/Sara) edits to change what the tour says or does — the engine never
// changes. Copy here is a SHORT, JARGON-FREE, BENEFIT-FIRST PLACEHOLDER: refine
// freely. To re-show a tour to everyone after a material change, bump its `version`.
//
// Every `target` is a dedicated `data-tour="..."` marker on the real UI element
// (see the markers added across the dashboard screens). A missing target is
// skipped gracefully at runtime — never a frozen or empty spotlight.

import type { Role, TourDefinition } from "./types";

const teacher: TourDefinition = {
  key: "teacher_onboarding",
  role: "teacher",
  version: 1,
  homePath: "/dashboard",
  steps: [
    { id: "library", target: '[data-tour="book-card"]', order: 1, placement: "bottom", title: "Your library", body: "Every textbook you upload lives here. Open one to turn its chapters into lessons." },
    { id: "generate", target: '[data-tour="generate-lesson"]', order: 2, placement: "left", title: "Turn a chapter into a lesson", body: "Pick a chapter and generate a full narrated video lesson from it — automatically." },
    { id: "output", target: '[data-tour="lesson-output"]', order: 3, placement: "top", title: "Watch & download", body: "Play the finished lesson, or download the editable slide deck and worksheets." },
    { id: "assign", target: '[data-tour="assign-chapter"]', order: 4, placement: "top", title: "Assign to a class", body: "Share a chapter's lesson, worksheet and quiz with your students in one click." },
    { id: "assistant", target: '[data-tour="assistant"]', order: 5, placement: "left", title: "AI Teaching Assistant", body: "A book-grounded helper — ask it anything from your books, and it can check maths too." },
    { id: "classes", target: '[data-tour="classes"]', order: 6, placement: "bottom", title: "Your classes", body: "Create classes and add students to start tracking their progress." },
  ],
};

const student: TourDefinition = {
  key: "student_onboarding",
  role: "student",
  version: 1,
  homePath: "/dashboard",
  steps: [
    { id: "assignments", target: '[data-tour="assignments"]', order: 1, placement: "bottom", title: "Your work", body: "Everything your teacher assigns you shows up right here." },
    { id: "open", target: '[data-tour="open-lesson"]', order: 2, placement: "top", title: "Watch a lesson", body: "Open a lesson to watch the video or read through the slides." },
    { id: "assistant", target: '[data-tour="assistant"]', order: 3, placement: "left", title: "Ask the Assistant", body: "Stuck on something? Ask the AI assistant — it answers from your own books." },
    { id: "progress", target: '[data-tour="progress"]', order: 4, placement: "top", title: "Your progress", body: "See what you've finished and what's still to do." },
  ],
};

const parent: TourDefinition = {
  key: "parent_onboarding",
  role: "parent",
  version: 1,
  homePath: "/dashboard/children",
  steps: [
    { id: "assignments", target: '[data-tour="child-assignments"]', order: 1, placement: "bottom", title: "Your child's work", body: "See what each child has been assigned and how they're getting on." },
    { id: "recap", target: '[data-tour="progress-recap"]', order: 2, placement: "top", title: "Progress & recap", body: "Track completion and scores at a glance — no guesswork." },
    { id: "practice", target: '[data-tour="test-papers-nav"]', order: 3, placement: "bottom", title: "Make extra practice", body: "Create practice papers for your child anytime under Test Papers." },
  ],
};

// NOTE: kept entirely on /dashboard (where a school admin lands, wearing their
// teacher hat) so the whole tour runs on one screen. The "School" nav tab is the
// jump-off to the school-management area. Refine as the admin surface evolves.
const schoolAdmin: TourDefinition = {
  key: "school_admin_onboarding",
  role: "school_admin",
  version: 1,
  homePath: "/dashboard",
  steps: [
    { id: "school", target: '[data-tour="school-nav"]', order: 1, placement: "bottom", title: "Manage your school", body: "Open your school area to add teachers, students and classes." },
    { id: "branding", target: '[data-tour="branding"]', order: 2, placement: "top", title: "School branding", body: "Add your school's logo and colours to every lesson and document." },
    { id: "health", target: '[data-tour="book-health"]', order: 3, placement: "left", title: "Book health", body: "A quick quality score shows which textbooks are ready to teach from." },
    { id: "classes", target: '[data-tour="classes"]', order: 4, placement: "bottom", title: "Classes & students", body: "Create classes and enrol students to track their progress." },
  ],
};

// TODO: refine coordinator tour — its day-to-day scope is still being defined
// (needs product input). Minimal 3-step welcome for now.
const coordinator: TourDefinition = {
  key: "coordinator_onboarding",
  role: "coordinator",
  version: 1,
  homePath: "/dashboard",
  steps: [
    { id: "welcome", target: "", order: 1, title: "Welcome to SketchCast", body: "Here's a quick 30-second look at what you can do as a coordinator." },
    { id: "oversight", target: '[data-tour="classes"]', order: 2, placement: "bottom", title: "What you oversee", body: "The classes and teachers in your remit will appear in this area." },
    { id: "help", target: '[data-tour="tour-replay"]', order: 3, placement: "bottom", title: "Need a hand?", body: "Replay this tour anytime with this button — and you can always report a problem." },
  ],
};

export const TOURS: Record<Role, TourDefinition> = {
  teacher,
  student,
  parent,
  school_admin: schoolAdmin,
  coordinator,
};

/** The tour for a role, or null (unknown role → no tour, never a crash). Steps
 * are returned pre-sorted by `order` so definitions can be written in any order. */
export function tourForRole(role: string | null | undefined): TourDefinition | null {
  if (!role) return null;
  const def = TOURS[role as Role];
  if (!def) return null;
  return { ...def, steps: [...def.steps].sort((a, b) => a.order - b.order) };
}
