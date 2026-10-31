// Worksheet practice — one answer (or help request) on one question, end to
// end on the server (SK student Board plan 2026-10-31, phase 2). Server only.
//
// The route (/api/present/learn/answer) has already proved WHO she is (her
// session, role student, SK on) and that the worksheet is a piece of a kit
// ASSIGNED to her that the student Board shows. This module does the rest
// through the admin client, with every id from the route — never the body —
// for the student:
//
//   1. the paper: questions.json read on the server (the answer key stays
//      here); the question must be on it;
//   2. the practice session: created on her first answer under the Board's
//      session id; an id that is another student's (or another kit's) is
//      refused, so a guessed id can never write into someone else's record;
//   3. the attempt: checked (./check.ts), numbered by the SERVER from the
//      stored attempts (a client's count is never read), and RECORDED —
//      UNIQUE (session, generation, question, attempt_no) turns a double tap
//      into a 429 instead of a second row;
//   4. the help: the ladder's rung (./help.ts rungFor) and its words — the
//      paper's, the cache's, or Haiku 5.5's (metered against the student's
//      fair-use cap, cached for the next student) — and the key ONLY at the
//      "answer" rung, and NOT EVEN THEN while the paper is her graded quiz,
//      not handed in and not past due (phase 4, ./quiz-hold.ts: the worked
//      step again + locked "quiz").
// A question already answered right (or a written answer already sent to
// her teacher) is closed: 409, nothing written.

import type { RawQuestion, RawQuiz } from "@/app/api/quiz/logic";
import type { DbRow, SkDb } from "@/sk/store-supabase";
import { checkAnswer, conceptOf, revealKey, shapeAnswer, type RevealedKey } from "./check";
import { generateHelp, paperHelp, PRACTICE_MODEL, questionHash, rungFor, type HelpModelCall, type Rung } from "./help";
import { keyHeld, type QuizKeyState } from "./quiz-hold";

/** Answers + help taps one question may take in one practice session. */
export const MAX_TRIES_PER_QUESTION = 20;
/** Time on a question is clamped to an hour (a tab left open is not study time). */
export const MAX_TIME_MS = 3_600_000;

export type PracticeDeps = {
  db: SkDb;
  /** questions.json with its key (service role), or null when the worksheet has none. */
  loadPaper: (generationId: string) => Promise<RawQuiz | null>;
  /** The model; null = not configured (help falls back to the paper / the client's generic line). */
  call: HelpModelCall | null;
  /** Fair use: may this student cost a model call now? (counts it when yes). */
  meter: () => Promise<boolean>;
  /**
   * Phase 4 (founder default): the paper's graded-quiz state for her — the
   * key is HELD at rung 3 while it is her quiz, not handed in and not past
   * due (./quiz-hold.ts). The route always passes it; absent = no quiz rule
   * (tests of the ladder alone). A loader that answers null HOLDS the key.
   */
  quizKey?: (studentId: string, generationId: string) => Promise<QuizKeyState | null>;
  now?: () => number;
  log?: (msg: string) => void;
};

export type PracticeInput = {
  studentId: string;
  sessionId: string;
  kitId: string;
  generationId: string;
  questionId: string;
  kind: "answer" | "help";
  answer?: unknown;
  ms?: unknown;
};

export type HelpSource = "paper" | "cache" | "model" | "generic";

export type PracticeReply = {
  outcome: "correct" | "incorrect" | "review" | "help";
  correct: boolean;
  /** This row's attempt number on the question (answers + help taps). */
  attemptNo: number;
  /** Wrong answers given on this question so far (help taps not counted). */
  wrong: number;
  rung: "none" | Rung;
  /** The rung's words; text null = the client shows its own generic line for the rung. */
  help: { rung: Rung; text: string | null; source: HelpSource } | null;
  /** The key, ONLY when rung = "answer" and the key is not held for her graded quiz. */
  answer: RevealedKey | null;
  /** "quiz": rung 3 reached, but the paper is her graded quiz, not yet handed in and not past due — the key is held. */
  locked: "quiz" | null;
  /** The question is finished (right, or a written answer sent to her teacher). */
  done: boolean;
  /** "wrong_twice" exactly once: on her SECOND wrong answer (SK's teaching hand-off). */
  gap: "wrong_twice" | null;
  concept: string | null;
};

export type PracticeResult = { status: number; body: PracticeReply | { error: string; done?: boolean } };

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): PracticeResult => ({ status, body: { error, ...extra } });

const isDup = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === "23505" || /duplicate key|unique constraint/i.test(e.message ?? ""));

function clampMs(v: unknown): number | null {
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(MAX_TIME_MS, Math.round(n));
}

/** The practice session: hers for this kit, created on first use. */
async function openSession(db: SkDb, input: PracticeInput, nowIso: string): Promise<{ ok: true } | PracticeResult> {
  const read = async () => db.from("sk_practice_sessions").select("id, student_id, kit_id").eq("id", input.sessionId).maybeSingle();
  let { data, error } = await read();
  if (error) return fail(500, "Could not check that answer.");
  if (!data) {
    const ins = await db.from("sk_practice_sessions").insert({ id: input.sessionId, student_id: input.studentId, kit_id: input.kitId, started_at: nowIso, last_at: nowIso });
    if (ins.error && !isDup(ins.error)) return fail(500, "Could not check that answer.");
    ({ data, error } = await read());
    if (error || !data) return fail(500, "Could not check that answer.");
  }
  if (String(data.student_id) !== input.studentId) return fail(403, "That practice session isn't yours.");
  if (String(data.kit_id) !== input.kitId) return fail(409, "That practice session belongs to another lesson.");
  return { ok: true };
}

