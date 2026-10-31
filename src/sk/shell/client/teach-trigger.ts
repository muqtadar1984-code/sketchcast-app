// SK STARTS TEACHING BY ITSELF (student Board phase 3, 2026-10-31) — the
// browser side of two of the three triggers (the third, her confusion in
// conversation, is decided on the server: learn-teach.ts confusionOf).
//
//   sk:learner-gap   the Board's worksheet practice (phase 2) dispatches it
//                    when she answers wrong twice or asks for help:
//                    detail { generationId, questionId, questionText, concept,
//                    attempts, lastAnswer, reason: "wrong_twice" | "asked_help" }
//                    → SK sends a teaching turn (`teach: {trigger: "gap", …}`).
//   sk:learner-done  she finished the kit (the coach's last step, or phase 2
//                    when every question is answered): detail { generationId }
//                    → SK OFFERS one short Extra step in the chat (dismissable);
//                    "yes" sends `teach: {trigger: "extra"}`.
//
// Only while HER Board is open (a student with the Board bridge): the Shell
// subscribes then, and the server re-checks (studentOnBoard) anyway.
//
// PURE apart from the event names: the Shell does the listening.

import { parseTeachRequest, type SkTeachRequest } from "../learn-teach";

export const SK_LEARNER_GAP_EVENT = "sk:learner-gap";
export const SK_LEARNER_DONE_EVENT = "sk:learner-done";

/** The gap event's detail → a teaching request; null when it carries nothing to teach. */
export function gapRequest(detail: unknown): SkTeachRequest | null {
  if (!detail || typeof detail !== "object") return null;
  return parseTeachRequest({ ...(detail as Record<string, unknown>), trigger: "gap" });
}

/** The Extra step's request after the kit (the open lesson names the concept server-side). */
export function extraRequest(detail: unknown): SkTeachRequest {
  const g = detail && typeof detail === "object" ? (detail as Record<string, unknown>).generationId : undefined;
  return parseTeachRequest({ trigger: "extra", ...(typeof g === "string" ? { generationId: g } : {}) }) ?? { trigger: "extra" };
}

/** Same question within this window = the same gap (a double dispatch, a
 *  re-render): SK teaches it once. */
export const GAP_REPEAT_MS = 90_000;

/** A small memory of the gaps SK already took, so one stuck moment is one lesson. */
export function createGapGate(windowMs = GAP_REPEAT_MS) {
  const seen = new Map<string, number>();
  return {
    /** True when this gap should start a lesson now (and remembers it). */
    take(req: SkTeachRequest, now: number): boolean {
      const key = `${req.generationId ?? ""}|${req.questionId ?? req.questionText ?? req.concept ?? ""}`;
      for (const [k, at] of seen) if (now - at > windowMs) seen.delete(k);
      const at = seen.get(key);
      if (at !== undefined && now - at <= windowMs) return false;
      seen.set(key, now);
      return true;
    },
  };
}

/** The Extra offer is made once per lesson (generation) per tab. */
export function createDoneGate() {
  const offered = new Set<string>();
  return {
    take(detail: unknown): boolean {
      const g = detail && typeof detail === "object" ? (detail as Record<string, unknown>).generationId : undefined;
      const key = typeof g === "string" && g ? g : "-";
      if (offered.has(key)) return false;
      offered.add(key);
      return true;
    },
  };
}
