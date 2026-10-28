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
];

export const REGISTRY: SkCapability[] = ENTRIES;

export { navigateCapability, resolveCapability, libraryFind, catalogueAvailability, assignmentsStatus, learnersRisk, timetableNowNext, BOARD_CAPABILITIES, assignAction };
