// The SK capability registry (Final Plan §9.7). One list: every tool and
// action SK can ever call is an entry here, and the permission-matrix suite
// is generated from this list, so a new entry is covered the moment it is
// added. Slice C's knowledge tools (library.find, assignments.status,
// learners.risk, timetable.now/next) join by appending to ENTRIES.

import type { SkCapability } from "@/sk/shell/types";
import { navigateCapability } from "./navigate";
import { resolveCapability } from "./resolve";

const ENTRIES: SkCapability[] = [navigateCapability, resolveCapability];

export const REGISTRY: SkCapability[] = ENTRIES;

export { navigateCapability, resolveCapability };
