// SK B4 — the teacher loop: what one turn, one command or one answer does to a
// session. Everything is injected (store, graph, items, providers, segment
// loader) so the whole loop runs in vitest with the StubProvider and the
// in-memory store; the routes under /api/sk only add auth, the FEATURE_SK gate
// and the idempotent event envelope.
//
// Shape of a turn (plan §4):
//   PRESENTING|PAUSED ─barge-in→ LISTENING → UNDERSTANDING → router
//     command  → applied → PRESENTING
//     route    → PLANNING → planner → (CHECK → ASKING → AWAITING) | PRESENTING
//     question → ANSWERING (one Sonnet call, aside gated) → RESUMING → PRESENTING
//   AWAITING ─answer→ GRADING → FEEDBACK → HINT→AWAITING | NEXT→(ASKING|PRESENTING)
// SK's own lines for commands, routes and feedback are deterministic text; the
// model writes only the answer to a question.

import type { LLMProvider, Turn } from "@/utils/assistant/provider";
import { checkpointFor, type Segment } from "./board/engine";
import { GRADE_RULE_VERSION, gradeItem, type GradeResult } from "./grade";
import { assetOf, cursorFor, mainAsset, startCursor, unitOf } from "./graph";
import { hintFor, stripItem, type ItemBank, type StudentItem } from "./items";
import { selectUnitItems, type UnitItems } from "./items-select";
import { applyCheckToMastery, checkAsset, isBankAssetId, plan, practiceAsset, type Decision, type PlannerContext, type RouteRequest } from "./planner";
import type { RetrievalProvider, RetrievalResult, TurnRetrieval } from "./retrieval";
import { classify } from "./router";
import { MAX_ATTEMPTS } from "./grade";
import { checkComplete, checkPassed, initialMachine, phaseOf, RATE_MIN, RATE_STEP, skippedOf, transition, transitionAll, withoutSkipped, withSkipped, type MachineState, type OpenCheck, type SkEvent, type SkPhase, type SkState } from "./state";
import { DuplicateAttemptError, type Attempt, type SessionStore, type SkSession } from "./store";
import { answerQuestion, MAX_HISTORY_TURNS, NO_TEACHER_TEXT, NOT_IN_BOOK_TEXT } from "./teacher";
import type { Bookmark, Command, Cursor, GradeOutcome, GraphAsset, Intent, MasteryMap, SseEvent, TeachingGraph, Utterance } from "./types";

export type LoopDeps = {
  store: SessionStore;
  graph: TeachingGraph;
  items: ItemBank;
  /** Haiku: the intent proposal. Absent → regex layer + deterministic default. */
  routerProvider?: LLMProvider;
  /** Sonnet: answers to questions. Absent → SK says it cannot answer right now. */
  teacherProvider?: LLMProvider;
  /** Book retrieval for grounded questions (R1): started before the router
   * call, awaited only for a question that needs grounding. "none" → SK says
   * it cannot find that in the book (no model call). Absent → the teacher
   * grounds on the unit narration alone, as before. */
  retrieval?: RetrievalProvider;
  loadSegment: (uri: string) => Promise<Segment>;
  loadHitmapElementIds: (uri: string) => Promise<string[]>;
  now?: () => number;
};

