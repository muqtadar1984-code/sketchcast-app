// The onboarding-tour data model. A tour is DATA: adding a step is a push to an
// array, adding a role is a new array — the engine never changes. Keep this file
// dependency-free so definitions + tests import it without pulling in the library.

export type Role = "teacher" | "student" | "parent" | "school_admin" | "coordinator";

export type TourStep = {
  /** Stable id — used in analytics and to keep step identity across edits. */
  id: string;
  /** CSS selector for a dedicated `data-tour` marker, e.g. `[data-tour="generate-lesson"]`.
   *  Empty string → a centered popover with no highlighted element (e.g. a welcome step). */
  target: string;
  title: string;
  /** One or two short, jargon-free sentences. */
  body: string;
  placement?: "top" | "bottom" | "left" | "right" | "auto";
  order: number;
};

export type TourDefinition = {
  /** e.g. "teacher_onboarding". */
  key: string;
  role: Role;
  /** Bump to re-show the tour to everyone after a material change (Section 8). */
  version: number;
  /** The route the tour lives on. Auto-start is deferred until the user is here. */
  homePath: string;
  steps: TourStep[];
};

export type TourEventName =
  | "tour_started"
  | "tour_step_viewed"
  | "tour_skipped"
  | "tour_step_target_missing"
  | "tour_completed";

/** One analytics event, always tagged with role + tour_key + version so drop-off
 * can be sliced by any of them. */
export type TourEvent = {
  event: TourEventName;
  tourKey: string;
  role: Role;
  version: number;
  meta?: Record<string, unknown>;
};

/** Seen-state the server hands the client so it can decide whether to auto-start.
 * `version` is the version the user last completed/skipped (null = never seen). */
export type TourSeen = { version: number | null; status: "completed" | "skipped" | null };
