// SK S3 slice C — marking a kit item on the server: the attempt is RECORDED
// (item_attempts, with objective_key), the kit objective's mastery is
// recomputed (sk_objective_mastery, rule sk-b5.1), and a wrong answer gets the
// next rung of the remediation ladder (./remediation.ts). Server only.
//
// KIT SESSIONS IN sk_sessions. item_attempts needs a session row (session_id
// is a NOT NULL foreign key, and its uniqueness is per session). The kit path
// has no teaching graph, so it reuses sk_sessions as it stands (no migration):
//   product_id = "kit:<generation id>"   (the column is free text — the graph
//                path stores a book slug there, which never has a colon, so a
//                kit session can never be found, resumed or closed by the loop)
//   chapter    = the chapter ref when it is a whole number ≥ 1, else 1
//   machine    = initialMachine() — inert: no graph, no open check
// and keeps the table's rule: one OPEN row per student × kit × chapter,
// reused on every answer (findSession → else createSession).
//
// ATTEMPTS. The attempt number is the SERVER's: one more than the attempts
// stored on this item in this session (a client's attemptNo is ignored). At
// most MAX_ATTEMPTS; after a right answer, a teacher-marked one, or the last
// try, a new answer is refused (409). Grading runs once per (item, attempt):
// the request is claimed under its eventId in sk_events (a repeat replays the
// stored reply) and item_attempts' UNIQUE (session_id, item_id, attempt_no)
// stops a second, different eventId racing for the same attempt — it is then
// recounted and marked as the next attempt.
//
// MASTERY. Every kit item answered is a ONE-ITEM check (purpose "unit",
// check_key = the event of the item's first attempt) on its objective: right
// at attempt 1 with no rung served = independent → mastered; right after a
// rung (a hint) or on a later try = assisted → provisional; wrong on the last
// try = needs_work. The latest finished check decides (sk-b5.1, unchanged),
// so the ladder's check question can lift a needs_work. Unmapped items (no
// objective key) are recorded with objective_key null and write no mastery.

import { GRADE_RULE_VERSION, gradeItem, MAX_ATTEMPTS } from "./grade";
import type { ItemBank } from "./items";
import { stripItem } from "./items";
import type { KitGrade, KitPractiseItem, KitRung } from "./kit-player";
import { kitItemIds } from "./kit-view";
import type { KitManifest } from "./manifest/derive";
import type { RemediationBank } from "./remediation-bank";
import { chosenKeyOf, ladderHistory, remediation } from "./remediation";
import { initialMachine } from "./state";
import { DuplicateAttemptError, withEvent, type Attempt, type SessionStore, type SkSession } from "./store";

export const KIT_SESSION_PREFIX = "kit:";

export const kitSessionProduct = (generationId: string) => `${KIT_SESSION_PREFIX}${generationId}`;