/** The words for one rung: paper → cache → model (metered, then cached) → generic. */
async function helpFor(deps: PracticeDeps, generationId: string, q: RawQuestion, rung: Rung): Promise<{ text: string | null; source: HelpSource }> {
  const own = paperHelp(q, rung);
  if (own) return { text: own, source: "paper" };
  const hash = questionHash(q);
  const key = { generation_id: generationId, question_id: String(q.id), question_hash: hash, rung };
  try {
    const { data } = await deps.db
      .from("sk_practice_help")
      .select("body")
      .eq("generation_id", key.generation_id)
      .eq("question_id", key.question_id)
      .eq("question_hash", key.question_hash)
      .eq("rung", rung)
      .maybeSingle();
    const body = (data as DbRow | null)?.body;
    if (typeof body === "string" && body.trim()) return { text: body, source: "cache" };
  } catch {
    /* a cache miss */
  }
  if (!deps.call) return { text: null, source: "generic" };
  if (!(await deps.meter())) {
    deps.log?.("sk-practice.help over fair-use cap: generic line served");
    return { text: null, source: "generic" };
  }
  const got = await generateHelp(deps.call, q, rung);
  if (!got) return { text: null, source: "generic" };
  const ins = await deps.db.from("sk_practice_help").insert({ ...key, body: got.text, model: PRACTICE_MODEL, cost_usd: got.cost });
  if (ins.error && !isDup(ins.error)) deps.log?.(`sk-practice.help cache write failed: ${ins.error.message ?? ins.error.code ?? "?"}`);
  return { text: got.text, source: "model" };
}

export async function practise(deps: PracticeDeps, input: PracticeInput): Promise<PracticeResult> {
  const now = deps.now ?? Date.now;
  const nowIso = new Date(now()).toISOString();

  const paper = await deps.loadPaper(input.generationId);
  const q = paper?.questions.find((x) => String(x?.id) === input.questionId) ?? null;
  if (!q) return fail(404, "That question isn't on this worksheet.");

  let given: ReturnType<typeof shapeAnswer> = null;
  if (input.kind === "answer") {
    given = shapeAnswer(q, input.answer);
    if (given === null) return fail(400, "Type an answer first.");
  }

  const s = await openSession(deps.db, input, nowIso);
  if (!("ok" in s)) return s;

  const { data: priorRows, error: priorErr } = await deps.db
    .from("sk_practice_attempts")
    .select("attempt_no, outcome, rung")
    .eq("session_id", input.sessionId)
    .eq("generation_id", input.generationId)
    .eq("question_id", input.questionId)
    .order("attempt_no", { ascending: true });
  if (priorErr) return fail(500, "Could not check that answer.");
  const prior = (priorRows ?? []) as { attempt_no: number; outcome: string; rung: string }[];
  if (prior.some((r) => r.outcome === "correct" || r.outcome === "review")) return fail(409, "You've finished this question.", { done: true });
  if (prior.length >= MAX_TRIES_PER_QUESTION) return fail(429, "Let's move on to the next question — you can come back to this one.");

  const outcome: PracticeReply["outcome"] = input.kind === "help" ? "help" : checkAnswer(q, given!);
  const missesBefore = prior.filter((r) => r.outcome === "incorrect" || r.outcome === "help").length;
  const wrongBefore = prior.filter((r) => r.outcome === "incorrect").length;
  const hintsUsed = prior.filter((r) => r.rung && r.rung !== "none").length;
  const rung: PracticeReply["rung"] = outcome === "incorrect" || outcome === "help" ? rungFor(missesBefore + 1) : "none";
  const attemptNo = Math.max(0, ...prior.map((r) => Number(r.attempt_no) || 0)) + 1;
  const concept = conceptOf(q);

  const row = {
    session_id: input.sessionId,
    student_id: input.studentId,
    generation_id: input.generationId,
    question_id: input.questionId,
    question_type: q.type,
    concept,
    kind: input.kind,
    answer: input.kind === "answer" ? given : null,
    outcome,
    correct: outcome === "correct",
    attempt_no: attemptNo,
    rung,
    hints_used: hintsUsed,
    time_ms: clampMs(input.ms),
    created_at: nowIso,
  };
  const ins = await deps.db.from("sk_practice_attempts").insert(row);
  if (ins.error) return isDup(ins.error) ? fail(429, "That answer is already being checked.") : fail(500, "Could not check that answer.");
  void deps.db.from("sk_practice_sessions").update({ last_at: nowIso }).eq("id", input.sessionId).then(
    () => undefined,
    () => undefined,
  );

  // Phase 4: at rung 3, a paper that is still her open graded quiz keeps its
  // key — she gets the worked step again and the "unlocks after you hand in"
  // line; neither the key nor the (key-restating) explanation is sent.
  const held = rung === "answer" && !!deps.quizKey && keyHeld(await deps.quizKey(input.studentId, input.generationId), now()).held;
  const served: Rung | null = rung === "none" ? null : held ? "step" : rung;
  const help = served ? { rung: served, ...(await helpFor(deps, input.generationId, q, served)) } : null;
  const wrong = wrongBefore + (outcome === "incorrect" ? 1 : 0);
  return {
    status: 200,
    body: {
      outcome,
      correct: outcome === "correct",
      attemptNo,
      wrong,
      rung,
      help,
      answer: rung === "answer" && !held ? revealKey(q) : null,
      locked: held ? "quiz" : null,
      done: outcome === "correct" || outcome === "review",
      gap: outcome === "incorrect" && wrong === 2 ? "wrong_twice" : null,
      concept,
    },
  };
}
