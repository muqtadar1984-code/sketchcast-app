// What happens AFTER a practice answer has been answered (SK student Board
// plan 2026-10-31, phase 4). Server only; the answer route runs it with
// next/server `after()`, so her reply never waits for it.
//
//   * her FIRST answer on a worksheet in a session → tag the worksheet's
//     questions with concepts (concepts.ts: cache, paper, lesson map, ONE
//     Haiku call per worksheet ever);
//   * the worksheet FINISHED in this session (every question right, sent for
//     marking, or taken to the answer rung) → tag (cheap: cached) and draft
//     the recommended plan for the kit (plan-store.ts), unless
//     SK_LEARN_PLANS=off. One open plan per student per kit, so finishing the
//     same worksheet again does not draft a second.
// Never throws.

import type { RawQuiz } from "@/app/api/quiz/logic";
import type { KitManifest } from "@/sk/manifest/derive";
import type { SkDb } from "@/sk/store-supabase";
import type { HelpModelCall } from "./help";
import { tagWorksheet } from "./concepts";
import { draftPlan, learnPlansOn, worksheetProgress, type DraftOutcome } from "./plan-store";

export type AfterInput = {
  db: SkDb;
  studentId: string;
  sessionId: string;
  kitId: string;
  generationId: string;
  paper: RawQuiz | null;
  kitTitle: () => Promise<string>;
  loadManifest: () => Promise<KitManifest | null>;
  call: HelpModelCall | null;
  log?: (m: string) => void;
};

export async function afterPracticeAnswer(o: AfterInput): Promise<{ tagged: boolean; plan: DraftOutcome | null }> {
  try {
    if (!o.paper?.questions?.length) return { tagged: false, plan: null };
    const ids = o.paper.questions.map((q) => String(q.id));
    const prog = await worksheetProgress(o.db, o.sessionId, o.generationId, ids);
    if (!prog.first && !prog.finished) return { tagged: false, plan: null };
    const kitTitle = await o.kitTitle().catch(() => "");
    await tagWorksheet({ db: o.db, loadManifest: o.loadManifest, call: o.call, kitTitle, log: o.log }, o.generationId, o.paper);
    if (!prog.finished || !learnPlansOn()) return { tagged: true, plan: null };
    const plan = await draftPlan({ db: o.db, call: o.call, log: o.log }, { studentId: o.studentId, kitId: o.kitId, trigger: "kit_done" });
    o.log?.(`sk-learn.plan kit_done ${plan.outcome}`);
    return { tagged: true, plan };
  } catch (e) {
    o.log?.(`sk-practice.after failed: ${(e as Error).message}`);
    return { tagged: false, plan: null };
  }
}