export function kitSessionChapter(chapterRef: string): number {
  const n = /^\d{1,6}$/.test(chapterRef) ? Number(chapterRef) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** The student's open kit session, created on first use. */
export async function openKitSession(store: SessionStore, studentId: string, generationId: string, chapterRef: string): Promise<SkSession> {
  const productId = kitSessionProduct(generationId);
  const chapter = kitSessionChapter(chapterRef);
  const found = await store.findSession(studentId, productId, chapter);
  if (found) return found;
  try {
    return await store.createSession({
      studentId,
      productId,
      chapter,
      graphVersion: 1,
      machine: initialMachine({ graphVersion: 1, unitKey: "", assetId: productId, segmentId: "", t: 0 }),
      mastery: {},
      history: [],
    });
  } catch (e) {
    // Two first answers at once: the one-open-session index refused the second.
    const again = await store.findSession(studentId, productId, chapter);
    if (again) return again;
    throw e;
  }
}

export type KitAnswerReply = { status: 200; body: KitGrade } | { status: 409; body: { error: string; reason: "no_tries" } };

export type KitAnswerInput = {
  store: SessionStore;
  items: ItemBank;
  bank: RemediationBank;
  manifest: KitManifest;
  session: SkSession;
  itemId: string;
  eventId: string;
  response: unknown;
  now: () => number;
};

const FINISHED = (a: Attempt) => a.outcome === "correct" || a.outcome === "needs_review";

/** Mark one answer, once per eventId (a repeat returns the stored reply). */
export async function markKitAnswer(input: KitAnswerInput): Promise<{ reply: KitAnswerReply; replayed: boolean }> {
  const { result, replayed } = await withEvent(input.store, input.session.id, input.eventId, "kit_answer", () => markOnce(input));
  return { reply: result, replayed };
}

async function markOnce(input: KitAnswerInput, round = 0): Promise<KitAnswerReply> {
  const { store, session, itemId, manifest } = input;
  const all = await store.listAttempts(session.id);
  const mine = all.filter((a) => a.itemId === itemId).sort((a, b) => a.attemptNo - b.attemptNo);
  if (mine.some(FINISHED) || mine.length >= MAX_ATTEMPTS) return { status: 409, body: { error: "No tries left on this question.", reason: "no_tries" } };
  const attemptNo = mine.length + 1;

  const item = await input.items.get(itemId);
  if (!item) throw new Error(`kit item ${itemId} is not in the bank`);
  const facts = await input.bank.facts(itemId);
  // The check question must be a different item, not one already finished in this session.
  const exclude = new Set(all.filter((a) => a.itemId !== itemId && (FINISHED(a) || a.attemptNo >= MAX_ATTEMPTS)).map((a) => a.itemId));
  const objectiveKeys = facts ? await input.bank.objectiveKeys([...kitItemIds(manifest)]) : {};
  const ladderOpts = { exclude, objectiveKeys };
  const served = facts ? ladderHistory(facts, mine.map((a) => chosenKeyOf(facts, a.response)), manifest, ladderOpts) : [];

  const grade = gradeItem(item, input.response, { attemptNo, hintsUsed: served.length });
  const objectiveKey = facts?.objectiveKey ?? null;
  try {
    await store.putAttempt({
      sessionId: session.id,
      eventId: input.eventId,
      itemId,
      attemptNo,
      response: input.response,
      modality: "typed",
      transcriptConfirmed: false,
      outcome: grade.outcome,
      score: grade.score,
      max: grade.max,
      hintsUsed: served.length,
      independent: grade.independent,
      grader: grade.grader,
      ruleVersion: GRADE_RULE_VERSION,
      gradedAt: input.now(),
      objectiveKey,
      check: { purpose: "unit", unitKey: objectiveKey, checkKey: mine[0]?.eventId ?? input.eventId, checkSize: 1 },
    });
  } catch (e) {
    // Another eventId took this attempt number first: count again, once or twice.
    if (e instanceof DuplicateAttemptError && round < 2) return markOnce(input, round + 1);
    throw e;
  }

  const done = grade.outcome === "correct" || grade.outcome === "needs_review";
  let rungs: KitRung[] = [];
  let reveal: KitGrade["reveal"] = null;
  if (!done) {
    if (facts) {
      const step = remediation(facts, chosenKeyOf(facts, input.response), attemptNo, manifest, { ...ladderOpts, served });
      rungs = await withCheckItems(step.rungs, input.items);
      reveal = step.reveal;
    } else if (attemptNo >= MAX_ATTEMPTS) {
      reveal = { answer: answerText(item), explanation: null };
    }
  }
  return { status: 200, body: { outcome: grade.outcome, score: grade.score, max: grade.max, attemptNo, triesLeft: done ? 0 : Math.max(0, MAX_ATTEMPTS - attemptNo), rungs, reveal } };
}

/** Rung 4 carries its question as the student sees it (no answer key). */
async function withCheckItems(rungs: KitRung[], items: ItemBank): Promise<KitRung[]> {
  return Promise.all(
    rungs.map(async (r) => {
      if (r.kind !== "verify" || r.itemId === null) return r;
      const q = await items.get(r.itemId);
      return { ...r, item: q ? (stripItem(q) as KitPractiseItem) : null };
    }),
  );
}

function answerText(q: Awaited<ReturnType<ItemBank["get"]>>): string {
  if (!q) return "";
  switch (q.type) {
    case "mcq":
    case "fill_blank":
    case "short":
      return q.answer ?? "";
    case "true_false":
      return q.answer === undefined ? "" : String(q.answer);
    case "match":
      return q.pairs.map((p) => `${p.left} → ${p.right}`).join("; ");
    case "subjective":
      return q.answer_outline ?? "";
  }
}
