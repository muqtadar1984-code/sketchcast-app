// The SK capability registry (Final Plan §9.7). One list: every tool and
// action SK can ever call is an entry here, and the permission-matrix suite
// is generated from this list, so a new entry is covered the moment it is
// added. Slice C's knowledge tools (library.find, assignments.status,
// learners.risk, timetable.now/next) join by appending to ENTRIES.

import type { SkCapability } from "@/sk/shell/types";
import { navigateCapability } from "./navigate";
import { resolveCapability } from "./resolve";
import { catalogueAvailability, libraryFind } from "./library";
import { assignmentsStatus } from "./assignments";
import { learnersRisk } from "./risk";
import { timetableNowNext } from "./timetable";
import { BOARD_CAPABILITIES } from "./board";
import { assignAction } from "./assign";
import { diaryNoteAction } from "./diary";
import { parentsRemindAction } from "./remind";
import { markingGrade, markingNext } from "./marking";
import { lessonPrepareAction, lessonStatus } from "./prepare";
import { TUTOR_CAPABILITIES } from "./tutor";
// S4 slices A+B: the parent reads (child.*).
import { PARENT_CAPABILITIES } from "./parent";
import { bookActivateAction } from "./book";

const ENTRIES: SkCapability[] = [
  navigateCapability,
  resolveCapability,
  // Teacher knowledge tools v1 (slice C): every one reads through the
  // user-session client and scopes to the teacher's own classes.
  libraryFind,
  catalogueAvailability,
  assignmentsStatus,
  learnersRisk,
  timetableNowNext,
  // S1 slice B: the Classroom Board moves (board.intro … board.recap), all
  // immediate tier, visible only with Board access and the teacher hat.
  ...BOARD_CAPABILITIES,
  // S1 slice D: `assign`, the first confirm-tier action (card + token; the
  // write happens only in /api/sk/act through sk_assign_with_token, 0164).
  assignAction,
  // S2 slice A: teacher actions that write AS THE TEACHER (consume via the
  // admin RPC, then a user-session insert carrying sk_action_id, 0169).
  diaryNoteAction,
  parentsRemindAction,
  // S2 slice B: the marking queue (read + grade) and lesson prep (click-only,
  // spends credits) with its status read.
  markingNext,
  markingGrade,
  lessonPrepareAction,
  lessonStatus,
  // S3 slice D: the STUDENT entries (tutor.*), student role only, all
  // immediate: moves on her own kit player and reads of her own progress.
  ...TUTOR_CAPABILITIES,
  // S4 slices A+B: the PARENT reads (child.status, child.diary, child.notices,
  // child.risk, child.progress, child.week), parent role only, all immediate:
  // scoped to the parent's own VERIFIED children (child-scope.ts).
  ...PARENT_CAPABILITIES,
  // S4 slice D: book activation (student for herself, parent for a verified
  // child), confirm tier and CLICK-ONLY (it spends a code; act-book.ts).
  bookActivateAction,
];

export const REGISTRY: SkCapability[] = ENTRIES;

export { navigateCapability, resolveCapability, libraryFind, catalogueAvailability, assignmentsStatus, learnersRisk, timetableNowNext, BOARD_CAPABILITIES, assignAction, diaryNoteAction, parentsRemindAction, markingNext, markingGrade, lessonPrepareAction, lessonStatus, TUTOR_CAPABILITIES, bookActivateAction };
export { PARENT_CAPABILITIES };