export class LoopError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── The session as the client sees it (contracts §4 session shape + the POC's extras) ──
export type SessionView = {
  sessionId: string;
  graphVersion: number;
  state: SkState;
  phase: SkPhase;
  cursor: Cursor;
  bookmarks: Bookmark[];
  rate: number;
  mastery: MasteryMap;
  /** Units skipped without (finishing) their check — recorded, never mastered (founder, 2026-10-27). */
  skipped: string[];
  unit: { unitKey: string; title: string; order: number } | null;
  asset: { assetId: string; kind: string; style?: string; segment?: string; clip?: string; hitmap?: string } | null;
  openCheck: { unitKey: string; purpose: OpenCheck["purpose"]; index: number; total: number; attemptNo: number; hintsUsed: number; item: StudentItem | null } | null;
  access: { source: "dev-flag"; expiresAt: null; allowance: null };
};

export async function sessionView(deps: LoopDeps, s: SkSession): Promise<SessionView> {
  const m = s.machine;
  const unit = unitOf(deps.graph, m.cursor.unitKey) ?? null;
  const found = assetOf(deps.graph, m.cursor.assetId);
  // A bank-sourced check runs under an asset id the graph does not carry
  // (B4.1); the view still names it, segment-less, like the stand-in's check.
  const bankAsset: GraphAsset | undefined = isBankAssetId(m.cursor.assetId) ? { asset_id: m.cursor.assetId, kind: m.cursor.assetId.endsWith(":practice") ? "practice" : "check" } : undefined;
  const a = found?.asset ?? bankAsset;
  let openCheck: SessionView["openCheck"] = null;
  if (m.openCheck) {
    const oc = m.openCheck;
    const itemId = oc.itemIds[oc.index];
    const raw = itemId ? await deps.items.get(itemId) : null;
    openCheck = { unitKey: oc.unitKey, purpose: oc.purpose, index: oc.index, total: oc.itemIds.length, attemptNo: oc.attemptNo, hintsUsed: oc.hintsUsed, item: raw ? stripItem(raw) : null };
  }
  return {
    sessionId: s.id,
    graphVersion: s.graphVersion,
    state: m.state,
    phase: phaseOf(m.state),
    cursor: m.cursor,
    bookmarks: m.bookmarks,
    rate: m.rate,
    mastery: s.mastery,
    skipped: skippedOf(m),
    unit: unit ? { unitKey: unit.unit_key, title: unit.title, order: unit.order } : null,
    asset: a ? { assetId: a.asset_id, kind: a.kind, style: a.style, segment: a.segment, clip: a.clip, hitmap: a.hitmap } : null,
    openCheck,
    access: { source: "dev-flag", expiresAt: null, allowance: null },
  };
}

// ── Sessions ────────────────────────────────────────────────────────────────
const TRANSIENT: ReadonlySet<SkState> = new Set(["LISTENING", "UNDERSTANDING", "PLANNING", "ANSWERING", "RESUMING", "GRADING", "ASKING", "CHECK", "NEXT", "FEEDBACK", "HINT", "LOADING_GRAPH"]);

/** A session found mid-turn (a crashed or abandoned request) resumes at a
 * stable state: PAUSED, or AWAITING when a check question was open. */
export function recoverTransient(m: MachineState): MachineState {
  if (!TRANSIENT.has(m.state)) return m;
  if (m.openCheck && m.openCheck.index < m.openCheck.itemIds.length) return { ...m, state: "AWAITING" };
  return { ...m, state: "PAUSED", openCheck: null };
}

export async function openSession(deps: LoopDeps, input: { studentId: string; productId: string; chapter: number; resume?: boolean }): Promise<SkSession> {
  if (input.productId !== deps.graph.product_id || input.chapter !== deps.graph.chapter) throw new LoopError(404, "No lesson graph for that product and chapter.");
  if (input.resume !== false) {
    const existing = await deps.store.findSession(input.studentId, input.productId, input.chapter);
    if (existing) {
      const recovered = recoverTransient(existing.machine);
      if (recovered !== existing.machine) {
        existing.machine = recovered;
        await deps.store.saveSession(existing);
      }
      return existing;
    }
  }
  const cursor = startCursor(deps.graph);
  // ONBOARD is skippable in the POC; the chapter opens straight away and
  // starts PAUSED so the student presses play (or says "continue").
  const r = transitionAll(initialMachine(cursor), [{ kind: "open_chapter" }, { kind: "graph_loaded", cursor }, { kind: "pause" }]);
  if (!r.ok) throw new LoopError(500, r.reason);
  return deps.store.createSession({ studentId: input.studentId, productId: input.productId, chapter: input.chapter, graphVersion: deps.graph.version, machine: r.state, mastery: {}, history: [] });
}

/** Trust the client's `t` only for the segment the server believes is playing. */
export function syncCursor(m: MachineState, cursor: Partial<Cursor> | undefined): MachineState {
  if (!cursor || typeof cursor.t !== "number" || !Number.isFinite(cursor.t)) return m;
  if (cursor.unitKey !== m.cursor.unitKey || cursor.assetId !== m.cursor.assetId) return m;
  if (m.state === "PRESENTING") {
    const r = transition(m, { kind: "tick", t: cursor.t });
    return r.ok ? r.state : m;
  }
  if (m.state === "PAUSED") {
    const r = transition(m, { kind: "seek", t: cursor.t });
    return r.ok ? r.state : m;
  }
  return m;
}

// ── Planner glue ────────────────────────────────────────────────────────────
function plannerContext(deps: LoopDeps, s: SkSession, m: MachineState, extra: Partial<PlannerContext> = {}): PlannerContext {
  return { graph: deps.graph, cursor: m.cursor, mastery: s.mastery, bookmarks: m.bookmarks, ...extra };
}

/** B4.1: the units a route request may open a check or practice on — the
 * cursor's unit and the one the request names. (A prerequisite's suggested
 * check is read from the graph only; it is a warning, never opened here.) */
export function unitsToResolve(deps: LoopDeps, m: MachineState, req: RouteRequest): string[] {
  const keys = new Set<string>();
  if (req.name === "next" || req.name === "skip" || req.name === "practise" || req.name === "check_me") keys.add(m.cursor.unitKey);
  if ("unitKey" in req && req.unitKey && req.name !== "goto" && req.name !== "explain_again") keys.add(req.unitKey);
  return [...keys].filter((k) => !!unitOf(deps.graph, k));
}

/** Ask the bank for the items of each unit whose graph check OR practice
 * asset carries no ids, at the moment the route is planned, and pick them
 * deterministically (./items-select). The graph's own ids are never replaced:
 * `checkFor`/`practiceFor` in the planner read those first. */
export async function resolveBankItems(deps: LoopDeps, m: MachineState, req: RouteRequest): Promise<Record<string, UnitItems>> {
  const out: Record<string, UnitItems> = {};
  for (const key of unitsToResolve(deps, m, req)) {
    const unit = unitOf(deps.graph, key)!;
    if (checkAsset(unit) && practiceAsset(unit)) continue;
    const items = await deps.items.listForUnit(deps.graph.product_id, deps.graph.chapter, unit.unit_key);
    out[key] = selectUnitItems(items);
  }
  return out;
}

export function toRouteRequest(c: Command): RouteRequest | null {
  const a = c.args;
  switch (c.name) {
    case "skip":
      return a.scope === "segment" ? { name: "next" } : { name: "skip", unitKey: a.unitKey, withCheck: a.withCheck ?? true };
    case "goto":
      return a.unitKey ? { name: "goto", unitKey: a.unitKey } : null;
    case "practise":
      return a.n === 0 ? { name: "check_me", unitKey: a.unitKey } : { name: "practise", unitKey: a.unitKey, n: a.n };
    case "return":
      return { name: "return" };
    case "explain_again":
      return { name: "explain_again", unitKey: a.unitKey, style: a.style };
    default:
      return null;
  }
}

const titleOf = (g: TeachingGraph, key: string) => unitOf(g, key)?.title ?? key;

/** What SK may say about an open check when the student asks how it works:
 * position, attempts left, how to answer the item's TYPE, and the way out.
 * Deliberately built from the check's shape only — no prompt, options, key
 * or hint text — so a "clarification" can never leak the answer. */
export async function checkInstructions(deps: LoopDeps, oc: OpenCheck): Promise<string> {
  const itemId = oc.itemIds[oc.index];
  const item = itemId ? await deps.items.get(itemId) : null;
  const how =
    item?.type === "mcq" ? "Pick one of the options." : item?.type === "true_false" ? "Answer true or false." : item?.type === "match" ? "Type the pairs as left = right." : item?.type === "subjective" ? "Write your answer in a sentence or two." : "Type a short answer.";
  const what = oc.purpose === "practise" ? "practice question" : "check question";
  const left = Math.max(0, MAX_ATTEMPTS - oc.attemptNo + 1);
  return `This is ${what} ${oc.index + 1} of ${oc.itemIds.length}, attempt ${oc.attemptNo} of ${MAX_ATTEMPTS} — ${left} ${left === 1 ? "go" : "goes"} left on it. ${how} A wrong answer gets a hint before the next try. I can't explain the topic until the check is done; say skip to move on without it.`;
}

/** SK's line for a planner decision — deterministic, and it names the reason
 * the student needs to hear (the warning, the "so it counts" rule). */
export function speechFor(g: TeachingGraph, d: Decision): string {
  switch (d.kind) {
    case "present":
      return `${d.bookmark ? "Sure — " : ""}let's look at ${titleOf(g, d.unitKey)}.${d.warning ? ` ${d.warning}` : ""}`;
    case "check":
      if (d.purpose === "skip") return `Happy to skip ${titleOf(g, d.unitKey)} — ${d.itemIds.length} quick questions first so it counts.`;
      if (d.purpose === "practise") return `Let's practise ${titleOf(g, d.unitKey)}. Here's the first one.`;
      return `Let's check ${titleOf(g, d.unitKey)} — ${d.itemIds.length} questions.`;
    case "return":
      return "Back to where we were.";
    case "generate":
      return d.rung === 1 ? "Here's a demonstration that fits this." : d.rung === 2 ? "Let me draw it more simply." : "Let me put it another way.";
    case "none":
      return d.reasons.some((r) => r.startsWith("no bookmark")) ? "There's nothing to go back to yet." : d.reasons.some((r) => r.startsWith("end of chapter")) ? "That's the end of this chapter — well done." : "I can't do that from here.";
  }
}

export type Applied = { m: MachineState; speech: string; decision?: Decision; board?: "erase_aside" | "seek" | "play" | "pause"; refused?: string };

/** Run a route request through the planner and apply its decision. `m` may be
 * in PLANNING already (a spoken route) or in a state route_requested accepts.
 * Async since B4.1: the bank is asked for a unit's items when the graph has
 * none, before the planner runs. */
export async function executeRoute(deps: LoopDeps, s: SkSession, m: MachineState, req: RouteRequest, extra: Partial<PlannerContext> = {}): Promise<Applied> {
  // Declining the skip check (founder, 2026-10-27): a second "skip" while the
  // 2-item skip check for that unit is open is the student saying "no, just
  // skip it" — honour it without the check, and record the unit as skipped.
  const oc = m.openCheck;
  if (req.name === "skip" && oc?.purpose === "skip" && (m.state === "AWAITING" || m.state === "CONFIRM_TRANSCRIPT" || m.state === "FEEDBACK") && (!req.unitKey || req.unitKey === oc.unitKey)) {
    req = { ...req, unitKey: oc.unitKey, withCheck: false };
  }
  const bankItems = await resolveBankItems(deps, m, req);
  const decision = plan(plannerContext(deps, s, m, { bankItems, ...extra }), req);
  if (decision.kind === "none") {
    // Nothing to do: leave the machine where it is, except a spoken route that already moved to PLANNING.
    const back = m.state === "PLANNING" ? transition(m, { kind: "planned", cursor: m.cursor }) : null;
    return { m: back?.ok ? back.state : m, speech: speechFor(deps.graph, decision), decision };
  }
  let cur = m;
  if (cur.state !== "PLANNING") {
    const r = transition(cur, { kind: "route_requested" });
    if (!r.ok) return { m, speech: "I can't change course right now.", refused: r.reason, decision };
    cur = r.state;
  }
  const events: SkEvent[] =
    decision.kind === "check"
      ? [{ kind: "planned", cursor: decision.cursor, bookmark: decision.bookmark, check: { unitKey: decision.unitKey, itemIds: decision.itemIds, purpose: decision.purpose } }, { kind: "ask" }, { kind: "asked" }]
      : decision.kind === "return"
        ? [{ kind: "planned", cursor: decision.cursor, popBookmark: true }]
        : [{ kind: "planned", cursor: decision.cursor, bookmark: decision.bookmark }];
  const r = transitionAll(cur, events);
  if (!r.ok) return { m, speech: "I can't change course right now.", refused: r.reason, decision };
  let next = r.state;
  let speech = speechFor(deps.graph, decision);
  // A skip that did NOT open the check (declined, asked for without it, or the
  // unit has no check items) records the unit as skipped — never mastered.
  if (req.name === "skip" && decision.kind !== "check") {
    const skippedKey = req.unitKey ?? m.cursor.unitKey;
    if (unitOf(deps.graph, skippedKey)) {
      next = withSkipped(next, skippedKey);
      speech = `Skipping ${titleOf(deps.graph, skippedKey)} without the check — it stays unmarked, not learned. ${speech}`;
    }
  }
  return { m: next, speech, decision, board: decision.kind === "check" ? "pause" : "play" };
}

/** Apply one command from the closed set. Route commands go through the planner. */
export async function executeCommand(deps: LoopDeps, s: SkSession, m: MachineState, c: Command): Promise<Applied> {
  const refuse = (reason: string, speech = "I can't do that right now."): Applied => ({ m, speech, refused: reason });
  switch (c.name) {
    case "repeat": {
      const found = assetOf(deps.graph, m.cursor.assetId);
      let at = 0;
      if (found?.asset.segment) {
        try {
          const seg = await deps.loadSegment(found.asset.segment);
          at = checkpointFor(seg.checkpoints, m.cursor.t);
        } catch {
          at = 0;
        }
      }
      const r = transitionAll(m, m.state === "PAUSED" ? [{ kind: "seek", t: at }, { kind: "play" }] : [{ kind: "seek", t: at }]);
      return r.ok ? { m: r.state, speech: "Let me say that part again.", board: "seek" } : refuse(r.reason);
    }
    case "slower": {
      if (m.rate <= RATE_MIN + 1e-9) return { m, speech: "That's as slow as I go — ask me to repeat anything you like." };
      const r = transition(m, { kind: "set_rate", rate: m.rate - RATE_STEP });
      return r.ok ? { m: r.state, speech: "I'll slow down a little." } : refuse(r.reason);
    }
    case "erase":
      return { m, speech: "Clearing that.", board: "erase_aside" };
    case "continue": {
      if (m.state === "PRESENTING") return { m, speech: "Let's carry on.", board: "play" };
      if (m.state === "AWAITING" || m.state === "CONFIRM_TRANSCRIPT") return { m, speech: "Have a go at this one first — or say skip to move on." };
      const r = transition(m, { kind: "play" });
      return r.ok ? { m: r.state, speech: "Let's carry on.", board: "play" } : refuse(r.reason);
    }
    case "skip":
    case "goto":
    case "practise":
    case "return":
    case "explain_again": {
      const req = toRouteRequest(c);
      if (!req) return refuse(`${c.name} needs a unit`, "Which unit do you mean?");
      const applied = await executeRoute(deps, s, m, req);
      return c.name === "skip" && c.args.scope === "segment" && applied.decision?.kind !== "none" ? { ...applied, speech: `Skipping ahead. ${applied.speech}` } : applied;
    }
  }
  return refuse("unknown command");
}

/** The /api/sk/command body: apply, persist, return the view. */
export async function runCommand(deps: LoopDeps, s: SkSession, c: Command, cursor?: Partial<Cursor>): Promise<{ view: SessionView; speech: string; board?: Applied["board"]; decision?: Decision; refused?: string }> {
  const m = syncCursor(s.machine, cursor);
  const applied = await executeCommand(deps, s, m, c);
  s.machine = applied.m;
  await deps.store.saveSession(s);
  return { view: await sessionView(deps, s), speech: applied.speech, board: applied.board, decision: applied.decision, refused: applied.refused };
}

// ── Answers (contracts §4 /api/sk/answer; graded once per (item, attemptNo)) ──
export type AnswerInput = { eventId: string; itemId: string; attemptNo: number; response: unknown; modality: "typed" | "spoken"; transcriptConfirmed?: boolean };

export type AnswerResult =
  | { kind: "confirm"; transcript: string; view: SessionView }
  | {
      kind: "graded";
      outcome: GradeOutcome;
      score: number;
      max: number;
      feedback: string;
      hintAvailable: boolean;
      independent: boolean;
      hint?: string;
      /** Set when this answer closed the check. */
      check?: { passed: boolean; independent: boolean; purpose: OpenCheck["purpose"] };
      speech: string;
      replayed: boolean;
      view: SessionView;
    };

function attemptToResult(a: Attempt): Omit<Extract<AnswerResult, { kind: "graded" }>, "view" | "speech" | "replayed" | "kind"> {
  return { outcome: a.outcome, score: a.score, max: a.max, feedback: "", hintAvailable: false, independent: a.independent };
}

/** After a check closes: where SK goes next, by the check's purpose. */
async function afterCheck(deps: LoopDeps, s: SkSession, m: MachineState, oc: OpenCheck): Promise<Applied> {
  const passed = checkPassed(oc);
  s.mastery = applyCheckToMastery(s.mastery, oc.unitKey, oc.purpose, oc.results, oc.independent);
  // A passed check (independent or provisional) supersedes an earlier skip of the unit.
  if (passed && oc.purpose !== "practise") m = withoutSkipped(m, oc.unitKey);
  const unit = unitOf(deps.graph, oc.unitKey);
  const intro = passed ? (oc.purpose === "practise" ? "Nice work. " : oc.independent ? "You've got this — that counts. " : "Got there — with a little help, so I'll keep an eye on this one. ") : oc.purpose === "practise" ? "Good effort — practice is how it sticks. " : "Not all the way yet — let's go through it together. ";
  if (oc.purpose === "practise") {
    const back = m.bookmarks.length ? await executeRoute(deps, s, m, { name: "return" }) : { m, speech: "" };
    return { ...back, speech: intro + back.speech };
  }
  if (passed) {
    const next = await executeRoute(deps, s, m, { name: "next" });
    return { ...next, speech: intro + next.speech };
  }
  // Failed a skip/unit check: teach the unit — a visual alternative first (plan §3).
  if (unit && oc.purpose === "skip" && mainAsset(unit)) {
    const main = mainAsset(unit)!;
    const r = transitionAll(m, [{ kind: "route_requested" }, { kind: "planned", cursor: cursorFor(deps.graph, unit, main) }]);
    return r.ok ? { m: r.state, speech: intro + `Let's start ${unit.title} from the top.`, board: "play" } : { m, speech: intro, refused: r.reason };
  }
  const again = await executeRoute(deps, s, m, { name: "explain_again", unitKey: oc.unitKey }, { lastCheckFailed: true });
  return { ...again, speech: intro + again.speech };
}

export async function submitAnswer(deps: LoopDeps, s: SkSession, input: AnswerInput): Promise<AnswerResult> {
  if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1) throw new LoopError(400, "attemptNo must be a positive integer.");
  // Graded once (contracts §5.6): a repeat of a finished attempt returns what
  // was stored, whatever the session is doing now.
  const stored = await deps.store.getAttempt(s.id, input.itemId, input.attemptNo);
  if (stored) return { kind: "graded", ...attemptToResult(stored), feedback: "Already marked.", speech: "", replayed: true, view: await sessionView(deps, s) };

  const m0 = s.machine;
  const oc = m0.openCheck;
  if (!oc || !(m0.state === "AWAITING" || m0.state === "CONFIRM_TRANSCRIPT")) throw new LoopError(409, "No question is open.");
  const expected = oc.itemIds[oc.index];
  if (input.itemId !== expected) throw new LoopError(409, "That is not the question being asked.");
  if (input.attemptNo !== oc.attemptNo) throw new LoopError(409, `Expected attempt ${oc.attemptNo}.`);

  // Spoken answers are confirmed before they are graded (plan §4 CONFIRM_TRANSCRIPT).
  if (input.modality === "spoken" && !input.transcriptConfirmed) {
    if (m0.state === "AWAITING") {
      const r = transition(m0, { kind: "response", modality: "spoken", transcriptConfirmed: false });
      if (!r.ok) throw new LoopError(409, r.reason);
      s.machine = r.state;
      await deps.store.saveSession(s);
    }
    return { kind: "confirm", transcript: String(input.response ?? ""), view: await sessionView(deps, s) };
  }

  const item = await deps.items.get(input.itemId);
  if (!item) throw new LoopError(500, "The question's marking scheme is missing.");
  const grade: GradeResult = gradeItem(item, input.response, { attemptNo: oc.attemptNo, hintsUsed: oc.hintsUsed });
  const attempt: Attempt = {
    sessionId: s.id,
    eventId: input.eventId,
    itemId: input.itemId,
    attemptNo: oc.attemptNo,
    response: input.response,
    modality: input.modality,
    transcriptConfirmed: input.modality === "typed" || !!input.transcriptConfirmed,
    outcome: grade.outcome,
    score: grade.score,
    max: grade.max,
    hintsUsed: oc.hintsUsed,
    independent: grade.independent,
    grader: grade.grader,
    ruleVersion: GRADE_RULE_VERSION,
    gradedAt: (deps.now ?? Date.now)(),
  };
  try {
    await deps.store.putAttempt(attempt);
  } catch (e) {
    if (e instanceof DuplicateAttemptError) return { kind: "graded", ...attemptToResult(e.existing), feedback: "Already marked.", speech: "", replayed: true, view: await sessionView(deps, s) };
    throw e;
  }

  // Walk the ASSESS states.
  const toGrading: SkEvent[] = m0.state === "AWAITING" ? [{ kind: "response", modality: input.modality, transcriptConfirmed: true }] : [{ kind: "transcript_confirmed" }];
  const correct = grade.outcome === "correct";
  let r = transitionAll(m0, [...toGrading, { kind: "graded", correct }]);
  if (!r.ok) throw new LoopError(409, r.reason);
  let m = r.state;
  let hint: string | undefined;
  let speech = grade.feedback;
  let check: Extract<AnswerResult, { kind: "graded" }>["check"];
  if (!correct && grade.hintAvailable) {
    r = transitionAll(m, [{ kind: "hint" }, { kind: "retry" }]);
    if (!r.ok) throw new LoopError(409, r.reason);
    m = r.state;
    hint = hintFor(item);
    speech = `${grade.feedback} ${hint}`;
  } else {
    r = transition(m, { kind: "next_item" });
    if (!r.ok) throw new LoopError(409, r.reason);
    m = r.state;
    const after = m.openCheck!;
    if (!checkComplete(after)) {
      r = transitionAll(m, [{ kind: "ask" }, { kind: "asked" }]);
      if (!r.ok) throw new LoopError(409, r.reason);
      m = r.state;
      speech = `${grade.feedback} Next one.`;
    } else {
      r = transition(m, { kind: "check_closed" });
      if (!r.ok) throw new LoopError(409, r.reason);
      m = r.state;
      const applied = await afterCheck(deps, s, m, after);
      m = applied.m;
      check = { passed: checkPassed(after), independent: after.independent, purpose: after.purpose };
      speech = `${grade.feedback} ${applied.speech}`.trim();
    }
  }
  s.machine = m;
  await deps.store.saveSession(s);
  return { kind: "graded", outcome: grade.outcome, score: grade.score, max: grade.max, feedback: grade.feedback, hintAvailable: grade.hintAvailable, independent: grade.independent, hint, check, speech, replayed: false, view: await sessionView(deps, s) };
}

