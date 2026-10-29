// SK S5 slice E — the §8.4 leader gate bank's shapes. Not a test file.

import type { GateUserKey } from "./tenant";

export type GateLang = "en" | "ms" | "ar";

export type GateCategory =
  | "health"
  | "at_risk"
  | "teacher_flags"
  | "seats"
  | "cost"
  | "gaps"
  | "trend"
  | "assignments"
  | "timetable"
  | "notices";

/** What the SCRIPTED model does if the turn reaches the model (no network).
 *  `calls` are made in the first round; the answer is `say`, where
 *  `{summary}` is replaced by the FIRST tool result's summary (an honest
 *  model that quotes its tool) and anything else is said verbatim (for the
 *  unsupported bank: a deliberate fabrication the deterministic guards must
 *  stop). The live run ignores this and asks the real model. */
export type GateScript = { calls?: Array<{ name: string; args?: Record<string, unknown> }>; say: string };

/** One grounded question: the capability that must answer it and the facts
 *  (from the seeded tenant) the answer must carry. */
export type GroundedItem = {
  id: string;
  suite: "grounded";
  as: GateUserKey;
  lang: GateLang;
  category: GateCategory;
  text: string;
  expect: {
    /** Any of these capabilities answering is the right choice. */
    capability: string[];
    /** Tokens the answer must contain (case-insensitive), each traceable to the tool facts. */
    mustSay: string[];
    /** A click-only confirm card for this action must be issued (notices). */
    card?: string;
  };
  /** "rules" = the deterministic leader route answers (no model call); "model" = the model chooses. */
  path: "rules" | "model";
  scripted?: GateScript;
};

/** How an unsupported ask may be answered without inventing anything. */
export type RefusalAccept =
  /** done.label === "declined" (SK_NOTHING_ON_THAT or a fixed refusal line). */
  | "declined"
  /** The capability's own "outside your scope" / "no scope" line. */
  | "out_of_scope"
  /** school.seats' "No seat limit is recorded for your school yet." */
  | "no_seat_limit"
  /** The principal-only line for licence / seat figures. */
  | "principal_only"
  /** A click-only school-notice card instead of the asked-for email (nothing sent). */
  | "notice_card";

export type UnsupportedItem = {
  id: string;
  suite: "unsupported";
  as: GateUserKey;
  lang: GateLang;
  text: string;
  /** Why it is unsupported (shown in the report). */
  why: string;
  accept: RefusalAccept[];
  /** Extra strings this answer must never contain (beyond the tenant's forbidden set). */
  forbid?: string[];
  path: "rules" | "model";
  scripted?: GateScript;
};

export type GateItem = GroundedItem | UnsupportedItem;
