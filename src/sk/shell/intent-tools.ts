// SK Shell — every rule intent's MODEL TOOL (model-first, 2026-10-30).
//
// In MODEL routing (routing.ts) the rules no longer act: every ability they
// had must be a tool the model can call. This file is the inventory. Each
// table is typed `Record<TheRuleUnion, …>`, so a new Board move, tutor move,
// parent / leader read, teacher action or page added to the rules without a
// tool here is a COMPILE error; intent-tools.test.ts then checks every tool
// named here exists in the registry and is open to the role that says it.

import type { NavTarget } from "@/sk/capabilities/navigate";
import type { LangCommand } from "./language";
import type { RulesDecision, SkActPhrase, SkLeaderCapability, SkParentCapability, SkTutorCapability } from "./rules";
import type { SkBoardMove, SkWalkAction } from "./types";

/** Board moves (rules: routeBoard) → board.* */
export const BOARD_MOVE_TOOLS = {
  intro: "board.intro",
  segment: "board.segment",
  slide: "board.slide",
  explain: "board.explain",
  compare: "board.compare",
  practise: "board.practise",
  walkthrough: "board.walkthrough",
  freeze: "board.freeze",
  blank: "board.blank",
  back: "board.back",
  resume: "board.resume",
  pause: "board.pause",
  recap: "board.recap",
  rail: "board.rail",
  load_slides: "board.load_slides",
  load_deck: "board.load_deck",
  explain_selection: "board.explain_selection",
  page: "board.page",
} as const satisfies Record<SkBoardMove, string>;

/** Teacher / leader action phrasings (rules: actPhraseOf) → the action's capability. */
export const ACT_TOOLS = {
  "diary.note": "diary.note",
  "parents.remind": "parents.remind",
  "marking.next": "marking.next",
  "marking.grade": "marking.grade",
  "lesson.prepare": "lesson.prepare",
  "notice.school": "notice.school",
} as const satisfies Record<SkActPhrase, string>;

/** Student tutor phrasings (rules: routeTutor) → tutor.* */
export const TUTOR_TOOLS = {
  "tutor.play": "tutor.play",
  "tutor.section": "tutor.section",
  "tutor.slide": "tutor.slide",
  "tutor.practise": "tutor.practise",
  "tutor.where": "tutor.where",
  "tutor.progress": "tutor.progress",
  "tutor.explain": "tutor.explain",
} as const satisfies Record<SkTutorCapability, string>;

/** Parent reads (rules: routeParent) → child.* */
export const PARENT_TOOLS = {
  "child.status": "child.status",
  "child.diary": "child.diary",
  "child.notices": "child.notices",
  "child.risk": "child.risk",
  "child.progress": "child.progress",
  "child.week": "child.week",
} as const satisfies Record<SkParentCapability, string>;

/** Leader reads (rules: routeLeader) → school.* and the leader-mode reads. */
export const LEADER_TOOLS = {
  "school.health": "school.health",
  "learners.risk": "learners.risk",
  "assignments.status": "assignments.status",
  "timetable.now_next": "timetable.now_next",
  "school.seats": "school.seats",
  "school.cost": "school.cost",
  "school.gaps": "school.gaps",
  "school.trend": "school.trend",
} as const satisfies Record<SkLeaderCapability, string>;

/** Every page the navigate rule opens → navigate (with its filters). */
export const NAV_TOOLS = {
  library: "navigate",
  analytics: "navigate",
  board: "navigate",
  diary: "navigate",
  school_diary: "navigate",
  calendar: "navigate",
  timetable: "navigate",
  kits: "navigate",
  reports: "navigate",
  school: "navigate",
  school_teachers: "navigate",
  school_access: "navigate",
  school_admin: "navigate",
  school_books: "navigate",
  children: "navigate",
} as const satisfies Record<NavTarget, string>;

/** The answer-language commands → the shell controls. */
export const LANG_TOOLS = {
  back: "set_answer_language",
  repeat: "repeat_in_language",
} as const satisfies Record<LangCommand["kind"], string>;

/** The tour: start it, and move a running one (also an instant pre-rule while it narrates). */
export const TOUR_TOOLS = {
  start: "start_tour",
  resume: "tour_control",
  next: "tour_control",
  back: "tour_control",
  pause: "tour_control",
  skip: "tour_control",
} as const satisfies Record<SkWalkAction, string>;

/** The tools a rules decision needs in model routing ([] = the model answers
 *  in words, e.g. "thanks"; a plain "ask" was always the model's). */
export function toolsForDecision(d: RulesDecision): string[] {
  switch (d.intent) {
    case "navigate": {
      // "play chapter 1 of biology" and "start the lesson (for 7B on …)": start_lesson
      // (with nothing named, the route plans it from the Board pick / timetable).
      if (d.lesson || (d.target === "board" && d.filters.autostart)) return ["start_lesson"];
      const out: string[] = [NAV_TOOLS[d.target]];
      if (d.classQuery || d.learnerQuery) out.unshift("context.resolve");
      if (d.kitQuery) out.unshift("library.find");
      return out;
    }
    case "chat":
      return [];
    case "teach":
      return [BOARD_MOVE_TOOLS[d.move]];
    case "act":
      return d.action === "book.activate" ? ["book.activate"] : [ACT_TOOLS[d.action]];
    case "tutor":
      return [TUTOR_TOOLS[d.capability]];
    case "lang":
      return [LANG_TOOLS[d.command.kind]];
    case "tour":
      return [TOUR_TOOLS.start];
    case "ask":
      if ("parent" in d && d.parent) return [PARENT_TOOLS[d.parent.capability]];
      if ("leader" in d && d.leader) return [LEADER_TOOLS[d.leader.capability]];
      return [];
    default:
      return [];
  }
}

/** Every tool the inventory names (for the registry check). */
export const ALL_INTENT_TOOLS: readonly string[] = [
  ...new Set([
    ...Object.values(BOARD_MOVE_TOOLS),
    ...Object.values(ACT_TOOLS),
    "book.activate",
    ...Object.values(TUTOR_TOOLS),
    ...Object.values(PARENT_TOOLS),
    ...Object.values(LEADER_TOOLS),
    ...Object.values(NAV_TOOLS),
    "context.resolve",
    "library.find",
    "start_lesson",
    ...Object.values(LANG_TOOLS),
    ...Object.values(TOUR_TOOLS),
  ]),
];