// ── The turn (contracts §4 /api/sk/turn, SSE) ───────────────────────────────
export type TurnInput = { eventId: string; utterance: Utterance; cursor?: Partial<Cursor>; signal?: AbortSignal };

export async function* runTurn(deps: LoopDeps, s: SkSession, input: TurnInput): AsyncGenerator<SseEvent, void, void> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const text = input.utterance.text.trim().slice(0, 600);
  let m = syncCursor(s.machine, input.cursor);
  const checkOpen = !!m.openCheck && (m.state === "AWAITING" || m.state === "CONFIRM_TRANSCRIPT");
  const usage = { inputTokens: 0, outputTokens: 0 };
  let modelMs = 0;
  let retrievalMs = 0;
  let cancelled = false;

  // Retrieval starts NOW, in parallel with the router call (R1: the query
  // embedding is the slow part), and only where a question can be answered;
  // it is awaited only if the intent turns out to be a grounded question.
  const canAnswer = m.state === "PRESENTING" || m.state === "PAUSED";
  const retrieval: TurnRetrieval | undefined = text && canAnswer && deps.retrieval ? deps.retrieval.begin(text, { product: deps.graph.product_id, chapter: deps.graph.chapter, signal: input.signal }) : undefined;

  const intent: Intent = text ? await classify(text, { graph: deps.graph, checkOpen, provider: deps.routerProvider, signal: input.signal }) : { kind: "question", needsGrounding: false, confidence: 0, source: "default" };
  const routerMs = now() - t0;
  let decision: Decision | undefined;
  let board: Applied["board"];
  yield { event: "meta", data: { intent: intent.kind, command: intent.command, source: intent.source, confidence: intent.confidence, state: m.state } };

  if (!text) {
    yield { event: "text", data: "I didn't catch that — could you say it again?" };
  } else if (m.state === "PRESENTING" || m.state === "PAUSED") {
    // Spoken intent while teaching: barge in, understand, branch.
    const kind = intent.kind === "answer" ? "question" : intent.kind; // no check open → an "answer" is a question
    const r = transitionAll(m, [{ kind: "barge_in", t: input.cursor?.t }, { kind: "utterance" }, { kind: "intent", intent: kind }]);
    if (!r.ok) {
      yield { event: "error", data: { message: r.reason } };
    } else {
      m = r.state;
      if (kind === "command" && intent.command) {
        const applied = await executeCommand(deps, s, m, intent.command);
        m = applied.m;
        decision = applied.decision;
        board = applied.board;
        yield { event: "text", data: applied.speech };
      } else if (kind === "route" && intent.command) {
        const req = toRouteRequest(intent.command);
        const applied = req ? await executeRoute(deps, s, m, req) : { m, speech: "Which unit do you mean?" };
        if (!req) {
          const back = transition(m, { kind: "planned", cursor: m.cursor });
          if (back.ok) m = back.state;
        } else m = applied.m;
        decision = applied.decision;
        board = applied.board;
        yield { event: "text", data: applied.speech };
      } else {
        // question → ANSWERING: one Sonnet call with the unit's content as the cached prefix.
        const found = assetOf(deps.graph, m.cursor.assetId);
        const unit = unitOf(deps.graph, m.cursor.unitKey);
        let fullText = "";
        // A question about the TOPIC consults the book first. "none" means the
        // book has nothing on it (the vector gate): SK says so, deterministically,
        // instead of letting the model answer from memory. An "error" (RPC
        // missing, Bedrock denied) degrades to unit-only grounding, logged once.
        let grounding: RetrievalResult | undefined;
        if (retrieval && intent.needsGrounding) {
          const tRetr = now();
          grounding = await retrieval.result();
          retrievalMs = now() - tRetr;
          yield { event: "meta", data: { grounding: { status: grounding.status, ...(grounding.status === "none" ? { reason: grounding.reason } : {}), ...(grounding.status !== "error" ? { bestVecScore: grounding.bestVecScore, gate: grounding.gate, passages: grounding.status === "grounded" ? grounding.passages.map((p) => p.sourceRef) : [] } : { message: grounding.message }), ms: grounding.ms } } };
        }
        if (grounding?.status === "none") {
          fullText = NOT_IN_BOOK_TEXT;
          yield { event: "text", data: NOT_IN_BOOK_TEXT };
          const turns: Turn[] = [{ role: "user", text }, { role: "assistant", text: NOT_IN_BOOK_TEXT }];
          s.history = [...s.history, ...turns].slice(-MAX_HISTORY_TURNS);
        } else if (deps.teacherProvider && unit && found?.asset.segment) {
          const tModel = now();
          try {
            const [segment, hitmapElementIds] = await Promise.all([deps.loadSegment(found.asset.segment), found.asset.hitmap ? deps.loadHitmapElementIds(found.asset.hitmap) : Promise.resolve([])]);
            for await (const ev of answerQuestion({ provider: deps.teacherProvider, unit, segment, hitmapElementIds, question: text, history: s.history, signal: input.signal, grounding })) {
              if (ev.type === "text") {
                fullText += ev.text;
                yield { event: "text", data: ev.text };
              } else if (ev.type === "tal") yield { event: "tal", data: ev.program };
              else if (ev.type === "aside_rejected") yield { event: "meta", data: { asideRejected: ev.reason } };
              else if (ev.type === "done") Object.assign(usage, ev.usage);
              else if (ev.type === "cancelled") {
                cancelled = true;
                fullText = ev.fullText;
              } else if (ev.type === "error") {
                yield { event: "text", data: fullText ? "" : "Sorry — I lost my train of thought. Let's carry on, and ask me again in a moment." };
              }
            }
          } catch (e) {
            yield { event: "text", data: `Sorry — I couldn't answer that just now (${(e as Error).message.slice(0, 80)}).` };
          }
          modelMs = now() - tModel;
          if (fullText && !cancelled) {
            const turns: Turn[] = [{ role: "user", text }, { role: "assistant", text: fullText }];
            s.history = [...s.history, ...turns].slice(-MAX_HISTORY_TURNS);
          }
        } else {
          yield { event: "text", data: NO_TEACHER_TEXT };
        }
        // Resume 1.5 s back and carry on (plan §4 RESUMING).
        const back = transitionAll(m, [{ kind: "answered" }, { kind: "play" }]);
        if (back.ok) m = back.state;
        board = "play";
      }
    }
  } else if (m.state === "AWAITING" || m.state === "CONFIRM_TRANSCRIPT") {
    // A check question is open: answers are graded; commands and routes still work.
    if (intent.kind === "answer") {
      s.machine = m;
      const oc = m.openCheck!;
      try {
        const res = await submitAnswer(deps, s, { eventId: input.eventId, itemId: oc.itemIds[oc.index]!, attemptNo: oc.attemptNo, response: text, modality: input.utterance.modality, transcriptConfirmed: input.utterance.transcriptConfirmed });
        m = s.machine;
        yield { event: "text", data: res.kind === "confirm" ? `Did you say "${res.transcript}"?` : res.speech };
        if (res.kind === "graded") yield { event: "meta", data: { graded: { outcome: res.outcome, score: res.score, max: res.max, hintAvailable: res.hintAvailable, independent: res.independent, check: res.check } } };
      } catch (e) {
        yield { event: "error", data: { message: e instanceof LoopError ? e.message : "Could not mark that answer." } };
      }
    } else if (intent.kind === "command" && intent.command) {
      const applied = await executeCommand(deps, s, m, intent.command);
      m = applied.m;
      board = applied.board;
      yield { event: "text", data: applied.speech };
    } else if (intent.kind === "route" && intent.command) {
      const req = toRouteRequest(intent.command);
      const applied = req ? await executeRoute(deps, s, m, req) : { m, speech: "Which unit do you mean?" };
      m = applied.m;
      decision = applied.decision;
      board = applied.board;
      yield { event: "text", data: applied.speech };
    } else if (intent.kind === "question" && !intent.needsGrounding) {
      // A question about the INSTRUCTIONS (how to answer, how many tries) is
      // answered from the open check's own facts — never from the item's
      // content or key (founder, 2026-10-27: clarification yes, answers no).
      yield { event: "text", data: await checkInstructions(deps, m.openCheck!) };
    } else {
      yield { event: "text", data: m.openCheck!.purpose === "practise" ? "Let's finish this practice question first — have a go, use a hint if you need one, or say skip to move on." : "Let's finish this question first — I can't explain the topic while a check is on. Have a go, use a hint if you need one, or say skip to move on." };
    }
  } else {
    yield { event: "error", data: { message: `SK is ${m.state.toLowerCase().replace(/_/g, " ")} and cannot take a turn yet.` } };
  }

  s.machine = m;
  await deps.store.saveSession(s);
  const view = await sessionView(deps, s);
  yield {
    event: "done",
    data: {
      latency: { totalMs: now() - t0, routerMs, modelMs, retrievalMs },
      usage,
      ...(cancelled ? { cancelled: true } : {}),
      board,
      decision: decision ? { kind: decision.kind, reasons: decision.reasons, ...(decision.kind === "generate" ? { rung: decision.rung, basis: decision.basis } : {}) } : undefined,
      view,
    },
  };
}
