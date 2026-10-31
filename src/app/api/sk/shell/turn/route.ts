import { after, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skShellEnabledFor } from "@/utils/flags";
import { LOCALE_COOKIE, isLocale } from "@/i18n/locales";
import { AnthropicProvider } from "@/utils/assistant/providers/anthropic";
// 2026-10-30: SK's own Bedrock region / model overlay (SK_BEDROCK_REGION, SK_BEDROCK_MODEL_MAP).
import { skProviderTarget, skRegionLabel } from "@/sk/claude-target";
// 2026-10-30: MODEL-FIRST routing behind SK_ROUTING / SK_MODEL_FIRST_EMAILS.
import { SkModelProvider, chooseModel, escalationTools, handoffAfter, handoffBefore, modelFirstDecision, skDebugFor, skRouting, studentOnBoard, type HandoffBefore, type ModelStats } from "@/sk/shell/routing";
// 2026-10-31: the student Board (learner mode) — her board is checked against
// her assignments, and a hidden fair-use cap counts her turns.
import { sharedToMe } from "@/utils/present/learner-server";
import { meterStudentTurn, type CapOutcome } from "@/sk/student-cap";
import { SK_STUDENT_CAP_LINE } from "@/sk/shell/learner";
import type { Usage } from "@/utils/assistant/provider";
import type { Turn } from "@/utils/assistant/provider";
import { runAssistantTurn } from "@/utils/assistant/orchestrator";
import { loadContext } from "@/sk/shell/context";
import { openMemory, rememberTurn, sealMemory, type SkMemory } from "@/sk/shell/memory";
import { allowedFor, fromApiToolName, toToolDefs } from "@/sk/shell/registry";
import { makeRunTool, runCapability, toolResultText, type RunnerDeps, type ToolTrace } from "@/sk/shell/runner";
import { auditSinkFor } from "@/sk/shell/audit";
import { routeByRules } from "@/sk/shell/rules";
import { offerAnswer } from "@/sk/shell/offer";
import { lineFor } from "@/sk/shell/lines";
import { KIT_OFFER_DECLINED } from "@/sk/shell/act-lines";
// S6 slice C: the greeting suggestion's offers, and workflow facts in use.
import { SUGGEST_DECLINED } from "@/sk/shell/suggest-lines";
import { WALKTHROUGH_START, walkPromptLine } from "@/sk/shell/walkthrough-lines";
import { walkCommand } from "@/sk/shell/client/walkthrough";
import { recordWorkflow, workflowFromTurn } from "@/sk/shell/workflow";
import type { FactsDb } from "@/sk/facts";
import { buildShellPrompt, groundingCheck } from "@/sk/shell/prompt";
import { contextEntities, groundWithContext } from "@/sk/shell/context-entities";
// S5 slice E: a claimed action no completed action backs is dropped (§8.4 gates).
import { CLAIM_CANT, actionClaimGuard, claimCorrection } from "@/sk/shell/action-claims";
// 2026-10-31: the SK gap tracker — this turn's misses, written once when it ends.
import { recordGaps } from "@/sk/gaps/store";
import { TurnGaps } from "@/sk/gaps/turn";
import { NOTE_GAP_RESULT, NOTE_GAP_TOOL_DEF, isNoteGapCall, parseNoteGap } from "@/sk/gaps/note-gap";
import { issueActionToken, publicParams } from "@/sk/shell/tokens";
import { maskBookSecrets } from "@/sk/book-activate";
import { TEACH_AUDIENCE_CLASS, TEACH_AUDIENCE_STUDENT, TEACH_MAX_TOKENS, clipWords, teachingBlock, teachingQuestion, teachingSupport, teachingSupportTokens, type TeachRef, type TeachTarget, type TeachingSupport } from "@/sk/shell/teach";
import { loadSelectionSlide, selectionBlock, selectionOnSlide, selectionQuestion, selectionSupportTokens, type SelectionAdmin } from "@/sk/shell/selection";
import { BOARD_NO_MAP, BOARD_SELECTION_NO_SLIDE, sayFor } from "@/sk/capabilities/board";
import { openUnitAnswer, openUnitDeckPicture, openUnitDeckSlide } from "@/sk/capabilities/documents";
// 2026-10-31 (student Board phase 3): SK teaches beyond the kit, in the chat.
import {
  TEACH_CHECK_MAX_TOKENS,
  TEACH_LESSON_MAX_TOKENS,
  addTaught,
  bestSlide,
  checkReplyPrompt,
  confusionOf,
  guardAnswer,
  headingsFor,
  kitParts,
  looksLikeAnswer,
  ownLineIssues,
  parseLesson,
  parseTeachRequest,
  renderLesson,
  teachQuestion,
  teachSystem,
  teachTurnText,
  type SkTeachRequest,
  type TeachLesson,
} from "@/sk/shell/learn-teach";
import { personNameWords } from "@/sk/shell/prompt";
import { readManifest } from "@/sk/manifest/store";
import { noteLearning } from "@/sk/facts";
import type { ConsentDb } from "@/sk/consent";
import { supportFrom } from "@/sk/shell/teach";
import type { Passage } from "@/sk/knowledge/answer";
// 2026-10-31: tool-call markup never reaches the bubble, the voice or the memory.
import { COULD_NOT_DO, cleanReply, stripToolMarkup } from "@/sk/shell/markup";
import { searchLibrary } from "@/sk/capabilities/library";
import type { NavFilters } from "@/sk/capabilities/navigate";
import { kitFilters, lessonNotStarted, namesLesson, pickKitHit, planStartLesson } from "@/sk/shell/start-lesson";
// 2026-10-30: the answer language (a command > the question's own > the
// conversation's > the source's > the UI's) and "repeat that in X" — one
// translation call on the last answer.
import { answerLanguage, canSpeakList, langMeta, languageChosen, languageName, linesLocale, overrideForBack, ownName, parseLanguageCommand, stickyAfterQuestion, targetCode, uiAnswerLang, type AnswerLanguage, type LangCommand, type SkAnswerLang } from "@/sk/shell/language";
// 2026-10-30 (second revision): the language the QUESTION is written in
// decides the answer's in the same turn — pure, no model, no round trip.
import { spokenQuestionLanguage } from "@/sk/shell/question-language";
import { LANG_CAN_SPEAK, LANG_NOTHING_TO_REPEAT, LANG_SOURCE_UNSUPPORTED, LANG_SWITCHED, langLine } from "@/sk/shell/language-lines";
import { repeatAnswer, skTranslateModel } from "@/sk/shell/repeat";
import { knowledgeForStudent, repeatForStudent } from "@/sk/capabilities/tutor";
// S7 K2: SK answers from the books, articles and uploads the user may read.
import { kitOwnSources, searchForUser } from "@/sk/capabilities/knowledge";
import { citationsOf, isContentQuestion, knowledgeBlock, knowledgeSupportTokens } from "@/sk/knowledge/answer";
import { citeLine } from "@/sk/shell/knowledge-lines";
import { kitSource } from "@/sk/shell/teach";
// S5 slice B: the leader school-read gate (analytics, 60/day cap, audit row).
import { SCHOOL_READ_REFUSALS, schoolReadGate } from "@/sk/shell/school-meter";
import { SM_ANALYTICS_OFF } from "@/sk/shell/school-meter-lines";
import { SK_CANNOT_CONFIRM, SK_NOTHING_ON_THAT, type ResolvedEntity, type SkCapabilityResult, type SkCitation, type SkCollector, type SkTurnEvent, type SkTurnRequest, type SkTurnWalk } from "@/sk/shell/types";

export const runtime = "nodejs";

// POST /api/sk/shell/turn — one SK Shell turn (Final Plan §2.1–2.3, S0).
//
// Gate → Context (server-built) → signed memory → rules router. A navigate is
// deterministic (no model call): resolve the class, run `navigate`, emit the
// path. Everything else goes to the teacher model with the registry's allowed
// tools; the answer is BUFFERED and checked by groundingCheck before anything
// reaches the client, so an invented number or name is stripped and an empty
// tool set yields exactly SK_NOTHING_ON_THAT. One `data:` JSON line per event.
//
// Not in S0: writing the turn to assistant_messages (those tables are keyed by
// student session) — the audit rows per capability are the S0 trail.
//
// S1 (slice B): a capability result may carry `board` (an immediate Board move
// the client performs — emitted as a `board` event, labelled grounded) or
// `confirm` (a confirm-tier action with resolved params — the route issues the
// action token and emits a `confirm` card; NOTHING is executed here, the
// client returns the token to /api/sk/act). Both come either from the rules
// router (Board phrasings while a Board session is open) or from a tool the
// model chose; the handling is one code path.
//
// S1 (slice C): `board.explain` / `board.compare` carry CONTENT. After the
// slide move is emitted, the segment's own narration is read from the Kit
// Manifest (teach.ts) and ONE model call — no tools, the narration as DATA in a
// TEACHING block, 220 tokens — writes the 2–4 sentence explanation, which
// groundingCheck holds to the narration's names and numbers before it is sent:
// meta → tool → board → text → done{grounded, sources: [move, "manifest"]}.
// A manifest that is not ready gets SK's own line plus "the lesson map isn't
// ready yet" and NO model call. Board audit rows carry the PRESENT session id
// (sk_actions.session_id) so the recap can read what SK did in that lesson.
//
// "Highlight a portion and ask SK" (founder 2026-10-28): `board.explain_selection`
// validates the highlight the Board state carries (her own deck, re-read
// through her session); the route then reads that slide from the deck's text
// map (selection.ts, admin client) and makes ONE model call — no tools, 220
// tokens, the slide's title, text and speaker notes plus the HIGHLIGHTED part
// as DATA — grounded against the slide: meta → tool → text →
// done{grounded, sources: ["board.explain_selection", "deck"]}. Nothing on the
// Board moves. Nothing highlighted → SK's fixed "highlight it first" line.

// MODEL-FIRST (2026-10-30, docs/sk-model-first.md): with SK_ROUTING=model (or
// the user in SK_MODEL_FIRST_EMAILS) the rules router is not consulted. Only
// three things are decided before the model — the greeting offer's yes/no,
// a running tour's controls (`walk`), and a book code / SK's own book
// question — and everything else goes to the model (Haiku 5.5 for a short
// command, Sonnet 5.5 for teaching; routing.ts) with the role's full tool
// set. The tools' results drive the same events the rules emitted. One
// `sk-shell.turn timing` log line per turn, either routing.

const SK_SHELL_DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_TEXT = 600;

/** Run after the reply when Next can (`after`), else now without waiting. */
function later(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

/** A failed capability that is NOT a miss the user met: a rules hand-off to
 *  the model (not_allowed) or a cancelled turn. */
const GAP_SKIP_ERRORS: ReadonlySet<string> = new Set(["not_allowed", "aborted"]);

const enc = new TextEncoder();
const frame = (ev: SkTurnEvent) => enc.encode(`data: ${JSON.stringify(ev)}\n\n`);

type Gate =
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; user: { id: string; email?: string | null; email_confirmed_at?: string | null }; role: string | null; schoolId: string | null }
  | { ok: false; status: number; error: string };

async function gate(): Promise<Gate> {
  if (!skEnabled()) return { ok: false, status: 404, error: "Not available." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Not signed in." };
  const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!(await skShellEnabledFor(supabase, user, role, schoolId))) return { ok: false, status: 404, error: "Not available." };
  return { ok: true, supabase, user, role, schoolId };
}

function parseBody(raw: unknown): SkTurnRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Invalid body." };
  const b = raw as Record<string, unknown>;
  // 2026-10-31 (student Board phase 3): a teaching turn SK starts by itself
  // (a worksheet gap, the Extra step) carries no typed line of hers.
  const teach = parseTeachRequest(b.teach);
  const text = typeof b.text === "string" && b.text.trim() ? b.text.trim() : teach ? teachTurnText(teach) : "";
  if (!text) return { error: "Say something." };
  if (text.length > MAX_TEXT) return { error: `Keep it under ${MAX_TEXT} characters.` };
  const turnId = typeof b.turnId === "string" && b.turnId.trim() && b.turnId.length <= 80 ? b.turnId.trim() : "";
  if (!turnId) return { error: "turnId is required." };
  const modality = b.modality === "voice" ? "voice" : "text";
  const c = (b.collector && typeof b.collector === "object" ? b.collector : {}) as Record<string, unknown>;
  const clock = c.clock && typeof c.clock === "object" ? (c.clock as SkCollector["clock"]) : undefined;
  const collector: SkCollector = {
    path: typeof c.path === "string" ? c.path.slice(0, 300) : "/dashboard",
    params: c.params && typeof c.params === "object" ? (c.params as Record<string, string>) : undefined,
    selection: c.selection && typeof c.selection === "object" ? (c.selection as SkCollector["selection"]) : undefined,
    board: c.board && typeof c.board === "object" ? (c.board as SkCollector["board"]) : undefined,
    // S3 slice D: the student's kit player (sanitized in buildContext).
    tutor: c.tutor && typeof c.tutor === "object" ? (c.tutor as SkCollector["tutor"]) : undefined,
    clock:
      clock && typeof clock.day === "number" && typeof clock.minutes === "number" && typeof clock.iso === "string"
        ? { day: clock.day, minutes: clock.minutes, iso: clock.iso.slice(0, 40) }
        : undefined,
    locale: typeof c.locale === "string" ? c.locale.slice(0, 10) : undefined,
  };
  const memory = typeof b.memory === "string" && b.memory.length <= 64_000 ? b.memory : undefined;
  const spokenLang = modality === "voice" && typeof b.spokenLang === "string" && b.spokenLang.length <= 12 ? b.spokenLang : undefined;
  const walk = parseWalk(b.walk);
  return { turnId, text, modality, collector, memory, ...(spokenLang ? { spokenLang } : {}), ...(walk ? { walk } : {}), ...(teach ? { teach } : {}) };
}

/** 2026-10-30: the client's tour position — display only (a stop id and two
 *  numbers for one prompt line); anything malformed reads as no tour. */
function parseWalk(raw: unknown): SkTurnWalk | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const w = raw as Record<string, unknown>;
  if (w.active !== true) return undefined;
  const id = (v: unknown) => (typeof v === "string" ? v.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : "");
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100 ? v : 0);
  return { active: true, paused: w.paused === true, role: id(w.role), stop: id(w.stop), index: n(w.index), total: n(w.total) };
}

export async function POST(request: Request) {
  const t0 = Date.now();
  const g = await gate();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const body = parseBody(raw);
  if ("error" in body) return NextResponse.json({ error: body.error }, { status: 400 });

  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null; // plan → "unknown"; audit → memory sink
  }
  const cookieStore = await cookies();
  const now = new Date();
  const localeCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  const ctx = await loadContext({
    session: g.supabase,
    admin,
    cookies: cookieStore,
    user: g.user,
    profile: { role: g.role, school_id: g.schoolId },
    collector: body.collector,
    locale: isLocale(body.collector.locale) ? body.collector.locale : isLocale(localeCookie) ? localeCookie : "en",
    now,
  });

  // The student Board (learner mode, 2026-10-31): a student's Board state is
  // only as good as her assignments. The open unit (the lesson every Board
  // read keys on — the manifest, the deck text, the kit's book) must be
  // assigned to her (one of her own generation_shares rows, through her own
  // session); anything else drops the Board context for this turn.
  if (ctx.user.role === "student" && ctx.board?.generationId && !(await sharedToMe(g.supabase, ctx.board.generationId))) {
    console.warn("sk-shell.turn student board not assigned", JSON.stringify({ turnId: body.turnId }));
    ctx.board = undefined;
  }
  // The hidden fair-use cap (SK_STUDENT_DAILY_TURNS, default 300 a UTC day):
  // counted for every student turn, before anything is spent on it.
  const studentCap: CapOutcome | null = ctx.user.role === "student" ? await meterStudentTurn(admin, g.user.id, now) : null;
  if (studentCap && !studentCap.ok) console.info("sk-student.cap", JSON.stringify({ turnId: body.turnId, count: studentCap.count, cap: studentCap.cap }));
  /** Who a teaching call speaks to: the class, or one student on her own Board. */
  const audience = ctx.user.role === "student" ? TEACH_AUDIENCE_STUDENT : TEACH_AUDIENCE_CLASS;

  let memory = openMemory(body.memory, ctx, now).memory;
  // 2026-10-30: the language SK answers in, decided HERE, once, before any
  // model call (shell/language.ts):
  //   a command in this message ("say that in X" — runLanguage below)
  //   > the language this message is written in, when confident
  //   > the conversation's language (memory.langOverride — sticky)
  //   > the ONE language of the kit open on the Board / her player
  //   > the UI locale.
  // A confident question language becomes the conversation's language
  // (langOverride, cleared when it is what SK would answer in anyway), so
  // "ok" / "next" stay in it. The fixed lines follow the answer language
  // too: ctx.user.locale becomes the lines' locale (zh → English lines; the
  // model still answers in Chinese).
  const uiLocale = ctx.user.locale;
  const preSources = [ctx.board?.sessionId ? ctx.board.language : undefined, ctx.user.role === "student" ? ctx.tutor?.language : undefined].filter((x): x is string => !!x);
  // (A dictated question also carries the language Transcribe heard — a hint
  // the words override.)
  const question = parseLanguageCommand(body.text) ? null : spokenQuestionLanguage(body.text, body.spokenLang);
  const sticky = stickyAfterQuestion(question, memory.langOverride, { sourceLanguages: preSources, uiLocale });
  /** The answer language over a given set of source languages, this turn. */
  const langOver = (sources: ReadonlyArray<string | null | undefined>) => answerLanguage({ question, override: sticky, sourceLanguages: sources, uiLocale });
  let answer: AnswerLanguage = langOver(preSources);
  const setAnswer = (a: AnswerLanguage, override: SkAnswerLang | null) => {
    answer = a;
    ctx.answer = { lang: a.lang, from: a.from, override, uiLocale };
    ctx.user.locale = linesLocale(a.lang);
  };
  // ctx.answer.override is her choice THIS turn (the question's language, or
  // the conversation's): tutor.ts and the kit turn honour it over a kit's.
  setAnswer(answer, question ?? sticky);
  // The conversation's resolved entities (signed memory) become ctx.recent, so a
  // capability can resolve "their parents" from the last not-done list (§5.4).
  ctx.recent = { ...ctx.recent, entities: memory.entities };
  // S4 slice D: what SK asked for last turn (book.activate: the order number
  // or the child), so the rules can take the short answer.
  if (memory.pending) ctx.pending = memory.pending;
  const allowed = allowedFor(ctx);
  const sink = auditSinkFor(admin);
  // 2026-10-30: the routing for this user (SK_ROUTING / SK_MODEL_FIRST_EMAILS).
  // Model-first decides only the book code here (routing.ts); the offer's
  // yes/no and the running tour's controls are checked below, as before.
  const routing = skRouting(g.user.email);
  const decision = routing === "model" ? modelFirstDecision(body.text, ctx) : routeByRules(body.text, ctx, now, body.collector.clock);
  /** One line per turn (finish): the route taken, the model, timings, tokens. */
  const timing: {
    route: string;
    model: ModelStats | null;
    firstTextMs: number | null;
    toolCalls: number;
    usage?: Usage;
    /** SK_DEBUG_EMAILS only: the tools called and the reply, for the debug line. */
    tools: string[];
    reply: string;
  } = { route: decision.intent, model: null, firstTextMs: null, toolCalls: 0, tools: [], reply: "" };
  // 2026-10-31 (SK gap tracker, src/sk/gaps): every way SK could not help
  // this turn — its own sk.note_gap, a built-in refusal, a failed tool, a
  // grounding drop — noted here and written ONCE in finish(), after the reply.
  const gaps = new TurnGaps();
  // 2026-10-31 (student Board phase 3): a TEACHING turn — SK's short lesson in
  // the chat, or its reply to her check answer. Teaching is SK doing its job,
  // not missing it: such a turn writes no gap rows unless SK FAILED it (the
  // model errored or wrote nothing usable — `failed`).
  const teachTurn: { on: boolean; failed: boolean } = { on: false, failed: false };
  // S2: the greeting's one-turn offer ("Your kit for … is ready — want me to
  // open it?"). A bare yes / "open it" opens it, a no declines; anything else
  // runs as usual and the offer lapses (rememberTurn drops it).
  const offer = memory.offer ?? null;
  const offerReply = offer && decision.intent !== "teach" ? offerAnswer(body.text) : null;

  // One controller, two sources: the request's own signal (client gone) and
  // the stream's cancel() (reader let go). Same pattern as /api/assistant.
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  if (request.signal?.aborted) abort.abort();
  else request.signal?.addEventListener("abort", onRequestAbort, { once: true });

  const deps: RunnerDeps = {
    session: g.supabase,
    now,
    clock: body.collector.clock,
    signal: abort.signal,
    sink,
    sessionId: memory.sessionId,
    turnId: body.turnId,
    // One read memo for THIS turn: the capabilities the model calls together
    // (assignments.status + learners.risk on "how are my classes") share the
    // teacher's classes and enrollments instead of each reading them again.
    cache: new Map(),
    // S5 slice B: every leader school read this turn (the leader block below,
    // the model's tools, a board/start-lesson read in a leader hat) passes the
    // analytics gate and is metered ONCE — the audit row written BEFORE the
    // read, refused when that write fails; the shared 60/day counter.
    schoolRead: schoolReadGate(ctx, g.supabase, body.turnId, now),
    // Gap tracker: a capability that failed in front of the user (tool_failed).
    onResult: (name, r) => {
      if (!r.ok && !GAP_SKIP_ERRORS.has(r.error ?? "")) gaps.note("tool_failed", { tool: name, error: r.error ?? null, summary: r.summary });
    },
  };

  // Board moves are audited against the PRESENT session (sk_actions.session_id:
  // "present session / assistant session, whichever applies") — that is the id
  // the recap route reads them back by. Everything else keeps the Shell's own.
  const boardDeps: RunnerDeps = ctx.board?.sessionId ? { ...deps, sessionId: ctx.board.sessionId } : deps;
  const boardGen = ctx.board?.sessionId && ctx.board.generationId ? ctx.board.generationId : null;

  /** A Board-local k (what the client holds) → the manifest segment id it sent,
   *  so the manifest is addressed by id and never by an index that differs
   *  between a part and the kit. Falls back to the spoken concept. */
  const refFor = (k: unknown, concept: unknown): TeachRef | null => {
    const seg = typeof k === "number" ? ctx.board?.segments?.find((x) => x.k === k) : undefined;
    if (seg?.id) return { segmentId: seg.id };
    if (typeof concept === "string" && concept.trim()) return { concept };
    return null;
  };

  const support = async (target: TeachTarget): Promise<TeachingSupport | null> => (admin && boardGen ? teachingSupport(admin, boardGen, target) : null);

  /** 2026-10-31: a model's text without tool-call markup (markup.ts) — logged
   *  with the turn id whenever any had to go. */
  const unmarked = (text: string, where: string): string => {
    const r = stripToolMarkup(text);
    if (r.stripped) console.warn("sk-shell.turn tool markup", JSON.stringify({ turnId: body.turnId, where }));
    return r.text;
  };

  /** practise: stamp the q_ids of the items mapped to the current segment into
   *  the args (they reach the client and the audit row the recap reads). A
   *  manifest that is not ready stamps nothing — the move still works. */
  const stampPractiseItems = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const b = ctx.board;
    if (!b || !boardGen || !admin) return args;
    const ref: TeachRef | null = b.segmentId ? { segmentId: b.segmentId } : typeof b.k === "number" ? refFor(b.k, null) : null;
    if (!ref) return args;
    try {
      const sup = await support(ref);
      if (!sup || sup.status !== "ready" || !sup.items.length) return args;
      const n = Math.max(1, Math.min(10, Number(args.n) || 3));
      return { ...args, items: sup.items.map((i) => i.q_id).slice(0, n) };
    } catch {
      return args;
    }
  };

  /** explain/compare: the teaching text. Null when the move carries no
   *  generation (the caller falls back to the `say` line); a not-ready
   *  manifest answers with SK's line + BOARD_NO_MAP and makes NO model call. */
  const teach = async (
    kind: "explain" | "compare",
    moveArgs: Record<string, unknown>,
    say: string,
  ): Promise<{ text: string; sources: string[]; lang?: SkAnswerLang; usage?: { inputTokens: number; outputTokens: number }; trimmed?: boolean } | null> => {
    if (!boardGen) return null;
    const name = `board.${kind}`;
    const a = (moveArgs.a ?? {}) as Record<string, unknown>;
    const b = (moveArgs.b ?? {}) as Record<string, unknown>;
    let target: TeachTarget | null = null;
    if (kind === "compare") {
      const ra = refFor(a.k ?? moveArgs.k, a.concept);
      const rb = refFor(b.k ?? moveArgs.next, b.concept);
      target = ra && rb ? { pair: [ra, rb] } : null;
    } else target = refFor(moveArgs.k, moveArgs.concept);
    const sup = target ? await support(target) : null;
    if (!sup || sup.status !== "ready") {
      // Not ready, missing, failed, or nothing matched: SK's own line, no model.
      return { text: `${say} ${BOARD_NO_MAP}`.trim(), sources: [name] };
    }
    // The manifest's own language (server truth) decides, under her override.
    const tl = langOver(sup.language ? [sup.language] : preSources);
    const provider = new AnthropicProvider(process.env.SK_SHELL_MODEL || SK_SHELL_DEFAULT_MODEL, skProviderTarget());
    const system = `${buildShellPrompt({ ctx, capabilities: allowed.map((c) => c.meta), memory })}\n${teachingBlock(sup)}`;
    let full = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const ev of runAssistantTurn({ provider, system, history: [], question: teachingQuestion(kind, sup, languageName(tl.lang), audience), tools: undefined, maxToolRounds: 0, maxTokens: TEACH_MAX_TOKENS, signal: abort.signal })) {
      if (ev.type === "text") full += ev.text;
      else if (ev.type === "done" || ev.type === "cancelled") usage = ev.usage;
      else if (ev.type === "error") console.error("sk-shell.turn teach", ev.retryable ? "retryable" : "fatal", ev.message);
    }
    full = unmarked(full, "teach");
    // A teaching call has no tools: any "I've sent / assigned …" is unbacked.
    const claims = actionClaimGuard(full);
    // §9.3: every name and number must occur in the narration (or the question).
    const verdict = groundingCheck(claims.text, [...teachingSupportTokens(sup), say], body.text);
    if (!verdict.ok || claims.dropped.length) {
      console.info("sk-shell.turn teach grounding", JSON.stringify({ turnId: body.turnId, unsupported: verdict.unsupported, dropped: [...claims.dropped, ...verdict.dropped] }));
      gaps.note("grounding", { where: "teach", unsupported: verdict.unsupported, claims: claims.dropped, dropped: verdict.dropped });
    }
    const text = (verdict.ok ? claims.text.trim() : verdict.text.trim()) || say;
    const cut = !verdict.ok || claims.dropped.length > 0;
    return { text, sources: [name, "manifest"], lang: tl.lang, ...(usage ? { usage } : {}), ...(cut && text !== say ? { trimmed: true } : {}) };
  };

  /** S7 K2: "explain X" on the Board when the lesson does not teach X — the
   *  KIT'S OWN book or article (never another source), ONE model call over
   *  its passages as DATA, grounded on them, with SK's citation line. Null
   *  when that source has nothing on it (the caller keeps its own line). */
  const boardKnowledge = async (
    concept: string,
  ): Promise<{ text: string; sources: string[]; lang: SkAnswerLang; citations: SkCitation[]; usage?: { inputTokens: number; outputTokens: number }; trimmed?: boolean } | null> => {
    const q = concept.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!q || !admin || !boardGen) return null;
    const kit = await kitSource(admin, boardGen);
    if (!kit || (!kit.bookId && !kit.articleId)) return null;
    const own = await kitOwnSources(ctx, deps, { bookId: kit.bookId, articleId: kit.articleId });
    if (!own.length) return null;
    const k = await searchForUser(ctx, deps, { query: q, restrict: own, limit: 4 });
    if (k.status !== "ok" || !k.passages.length) return null;
    const tl = langOver(k.passages.map((p) => p.language));
    const provider = new AnthropicProvider(process.env.SK_SHELL_MODEL || SK_SHELL_DEFAULT_MODEL, skProviderTarget());
    const system = `${buildShellPrompt({ ctx, capabilities: allowed.map((c) => c.meta), memory })}\n${knowledgeBlock(k.passages)}`;
    const question = `Explain "${q}" to ${audience} in 2–4 short sentences, in ${languageName(tl.lang)}, using only the passages in KNOWLEDGE (this lesson's own book). No headings, no lists.`;
    let full = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const ev of runAssistantTurn({ provider, system, history: [], question, tools: undefined, maxToolRounds: 0, maxTokens: TEACH_MAX_TOKENS, signal: abort.signal })) {
      if (ev.type === "text") full += ev.text;
      else if (ev.type === "done" || ev.type === "cancelled") usage = ev.usage;
      else if (ev.type === "error") console.error("sk-shell.turn board knowledge", ev.retryable ? "retryable" : "fatal", ev.message);
    }
    full = unmarked(full, "board_knowledge");
    const claims = actionClaimGuard(full);
    const verdict = groundingCheck(claims.text, knowledgeSupportTokens(k.passages), body.text);
    if (!verdict.ok || claims.dropped.length) gaps.note("grounding", { where: "board_knowledge", unsupported: verdict.unsupported, claims: claims.dropped, dropped: verdict.dropped });
    const said = (verdict.ok ? claims.text.trim() : verdict.text.trim()) || k.passages[0]!.text;
    const cite = citeLine(k.passages.map((p) => ({ title: p.source_title, chapter: p.chapter, section: p.section })), linesLocale(tl.lang));
    return {
      text: cite ? `${said}\n${cite}` : said,
      sources: ["board.explain", "knowledge.search"],
      lang: tl.lang,
      citations: citationsOf(k.passages),
      ...(usage ? { usage } : {}),
      ...(!verdict.ok || claims.dropped.length ? { trimmed: true } : {}),
    };
  };

  /** Phase 3: what a lesson in the chat stands on — the lesson map's segment
   *  for the concept (a worksheet item's OWN segment first, then the concept
   *  by name, then the slide on screen) and the kit's own book passages for
   *  it. Both as DATA; either may be missing (the lesson is then Extra). */
  const lessonSupport = async (
    req: SkTeachRequest,
    concept: string,
  ): Promise<{ sup: Extract<TeachingSupport, { status: "ready" }> | null; passages: Passage[] }> => {
    let sup: Extract<TeachingSupport, { status: "ready" }> | null = null;
    let kit: { bookId: string | null; articleId: string | null } | null = null;
    if (admin && boardGen) {
      try {
        const r = await readManifest(admin, boardGen);
        if (r.status === "ready") {
          const m = r.manifest;
          kit = { bookId: m.book_id ?? null, articleId: m.article_id ?? null };
          const item = req.questionId ? m.items.find((i) => i.q_id === req.questionId) : undefined;
          const here = ctx.board?.segmentId ? ({ segmentId: ctx.board.segmentId } as TeachRef) : refFor(ctx.board?.k, null);
          const tries: TeachRef[] = [...(item?.segment_ids?.[0] ? [{ segmentId: item.segment_ids[0] }] : []), ...(concept ? [{ concept }] : []), ...(here ? [here] : [])];
          for (const ref of tries) {
            const s = supportFrom(m, ref);
            if (s.status === "ready") {
              sup = s;
              break;
            }
          }
        }
      } catch {
        sup = null;
      }
    }
    let passages: Passage[] = [];
    const q = concept || sup?.segments[0]?.heading || "";
    if (kit && (kit.bookId || kit.articleId) && q) {
      try {
        const own = await kitOwnSources(ctx, deps, kit);
        if (own.length) {
          const k = await searchForUser(ctx, deps, { query: q, restrict: own, limit: 3 });
          if (k.status === "ok") passages = k.passages.slice(0, 3);
        }
      } catch {
        passages = [];
      }
    }
    return { sup, passages };
  };

  /** explain_selection: the highlighted part of a deck slide, explained from
   *  the slide's own text and notes. Called only after the capability said
   *  the selection is hers. Never moves the Board. */
  const explainSelection = async (): Promise<{
    text: string;
    sources: string[];
    label: "grounded" | "declined";
    usage?: { inputTokens: number; outputTokens: number };
    trimmed?: boolean;
    lang?: SkAnswerLang;
  }> => {
    const name = "board.explain_selection";
    const sel = ctx.board?.selection;
    const noSelection = sayFor("no_selection", ctx.user.locale);
    if (!sel) return { text: noSelection, sources: [], label: "declined" };
    // 2026-10-31: a page with no words SK can read (her handwriting).
    if (sel.on === "page") return { text: sayFor("selection_page", ctx.user.locale), sources: [name], label: "declined" };
    // A video slide's frame: that slide as a whole, from the lesson map's
    // narration (the board.explain teaching call), said as such.
    if (sel.on === "video") {
      const k = sel.n - 1;
      const lead = sayFor("selection_video", ctx.user.locale, { n: sel.n });
      const heading = ctx.board?.segments?.find((x) => x.k === k)?.heading || sel.title || "";
      const taught = await teach("explain", { k, ...(heading ? { concept: heading } : {}) }, sayFor("explain", ctx.user.locale, { heading: heading || `${sel.n}` }));
      if (!taught) return { text: BOARD_NO_MAP, sources: [name], label: "declined" };
      const grounded = taught.sources.includes("manifest");
      return {
        text: `${lead} ${taught.text}`,
        sources: grounded ? [name, "manifest"] : [name],
        label: grounded ? "grounded" : "declined",
        ...(taught.usage ? { usage: taught.usage } : {}),
        ...(taught.trimmed ? { trimmed: true } : {}),
        ...(taught.lang ? { lang: taught.lang } : {}),
      };
    }
    // A deck page: the deck's own text map, else — an adopted kit's deck —
    // the open unit's sibling deck piece through the kit (#233).
    let slide = admin ? await loadSelectionSlide(admin as unknown as SelectionAdmin, sel, ctx.user.id) : null;
    if (!slide) {
      const s = await openUnitDeckSlide(ctx, sel.generationId, sel.n, g.supabase);
      if (s) slide = { n: s.n, png: "", w: 0, h: 0, title: s.title, text: s.text, notes: s.notes, words: [], blocks: [] };
    }
    if (!slide) return { text: BOARD_SELECTION_NO_SLIDE, sources: [name], label: "declined" };
    // Only the words that are on the slide reach the model (selection.ts).
    const selected = selectionOnSlide(sel, slide);
    if (!selected) return { text: noSelection, sources: [name], label: "declined" };
    const fallback = sayFor("explain_selection", ctx.user.locale, { n: slide.n, text: clipWords(selected, 160) });
    const provider = new AnthropicProvider(process.env.SK_SHELL_MODEL || SK_SHELL_DEFAULT_MODEL, skProviderTarget());
    const system = `${buildShellPrompt({ ctx, capabilities: allowed.map((c) => c.meta), memory })}\n${selectionBlock(slide, selected)}`;
    let full = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const ev of runAssistantTurn({ provider, system, history: [], question: selectionQuestion(languageName(answer.lang), audience), tools: undefined, maxToolRounds: 0, maxTokens: TEACH_MAX_TOKENS, signal: abort.signal })) {
      if (ev.type === "text") full += ev.text;
      else if (ev.type === "done" || ev.type === "cancelled") usage = ev.usage;
      else if (ev.type === "error") console.error("sk-shell.turn selection", ev.retryable ? "retryable" : "fatal", ev.message);
    }
    full = unmarked(full, "selection");
    const claims = actionClaimGuard(full);
    // §9.3: every name and number must occur on the slide (text or notes) or in the question.
    const verdict = groundingCheck(claims.text, selectionSupportTokens(slide), body.text);
    if (!verdict.ok || claims.dropped.length) {
      console.info("sk-shell.turn selection grounding", JSON.stringify({ turnId: body.turnId, unsupported: verdict.unsupported, dropped: [...claims.dropped, ...verdict.dropped] }));
      gaps.note("grounding", { where: "selection", unsupported: verdict.unsupported, claims: claims.dropped, dropped: verdict.dropped });
    }
    const text = (verdict.ok ? claims.text.trim() : verdict.text.trim()) || fallback;
    const cut = !verdict.ok || claims.dropped.length > 0;
    return { text, sources: [name, "deck"], label: "grounded", ...(usage ? { usage } : {}), ...(cut && text !== fallback ? { trimmed: true } : {}) };
  };

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      abort.abort();
    },
    async start(controller) {
      // S6 slice C: the turn's last navigate (a Board deep link names the
      // class and lesson the teacher opened — workflow.ts workflowFromTurn).
      let navigatedTo: string | null = null;
      // Gap tracker: the reply as sent (timing.reply keeps only 120 characters).
      let gapReply = "";
      /** 2026-10-31: the last line of defence — no tool-call markup is ever
       *  sent, spoken or stored, whichever path wrote the text (markup.ts). */
      const shown = (text: string, where: string): string => cleanReply(text, ctx.user.locale, () => console.warn("sk-shell.turn tool markup", JSON.stringify({ turnId: body.turnId, where })));
      const send = (raw: SkTurnEvent) => {
        const ev: SkTurnEvent = raw.type === "text" ? { ...raw, text: shown(raw.text, "send") } : raw;
        if (ev.type === "navigate") navigatedTo = ev.path;
        if (ev.type === "text" && timing.firstTextMs === null) timing.firstTextMs = Date.now() - t0;
        if (ev.type === "tool") {
          timing.toolCalls++;
          timing.tools.push(ev.name);
        }
        if (ev.type === "text" && timing.reply.length < 120) timing.reply += ev.text;
        if (ev.type === "text" && gapReply.length < 1000) gapReply = (gapReply + ev.text).slice(0, 1000);
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(frame(ev));
        } catch {
          /* client gone */
        }
      };
      let logged = false;
      let loggedDebug = false;
      let gapsWritten = false;
      const finish = () => {
        // 2026-10-31: the turn's misses, once, after the reply (never slows it).
        // The question is stored AS ASKED — book codes are NOT masked here
        // (founder decision 2026-10-31); every log line still masks them.
        if (!gapsWritten) {
          gapsWritten = true;
          // A teaching turn SK carried out is not a gap (its lesson can say
          // "you can't divide by zero" without the phrase net taking it).
          const rows = teachTurn.on && !teachTurn.failed ? [] : gaps.rows({
            turnId: body.turnId,
            userId: g.user.id,
            role: ctx.user.role,
            locale: uiLocale,
            page: body.collector.path,
            modality: body.modality,
            question: body.text,
            reply: gapReply,
            route: timing.route,
            tools: timing.tools,
          });
          if (rows.length && admin) {
            const db = admin;
            later(() => recordGaps(db, rows));
          }
        }
        if (!logged) {
          logged = true;
          // Server-side only, never an env value: the routing, the route the
          // turn took, the model(s), time to first token / first text, total,
          // tool rounds and calls, and the tokens (cache included).
          const m = timing.model;
          const u = timing.usage;
          console.info(
            "sk-shell.turn timing",
            JSON.stringify({
              turnId: body.turnId,
              routing,
              route: timing.route,
              role: ctx.user.role,
              region: skRegionLabel(),
              model: m ? { tier: m.tier, models: m.models, escalated: m.escalated } : null,
              ttftMs: m?.firstTokenMs ?? null,
              firstTextMs: timing.firstTextMs,
              totalMs: Date.now() - t0,
              rounds: m?.rounds ?? 0,
              toolCalls: timing.toolCalls,
              tokens: u ? { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens ?? 0, cacheWrite: u.cacheWriteTokens ?? 0 } : null,
            }),
          );
        }
        // 2026-10-30: testers only (SK_DEBUG_EMAILS) — what was heard (voice)
        // or typed, the route, the model and tools, the reply. A book code
        // in the text is masked, as everywhere it is logged.
        if (!loggedDebug && skDebugFor(g.user.email)) {
          loggedDebug = true;
          console.info(
            "sk-shell.turn debug",
            JSON.stringify({
              turnId: body.turnId,
              modality: body.modality,
              text: maskBookSecrets(body.text).slice(0, 200),
              route: timing.route,
              model: timing.model ? timing.model.models.join(">") : null,
              tools: timing.tools,
              reply: timing.reply.slice(0, 120),
            }),
          );
        }
        request.signal?.removeEventListener("abort", onRequestAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      // 2026-10-30: the language each answer goes out in — sent before its
      // text (direction, read-aloud voice; dictation too when she chose it).
      // The page's own language is the default and needs no event.
      let sentLang: SkAnswerLang = uiAnswerLang(uiLocale);
      let sentOverride = false;
      // `override` tells the client the language is HERS (dictation follows
      // it): the conversation's sticky language, or this message's own when
      // it differs from the page's.
      const hers = () => sticky !== null || (answer.from === "question" && answer.lang !== uiAnswerLang(uiLocale));
      const sendLang = (lang: SkAnswerLang, override = languageChosen(answer) && hers()) => {
        if (sentLang === lang && sentOverride === override) return;
        sentLang = lang;
        sentOverride = override;
        send({ type: "lang", ...langMeta(lang), override });
      };
      let noted: string | undefined;
      // 2026-10-30: a language command reached through the MODEL's tool
      // (set_answer_language / repeat_in_language) is a language turn too —
      // its line is never kept as the "last explanation" — and the model
      // round that chose it is counted in that turn's usage.
      let langTurn = decision.intent === "lang";
      let carried: { inputTokens: number; outputTokens: number } | undefined;
      // The model round's prompt-cache tokens, for the timing line only.
      let carriedCache: Pick<Usage, "cacheReadTokens" | "cacheWriteTokens"> | undefined;
      const done = (
        ev: Omit<Extract<SkTurnEvent, { type: "done" }>, "type" | "latencyMs" | "memory">,
        assistantText: string,
        entities: ResolvedEntity[],
        pending?: SkMemory["pending"] | null,
        lang?: { langOverride: SkAnswerLang | null },
        /** Phase 3: the conversation's taught concepts, and SK's check question for the next turn. */
        taughtMem?: { taught?: string[]; teachCheck?: { concept: string; question: string } },
      ) => {
        assistantText = shown(assistantText, "memory");
        // S4 slice D: a book code / order number typed to SK is never remembered
        // (the memory travels to the browser and back into later prompts), and
        // book.activate's pending question lasts exactly one turn.
        const keep = pending !== undefined ? pending : memory.pending?.task === "book.activate" ? null : undefined;
        // 2026-10-30: the last explanation, whole, for "say that in Malay" — an
        // answer (grounded or supplementary), never a navigation, a refusal, a
        // pleasantry or a repeat (a repeat re-says the ORIGINAL, so "now in
        // Arabic" translates from the source, not from the Malay).
        const keepLast =
          !langTurn && decision.intent !== "chat" && (ev.label === "grounded" || ev.label === "supplementary") && !!assistantText.trim() && assistantText !== SK_NOTHING_ON_THAT;
        memory = rememberTurn(
          memory,
          {
            user: maskBookSecrets(body.text),
            assistant: assistantText,
            entities,
            pending: keep,
            ...(keepLast ? { lastAnswer: { text: assistantText, lang: sentLang, label: ev.label as "grounded" | "supplementary", sources: ev.sources } } : {}),
            // A command sets the conversation's language; otherwise a
            // confident question does (sticky; null clears).
            ...(lang ? { langOverride: lang.langOverride } : !langTurn && question && sticky !== (memory.langOverride ?? null) ? { langOverride: sticky } : {}),
            ...(noted ? { langNoted: noted } : {}),
            ...(taughtMem?.taught ? { taught: taughtMem.taught } : {}),
            ...(taughtMem?.teachCheck ? { teachCheck: taughtMem.teachCheck } : {}),
          },
          new Date(),
        );
        // S6 slice C: remember the class / lesson this turn used (adults only,
        // the owner's own session, time-boxed, never fails the turn).
        const notes = workflowFromTurn({ role: ctx.user.role, navigatePath: navigatedTo, entities, known: memory.entities });
        if (notes.length) void recordWorkflow(g.supabase as unknown as FactsDb, ctx.user.id, notes);
        const usage = carried ? { inputTokens: carried.inputTokens + (ev.usage?.inputTokens ?? 0), outputTokens: carried.outputTokens + (ev.usage?.outputTokens ?? 0) } : ev.usage;
        timing.usage = usage ? { ...(ev.usage as Usage | undefined), ...usage, ...(carriedCache ?? {}) } : undefined;
        send({ type: "done", ...ev, ...(usage ? { usage } : {}), latencyMs: Date.now() - t0, memory: sealMemory(memory) });
      };

      /** S1: turn a capability result's `board` / `confirm` into the event the
       *  client acts on. The token is issued HERE and nowhere else; when no
       *  secret is configured the action is declined, not executed weakly. */
      const actionEvent = async (r: SkCapabilityResult): Promise<{ event: SkTurnEvent; say: string } | { declined: string } | null> => {
        if (!r.ok) return null;
        if (r.board) {
          const say = r.board.say ?? r.summary;
          return { event: { type: "board", move: r.board.move, args: r.board.args ?? {}, say: r.board.say }, say };
        }
        if (r.confirm) {
          const issued = admin
            ? await issueActionToken(admin, { userId: ctx.user.id, action: r.confirm.action, params: r.confirm.params, contextHash: ctx.contextHash, now: new Date() })
            : null;
          if (!issued) {
            gaps.note("refusal", { kind: "cannot_confirm", action: r.confirm.action });
            return { declined: SK_CANNOT_CONFIRM };
          }
          return {
            // sealed_* params stay on the server (S4 slice D: a book code's HMAC).
            event: { type: "confirm", token: issued.token, action: r.confirm.action, title: r.confirm.title, params: publicParams(r.confirm.params) as Record<string, string | number | boolean | null>, expiresAt: issued.expiresAt },
            say: r.summary,
          };
        }
        return null;
      };

      /** START A LESSON with no Board session open (§2.7, start-lesson.ts):
       *  the user's words → the bar's pick → the timetable → a fixed line. The
       *  Board page starts the session from the deep link; nothing starts here.
       *  `named` are the filters the words already resolved to. Emits the
       *  rest of the turn and returns; no model is called on this path. */
      const startLesson = async (named: NavFilters, sources: string[], entities: ResolvedEntity[], missing: string | null) => {
        const plan = await planStartLesson(
          {
            ctx,
            db: g.supabase,
            run: async (name, args) => {
              const r = await runCapability(ctx, name, args, deps);
              send({ type: "tool", name, ok: r.ok, summary: r.summary.slice(0, 200) });
              return r;
            },
          },
          named,
        );
        const src = [...new Set([...sources, ...plan.sources])];
        if (plan.kind === "navigate") {
          const nav = await runCapability(ctx, "navigate", { target: "board", ...plan.filters }, deps);
          send({ type: "tool", name: "navigate", ok: nav.ok, summary: nav.summary });
          if (nav.ok && nav.navigate) {
            const line = plan.say ?? nav.summary;
            const text = missing ? `I couldn't find ${missing} — ${line}` : line;
            send({ type: "text", text });
            send({ type: "navigate", path: nav.navigate.path, label: nav.navigate.label });
            done({ sources: [...new Set([...src, "navigate"])], label: "navigation" }, text, [...entities, ...plan.entities]);
            return;
          }
          send({ type: "text", text: nav.summary });
          done({ sources: src, label: "declined" }, nav.summary, entities);
          return;
        }
        if (ctx.place.page === "board") {
          // On the Board with nothing to start: SK's own line, no navigate, no model.
          const text = lessonNotStarted(ctx.user.locale);
          send({ type: "text", text });
          done({ sources: [], label: "declined" }, text, entities);
          return;
        }
        // Elsewhere: the way to the Board, where she can pick.
        const nav = await runCapability(ctx, "navigate", { target: "board", ...(named.classId ? { classId: named.classId } : {}) }, deps);
        send({ type: "tool", name: "navigate", ok: nav.ok, summary: nav.summary });
        const text = missing ? `I couldn't find ${missing} — ${nav.summary}` : nav.summary;
        send({ type: "text", text });
        if (nav.ok && nav.navigate) {
          send({ type: "navigate", path: nav.navigate.path, label: nav.navigate.label });
          done({ sources: [...new Set([...src, "navigate"])], label: "navigation" }, text, entities);
        } else done({ sources: src, label: "declined" }, text, entities);
      };

      /** Model routing: "start the lesson (for 7B)" with nothing else named —
       *  the model's start_lesson call handed to the rules' planner (the
       *  Board's pick, then the timetable; start-lesson.ts). */
      const planLesson = async (args: Record<string, unknown>) => {
        const cls = typeof args.class === "string" ? args.class.trim().slice(0, 40) : "";
        const filters: NavFilters = {};
        const sources: string[] = [];
        const entities: ResolvedEntity[] = [];
        let missing: string | null = null;
        if (cls) {
          const r = await runCapability(ctx, "context.resolve", { query: cls, kind: "class" }, deps);
          send({ type: "tool", name: "context.resolve", ok: r.ok, summary: r.summary });
          const hit = (r.entities ?? []).find((e) => e.kind === "class");
          if (hit) {
            filters.classId = hit.id;
            entities.push(hit);
            sources.push("context.resolve");
          } else missing = `class "${cls}"`;
        }
        await startLesson(filters, sources, entities, missing);
      };

      /** S3 slice D: one tutor.* capability, start to finish, no model of the
       *  route's own. A move becomes a `tutor` event the panel performs on the
       *  kit player; a read (or tutor.explain's kit turn) carries its own
       *  grounded text in `reply`. */
      const runTutor = async (name: string, args: Record<string, unknown>) => {
        const r = await runCapability(ctx, name, args, deps);
        send({ type: "tool", name, ok: r.ok, summary: r.summary.slice(0, 200) });
        emitTutor(name, r);
      };
      /** A tutor.* result → its events (the rules path, or the MODEL's tool call). */
      const emitTutor = (name: string, r: SkCapabilityResult) => {
        if (r.ok && r.tutor) {
          const say = r.tutor.say ?? r.summary;
          send({ type: "tutor", move: r.tutor.move, args: r.tutor.args ?? {}, say: r.tutor.say });
          done({ sources: [name], label: "grounded" }, say, r.entities ?? []);
          return;
        }
        if (r.reply) {
          const text = r.reply.text || r.summary;
          // tutor.explain read the kit's own language: the answer is in it (unless she chose one).
          if (r.language && !languageChosen(answer)) sendLang(answerLanguage({ override: null, sourceLanguages: [r.language], uiLocale }).lang);
          send({ type: "text", text });
          done({ sources: r.reply.sources, label: r.reply.label, ...(r.reply.usage ? { usage: r.reply.usage } : {}), ...(r.reply.trimmed ? { trimmed: true } : {}), ...(r.citations?.length ? { citations: r.citations } : {}) }, text, r.entities ?? []);
          return;
        }
        send({ type: "text", text: r.summary });
        done({ sources: [], label: "declined" }, r.summary, []);
      };

      /** S7 K2: a student's content question with no lesson open — her own
       *  knowledge passages, ONE grounded model call metered once
       *  (tutor.ts knowledgeForStudent). False when nothing answers it. */
      const runStudentKnowledge = async (): Promise<boolean> => {
        const r = await knowledgeForStudent(ctx, body.text, deps);
        if (!r) return false;
        send({ type: "tool", name: "knowledge.search", ok: r.ok, summary: r.summary.slice(0, 200) });
        const text = r.reply?.text || r.summary;
        if (r.language && !languageChosen(answer)) sendLang(answerLanguage({ override: null, sourceLanguages: [r.language], uiLocale }).lang);
        send({ type: "text", text });
        const reply = r.reply;
        done(
          {
            sources: reply?.sources ?? [],
            label: reply?.label ?? "declined",
            ...(reply?.usage ? { usage: reply.usage } : {}),
            ...(reply?.trimmed ? { trimmed: true } : {}),
            ...(r.citations?.length ? { citations: r.citations } : {}),
          },
          text,
          [],
        );
        return true;
      };

      /** 2026-10-30: "say that in Malay" / "back to English". A repeat makes
       *  ONE translation call on the last answer (a student with her kit open:
       *  through the kit turn, metered once); everything else is SK's line. */
      const runLanguage = async (cmd: LangCommand) => {
        const code = targetCode(cmd.target, uiLocale);
        if (!code) {
          gaps.note("refusal", { kind: "language_unsupported", target: cmd.target });
          sendLang(answer.lang);
          const text = langLine(LANG_CAN_SPEAK, answer.lang, { list: canSpeakList() });
          send({ type: "text", text });
          done({ sources: [], label: "declined" }, text, []);
          return;
        }
        if (cmd.kind === "back") {
          const next = overrideForBack(code, { sourceLanguages: preSources, uiLocale });
          setAnswer(answerLanguage({ override: next, sourceLanguages: preSources, uiLocale }), next);
          sendLang(answer.lang, next !== null);
          const text = langLine(LANG_SWITCHED, answer.lang, { language: ownName(answer.lang) });
          send({ type: "text", text });
          done({ sources: [], label: "supplementary" }, text, [], undefined, { langOverride: next });
          return;
        }
        const last = memory.lastAnswer;
        if (!last) {
          sendLang(answer.lang);
          const text = langLine(LANG_NOTHING_TO_REPEAT, answer.lang);
          send({ type: "text", text });
          done({ sources: [], label: "declined" }, text, []);
          return;
        }
        // From here on SK answers in `code` until she says otherwise.
        setAnswer({ lang: code, from: "override" }, code);
        sendLang(code, true);
        const sources = [...new Set([...last.sources, "sk.repeat"])];
        if (last.lang === code) {
          // Already in that language: say it again, no model.
          send({ type: "text", text: last.text });
          done({ sources: last.sources, label: last.label }, last.text, [], undefined, { langOverride: code });
          return;
        }
        if (ctx.user.role === "student" && ctx.tutor) {
          const r = await repeatForStudent(ctx, { original: last.text, target: code, question: body.text }, deps);
          const text = r.text || last.text;
          send({ type: "text", text });
          done({ sources: r.label === "grounded" ? sources : [], label: r.label === "grounded" ? last.label : "declined", ...(r.usage ? { usage: r.usage } : {}), ...(r.trimmed ? { trimmed: true } : {}) }, text, [], undefined, { langOverride: code });
          return;
        }
        const r = await repeatAnswer({ provider: new AnthropicProvider(skTranslateModel(), skProviderTarget()), original: last.text, target: code, question: body.text, signal: abort.signal });
        if (r.cancelled) return;
        send({ type: "text", text: r.text });
        done({ sources, label: last.label, ...(r.usage ? { usage: r.usage } : {}), ...(r.trimmed ? { trimmed: true } : {}) }, r.text, [], undefined, { langOverride: code });
      };

      /** "Highlight and ask SK" (2026-10-31): board.explain_selection validated
       *  (audited against the present session), then ONE grounded call
       *  (explainSelection). The rules' move, model routing's pre-rule and the
       *  model's hand-off all end here, so each says the same thing. */
      const runSelection = async () => {
        const name = "board.explain_selection";
        const r = await runCapability(ctx, name, {}, boardDeps);
        send({ type: "tool", name, ok: r.ok, summary: r.summary.slice(0, 200) });
        if (!r.ok) {
          send({ type: "text", text: r.summary });
          done({ sources: [], label: "declined" }, r.summary, []);
          return;
        }
        const s = await explainSelection();
        if (s.lang) sendLang(s.lang);
        send({ type: "text", text: s.text });
        done({ sources: s.sources, label: s.label, ...(s.usage ? { usage: s.usage } : {}), ...(s.trimmed ? { trimmed: true } : {}) }, s.text, []);
      };

      /** 2026-10-30: a tour / language control the MODEL chose (shell-controls.ts),
       *  performed as its rule performs it. `used` = the model round's usage. */
      const runControl = async (t: ToolTrace, used?: { inputTokens: number; outputTokens: number }) => {
        carried = used;
        const r = t.result;
        if (r.walkthrough === "start") {
          const text = lineFor(WALKTHROUGH_START, ctx.user.locale);
          send({ type: "walkthrough" });
          send({ type: "text", text });
          done({ sources: [t.name], label: "navigation" }, text, []);
          return;
        }
        if (r.walkthrough) {
          send({ type: "walkthrough", action: r.walkthrough });
          done({ sources: [t.name], label: "navigation" }, "", []);
          return;
        }
        if (r.langCommand) {
          langTurn = true;
          await runLanguage(r.langCommand as LangCommand);
        }
      };

      /** Phase 3: SK could not teach (the model failed or wrote nothing usable).
       *  The ONE teaching outcome the gap tracker records. */
      const teachFailed = (where: string, error: string, usage?: { inputTokens: number; outputTokens: number }) => {
        teachTurn.failed = true;
        gaps.note("tool_failed", { tool: where, error });
        const text = lineFor(COULD_NOT_DO, ctx.user.locale);
        send({ type: "text", text });
        done({ sources: [], label: "declined", ...(usage ? { usage } : {}) }, text, []);
      };

      /**
       * Phase 3 (student Board, 2026-10-31): SK TEACHES in the chat — a short
       * structured lesson (learn-teach.ts): idea → steps → a worked example
       * with new numbers → a check question. ONE model call, no tools, SK's
       * shell model through the same provider path (Bedrock overlay) as every
       * other SK turn. Grounded on the lesson map and the kit's book first;
       * what the kit does not carry is labelled Extra. The worksheet's answer
       * is never sent to the model and any line carrying it is dropped.
       */
      const runTeach = async (req: SkTeachRequest, conceptIn: string | null) => {
        teachTurn.on = true;
        timing.route = `teach_${req.trigger}`;
        const segHeading = typeof ctx.board?.k === "number" ? ctx.board.segments?.find((x) => x.k === ctx.board?.k)?.heading : undefined;
        let concept = (conceptIn || req.concept || (req.questionText ? clipWords(req.questionText, 120) : "") || "").trim();
        const { sup, passages } = await lessonSupport(req, concept || segHeading || "");
        concept = concept || sup?.segments[0]?.concept || sup?.segments[0]?.heading || segHeading || "this lesson";
        const tl = langOver([sup?.language, ...passages.map((p) => p.language)].filter((x): x is string => !!x));
        // The kit's own picture, looked up beside the model call (students only: her deck).
        const picture = ctx.user.role === "student" ? openUnitDeckPicture(ctx, concept, bestSlide, g.supabase).catch(() => null) : Promise.resolve(null);
        const provider = new AnthropicProvider(process.env.SK_SHELL_MODEL || SK_SHELL_DEFAULT_MODEL, skProviderTarget());
        const system = teachSystem({
          req,
          concept,
          language: languageName(tl.lang),
          blocks: [sup ? teachingBlock(sup) : "", passages.length ? knowledgeBlock(passages) : ""],
          lessonTitle: sup?.segments[0]?.heading || segHeading || null,
          taught: memory.taught,
        });
        let full = "";
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        let failed = false;
        for await (const ev of runAssistantTurn({ provider, system, history: [], question: teachQuestion({ req, concept, language: languageName(tl.lang) }), tools: undefined, maxToolRounds: 0, maxTokens: TEACH_LESSON_MAX_TOKENS, signal: abort.signal })) {
          if (ev.type === "text") full += ev.text;
          else if (ev.type === "done" || ev.type === "cancelled") usage = ev.usage;
          else if (ev.type === "error") {
            failed = true;
            console.error("sk-shell.turn learn teach", ev.retryable ? "retryable" : "fatal", ev.message);
          }
        }
        if (abort.signal.aborted) return;
        const parsed = failed ? null : parseLesson(unmarked(full, "learn_teach"));
        if (!parsed) return teachFailed("sk.teach", failed ? "provider" : full.trim() ? "unparsed" : "empty", usage);

        // 1. No claimed action (a lesson has no tools: "I've sent …" is unbacked).
        let claimDrops = 0;
        const claimFree = (s: string) => {
          const r = actionClaimGuard(s);
          if (r.dropped.length) claimDrops++;
          return r.text.trim();
        };
        let lesson: TeachLesson = {
          ...parsed,
          title: claimFree(parsed.title),
          idea: claimFree(parsed.idea),
          steps: parsed.steps.map(claimFree).filter(Boolean),
          example: claimFree(parsed.example),
          work: parsed.work.map(claimFree).filter(Boolean),
          result: claimFree(parsed.result),
          check: claimFree(parsed.check),
        };
        // 2. The idea and steps must stand on the kit (strict, §9.3) — or the
        //    lesson is Extra. The Extra step after the kit always is.
        const kitSupport: unknown[] = [...(sup ? teachingSupportTokens(sup) : []), ...(passages.length ? knowledgeSupportTokens(passages) : [])];
        const asked = [body.text, req.questionText ?? "", concept].join(" ");
        let extra = req.trigger === "extra" || lesson.source === "extra" || kitSupport.length === 0;
        if (!extra && !kitParts(lesson).every((p) => groundingCheck(p, [...kitSupport, concept], asked).ok)) extra = true;
        // 3. Every line SK wrote itself: no invented person, no contact or link.
        const supportText = [asked, ...kitSupport.flat(2).filter((x) => typeof x === "string" || typeof x === "number")].join(" ");
        let ownDrops = 0;
        const own = (s: string) => {
          if (s && ownLineIssues(s, supportText, personNameWords).length) {
            ownDrops++;
            return "";
          }
          return s;
        };
        lesson = extra
          ? { ...lesson, title: own(lesson.title), idea: own(lesson.idea), steps: lesson.steps.map(own).filter(Boolean), example: own(lesson.example), work: lesson.work.map(own).filter(Boolean), result: own(lesson.result), check: own(lesson.check) }
          : { ...lesson, title: own(lesson.title), example: own(lesson.example), work: lesson.work.map(own).filter(Boolean), result: own(lesson.result), check: own(lesson.check) };
        // 4. Never her worksheet's answer (read here, server-side only, for this check).
        const answerKey = req.trigger === "gap" ? await openUnitAnswer(ctx, req, g.supabase).catch(() => null) : null;
        const guarded = guardAnswer(lesson, { answer: answerKey, questionText: req.questionText, concept });
        lesson = guarded.lesson;
        if (!lesson.idea && !lesson.steps.length) return teachFailed("sk.teach", "nothing_left", usage);

        const text = renderLesson(lesson, headingsFor(linesLocale(tl.lang)), extra);
        const pic = await picture;
        const trimmed = claimDrops + ownDrops + guarded.removed > 0;
        const citations = !extra && passages.length ? citationsOf(passages).slice(0, 3) : [];
        sendLang(tl.lang);
        send({ type: "text", text });
        if (pic) send({ type: "picture", generationId: pic.generationId, n: pic.n, title: pic.title });
        done(
          {
            sources: ["sk.teach", ...(sup ? ["manifest"] : []), ...(passages.length ? ["knowledge.search"] : [])],
            label: extra ? "supplementary" : "grounded",
            ...(usage ? { usage } : {}),
            ...(trimmed ? { trimmed: true } : {}),
            ...(citations.length ? { citations } : {}),
            teach: { trigger: req.trigger, extra },
          },
          text,
          [],
          undefined,
          undefined,
          { taught: addTaught(memory.taught, concept), ...(lesson.check ? { teachCheck: { concept, question: lesson.check } } : {}) },
        );
        // Server-side only: never the answer, never her words.
        console.info(
          "sk-shell.teach",
          JSON.stringify({
            turnId: body.turnId,
            trigger: req.trigger,
            reason: req.reason ?? null,
            concept: concept.slice(0, 80),
            extra,
            manifest: !!sup,
            passages: passages.length,
            picture: !!pic,
            answerKnown: !!answerKey,
            answerGuard: guarded.removed,
            dropped: { claims: claimDrops, own: ownDrops },
            lang: tl.lang,
          }),
        );
        // 4 (plan item): "taught" is remembered per student + concept in the
        // 0173 learning facts — consent first (noteLearning is a no-op
        // without it). TODO(phase 4): key it to the concept's objective
        // (objective-key.ts) once phase 2's practice attempts (0178) carry one.
        if (admin && ctx.user.role === "student") {
          const db = admin as unknown as FactsDb & ConsentDb;
          const note = { concept: concept.slice(0, 160), trigger: req.trigger, extra, generation_id: boardGen, ...(req.questionId ? { question_id: req.questionId } : {}), lang: tl.lang };
          later(() => noteLearning(db, g.user.id, { kind: "explained", objectiveKey: null, detail: note, source: "sk.board.teach" }));
        }
      };

      /** Phase 3: her answer to SK's check question — ONE short call: right or
       *  not, and the step she missed (SK's own practice, not the worksheet). */
      const runCheckReply = async (check: { concept: string; question: string }) => {
        teachTurn.on = true;
        timing.route = "teach_check";
        const provider = new AnthropicProvider(process.env.SK_SHELL_MODEL || SK_SHELL_DEFAULT_MODEL, skProviderTarget());
        const p = checkReplyPrompt(check, body.text, languageName(answer.lang));
        let full = "";
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        let failed = false;
        for await (const ev of runAssistantTurn({ provider, system: p.system, history: [], question: p.question, tools: undefined, maxToolRounds: 0, maxTokens: TEACH_CHECK_MAX_TOKENS, signal: abort.signal })) {
          if (ev.type === "text") full += ev.text;
          else if (ev.type === "done" || ev.type === "cancelled") usage = ev.usage;
          else if (ev.type === "error") {
            failed = true;
            console.error("sk-shell.turn learn check", ev.retryable ? "retryable" : "fatal", ev.message);
          }
        }
        if (abort.signal.aborted) return;
        const said = failed ? "" : actionClaimGuard(unmarked(full, "learn_check")).text;
        const support = [check.concept, check.question, body.text].join(" ");
        const text = said
          .split(/(?<=[.!?؟।])\s+/u)
          .filter((s) => s.trim() && !ownLineIssues(s, support, personNameWords).length)
          .join(" ")
          .trim();
        if (!text) return teachFailed("sk.teach.check", failed ? "provider" : "empty", usage);
        send({ type: "text", text });
        done({ sources: ["sk.teach"], label: "supplementary", ...(usage ? { usage } : {}), teach: { trigger: "check", extra: false } }, text, []);
      };

      try {
        send({ type: "meta", sessionId: memory.sessionId, turnId: body.turnId, intent: decision.intent, capabilities: allowed.map((c) => c.meta.name) });
        // (A language command announces its own language.)
        if (decision.intent !== "lang") sendLang(answer.lang);

        // ── 2026-10-31: the student fair-use cap — SK's own line, no model ──
        if (studentCap && !studentCap.ok) {
          timing.route = "student_cap";
          const text = lineFor(SK_STUDENT_CAP_LINE, ctx.user.locale);
          send({ type: "text", text });
          done({ sources: [], label: "declined" }, text, []);
          finish();
          return;
        }
        // A source in a language SK cannot answer in (Tamil): said once per conversation.
        if (answer.unsupportedSource && memory.langNoted !== answer.unsupportedSource && decision.intent !== "lang") {
          noted = answer.unsupportedSource;
          gaps.note("refusal", { kind: "language_source_unsupported", language: answer.unsupportedSource });
          send({ type: "text", text: `${langLine(LANG_SOURCE_UNSUPPORTED, answer.lang, { source: answer.unsupportedSource, language: ownName(answer.lang) })} ` });
        }

        // ── 2026-10-30: a tour command while a tour is on ("Hi, continue with
        // the tour?") — the client's tour takes it; no model. (The client
        // catches the short forms itself; this is the backstop for longer
        // phrasing that names the tour.)
        const walkAct = body.walk?.active ? walkCommand(body.text, { loose: true }) : null;
        if (walkAct) {
          timing.route = "walk";
          send({ type: "walkthrough", action: walkAct });
          done({ sources: [], label: "navigation" }, "", []);
          finish();
          return;
        }

        // ── 2026-10-30: the answer-language commands — no teacher model ──────
        if (decision.intent === "lang") {
          await runLanguage(decision.command);
          finish();
          return;
        }

        // ── 2026-10-30: "Show me around" — the client replays the walkthrough.
        // No model, no capability, no write: the tour itself is static copy.
        if (decision.intent === "tour") {
          const text = lineFor(WALKTHROUGH_START, ctx.user.locale);
          send({ type: "walkthrough" });
          send({ type: "text", text });
          done({ sources: [], label: "navigation" }, text, []);
          finish();
          return;
        }

        // ── S2: the answer to the greeting's offer — deterministic, no model ──
        if (offer && offerReply) {
          timing.route = "offer";
          if (offerReply === "no") {
            // S6 slice C: a suggestion's offer gets a plain "All right." (the
            // kit line names the Library, which is only right for a kit).
            const text = lineFor(offer.target === "board" || offer.target === "read" ? SUGGEST_DECLINED : KIT_OFFER_DECLINED, ctx.user.locale);
            send({ type: "text", text });
            done({ sources: [], label: "supplementary" }, text, []);
            finish();
            return;
          }
          if (offer.target === "tutor" && ctx.tutor?.kit === offer.kit) {
            // S3 slice D: "Carry on?" answered on the kit's own page — play.
            await runTutor("tutor.play", { action: "play" });
            finish();
            return;
          }
          if (offer.target === "read") {
            // S6 slice C: "want the first?" / "want the list?" — exactly the
            // read the suggestion named, through the runner (registry re-checked).
            const r = await runCapability(ctx, offer.capability, offer.args, deps);
            send({ type: "tool", name: offer.capability, ok: r.ok, summary: r.summary.slice(0, 200) });
            send({ type: "text", text: r.summary });
            done({ sources: r.ok ? [offer.capability] : [], label: r.ok ? "grounded" : "declined" }, r.summary, r.entities ?? []);
            finish();
            return;
          }
          const navArgs: Record<string, unknown> =
            offer.target === "tutor"
              ? { target: "tutor", product: offer.product, chapter: offer.chapter, generationId: offer.kit }
              : offer.target === "board"
                ? { target: "board", classId: offer.classId, bookId: offer.bookId, chapterRef: offer.chapterRef, generationId: offer.generationId }
                : { target: offer.target, bookId: offer.bookId };
          const nav = await runCapability(ctx, "navigate", navArgs, deps);
          send({ type: "tool", name: "navigate", ok: nav.ok, summary: nav.summary });
          send({ type: "text", text: nav.summary });
          if (nav.ok && nav.navigate) {
            send({ type: "navigate", path: nav.navigate.path, label: nav.navigate.label });
            done({ sources: ["navigate"], label: "navigation" }, nav.summary, []);
          } else done({ sources: [], label: "declined" }, nav.summary, []);
          finish();
          return;
        }

        // ── S4 slice D: book activation — deterministic, no model ────────────
        // A code (any role), an activation phrase (student / parent) or the
        // answer to SK's own question runs book.activate directly: the code is
        // never part of a model prompt. A card is CLICK-ONLY (act.ts).
        if (decision.intent === "act" && decision.action === "book.activate") {
          timing.route = "book";
          const r = await runCapability(ctx, "book.activate", decision.book, deps);
          send({ type: "tool", name: "book.activate", ok: r.ok, summary: maskBookSecrets(r.summary).slice(0, 200) });
          const act = r.confirm ? await actionEvent(r) : null;
          if (act && "declined" in act) {
            send({ type: "text", text: act.declined });
            done({ sources: [], label: "declined" }, act.declined, [], null);
          } else if (act) {
            send({ type: "text", text: act.say });
            send(act.event);
            done({ sources: ["book.activate"], label: "grounded" }, act.say, r.entities ?? [], null);
          } else {
            send({ type: "text", text: r.summary });
            done({ sources: r.ok ? ["book.activate"] : [], label: r.ok ? "grounded" : "declined" }, r.summary, r.entities ?? [], r.pending ?? null);
          }
          finish();
          return;
        }

        // ── 2026-10-31 (student Board phase 3): SK teaches beyond the kit ────
        // On her own Board, before any Board move: a teaching turn the Board
        // started (a worksheet gap, the Extra step); her answer to SK's check
        // question; or she is lost ("I don't get it", "explain again", the same
        // question again) — SK switches to teach mode for that concept.
        if (studentOnBoard(ctx)) {
          if (body.teach) {
            await runTeach(body.teach, null);
            finish();
            return;
          }
          // Model routing decides nothing here, so the rules (pure) say whether
          // this is a Board command ("next page") rather than words of hers.
          const ruled = routing === "model" ? routeByRules(body.text, ctx, now, body.collector.clock) : decision;
          const check = memory.teachCheck;
          if (check && ruled.intent === "ask" && looksLikeAnswer(body.text)) {
            await runCheckReply(check);
            finish();
            return;
          }
          const confused = ruled.intent === "ask" || (ruled.intent === "teach" && ruled.move === "explain") ? confusionOf(body.text, memory.turns) : null;
          if (confused) {
            await runTeach({ trigger: "confusion" }, confused.concept);
            finish();
            return;
          }
        }

        // ── S3 slice D: a STUDENT turn never reaches the teacher model ───────
        // A tutor phrasing runs its tutor.* capability (moves and reads: no
        // model call); anything else that is not a navigate or a bare
        // acknowledgement is her question about the open lesson and goes to
        // tutor.explain — the kit turn, ONE grounded model call, metered once
        // — or, with no lesson open, to tutor.where (her chapters, no model).
        // (Model routing: a student's turn goes to the model with HER tools —
        // tutor.*, knowledge.search, navigate, start_lesson — and the registry
        // keeps every teacher action out of reach; see the hand-offs below.)
        // On her OWN Board (learner mode, 2026-10-31) a student's turn is a
        // Board turn instead: her Board moves by rules below, her questions to
        // the model with her tools (board.*, knowledge.search) — the Board's
        // own explain / knowledge path, never the dormant tutor.
        if (routing === "rules" && ctx.user.role === "student" && !studentOnBoard(ctx) && decision.intent !== "navigate" && decision.intent !== "chat") {
          // S7 K2: "what is osmosis?" / "explain osmosis" with no lesson open →
          // her knowledge first (an explain with no kit has no section to explain).
          const knowledgeFirst = !ctx.tutor && isContentQuestion(body.text) && (decision.intent !== "tutor" || decision.capability === "tutor.explain");
          if (knowledgeFirst && (await runStudentKnowledge())) {
            // answered from her knowledge
          } else if (decision.intent === "tutor") await runTutor(decision.capability, decision.args);
          else if (ctx.tutor) await runTutor("tutor.explain", { question: body.text });
          else await runTutor("tutor.where", {});
          finish();
          return;
        }

        // ── S1 Board move by rules: deterministic, audited, no model ─────────
        // (explain/compare add ONE teaching call once the slide is shown.)
        if (decision.intent === "teach") {
          const name = `board.${decision.move}`;
          const args = decision.move === "practise" ? await stampPractiseItems(decision.args) : decision.args;
          const r = await runCapability(ctx, name, args, boardDeps);
          send({ type: "tool", name, ok: r.ok, summary: r.summary });
          if (decision.move === "explain_selection" && r.ok) {
            // Content only: no `board` event, the video and the roll stay put.
            const s = await explainSelection();
            if (s.lang) sendLang(s.lang);
            send({ type: "text", text: s.text });
            done({ sources: s.sources, label: s.label, ...(s.usage ? { usage: s.usage } : {}), ...(s.trimmed ? { trimmed: true } : {}) }, s.text, []);
            finish();
            return;
          }
          const act = await actionEvent(r);
          if (act && "event" in act) {
            send(act.event);
            const taught = (decision.move === "explain" || decision.move === "compare") && r.board ? await teach(decision.move, r.board.args, act.say) : null;
            if (taught) {
              if (taught.lang) sendLang(taught.lang);
              send({ type: "text", text: taught.text });
              done({ sources: taught.sources, label: "grounded", ...(taught.usage ? { usage: taught.usage } : {}), ...(taught.trimmed ? { trimmed: true } : {}) }, taught.text, r.entities ?? []);
            } else done({ sources: [name], label: "grounded" }, act.say, r.entities ?? []);
          } else if (!r.ok && r.error === "no board") {
            if (decision.move === "intro") {
              // "Start the video" with no lesson running: start one (§2.7).
              await startLesson({}, [], [], null);
            } else if (ctx.place.page === "board") {
              // On the Board with no lesson: a Board move has nothing to act on.
              // SK's own line — never a navigate to the page she is on, and
              // never a model narrating it.
              const text = lessonNotStarted(ctx.user.locale);
              send({ type: "text", text });
              done({ sources: [], label: "declined" }, text, []);
            } else {
              // Elsewhere: say so and offer the way there.
              const nav = await runCapability(ctx, "navigate", { target: "board" }, deps);
              send({ type: "tool", name: "navigate", ok: nav.ok, summary: nav.summary });
              send({ type: "text", text: r.summary });
              if (nav.ok && nav.navigate) {
                send({ type: "navigate", path: nav.navigate.path, label: nav.navigate.label });
                done({ sources: ["navigate"], label: "navigation" }, r.summary, []);
              } else done({ sources: [], label: "declined" }, r.summary, []);
            }
          } else if (decision.move === "explain" && r.error === "no_match" && typeof decision.args.concept === "string") {
            // S7 K2: the lesson does not teach it → the kit's own book, if it does.
            const k = await boardKnowledge(decision.args.concept).catch(() => null);
            if (k) {
              sendLang(k.lang);
              send({ type: "text", text: k.text });
              done({ sources: k.sources, label: "grounded", citations: k.citations, ...(k.usage ? { usage: k.usage } : {}), ...(k.trimmed ? { trimmed: true } : {}) }, k.text, []);
            } else {
              send({ type: "text", text: r.summary });
              done({ sources: [], label: "declined" }, r.summary, []);
            }
          } else {
            const text = act && "declined" in act ? act.declined : r.summary;
            send({ type: "text", text });
            done({ sources: [], label: "declined" }, text, []);
          }
          finish();
          return;
        }

        // ── 2026-10-30: play a book chapter — start_lesson, no model ─────────
        // "play chapter 1 from the book": the tool resolves the book and the
        // chapter and returns the Board deep link (teacher, autostart) or the
        // Tutor chapter (student); a question ("which book?") or the
        // not-generated line is its own fixed line. A tool this context may
        // not use falls through to the model, like the parent block below.
        if (decision.intent === "navigate" && decision.lesson) {
          const l = decision.lesson;
          const args: Record<string, unknown> = { chapter: l.chapter, ...(l.book ? { book: l.book } : {}), ...(l.part ? { part: l.part } : {}), ...(l.class ? { class: l.class } : {}) };
          const r = await runCapability(ctx, "start_lesson", args, deps);
          if (r.error !== "not_allowed") {
            send({ type: "tool", name: "start_lesson", ok: r.ok, summary: r.summary.slice(0, 200) });
            send({ type: "text", text: r.summary });
            if (r.ok && r.navigate) {
              send({ type: "navigate", path: r.navigate.path, label: r.navigate.label });
              done({ sources: ["start_lesson", "navigate"], label: "navigation" }, r.summary, r.entities ?? []);
            } else done({ sources: r.ok ? ["start_lesson"] : [], label: r.ok ? "grounded" : "declined" }, r.summary, r.entities ?? []);
            finish();
            return;
          }
        }

        // ── Navigate: deterministic, audited, no model ───────────────────────
        if (decision.intent === "navigate" && !decision.lesson) {
          const sources: string[] = [];
          const entities: ResolvedEntity[] = [];
          const filters: Record<string, unknown> = { ...decision.filters };
          const lookups: Array<[string, "class" | "learner", string]> = [];
          if (decision.classQuery) lookups.push(["classId", "class", decision.classQuery]);
          if (decision.learnerQuery) lookups.push(["learnerId", "learner", decision.learnerQuery]);
          let missing: string | null = null;
          for (const [key, kind, query] of lookups) {
            const r = await runCapability(ctx, "context.resolve", { query, kind }, deps);
            send({ type: "tool", name: "context.resolve", ok: r.ok, summary: r.summary });
            const hit = (r.entities ?? []).find((e) => e.kind === kind);
            if (hit) {
              filters[key] = hit.id;
              entities.push(hit);
              sources.push("context.resolve");
            } else missing = `${kind} "${query}"`;
          }
          // A kit or chapter named for the Board ("… on Specialised Cells",
          // "… with Plant and Animal Cells"): her own kits by title, through
          // the library search; a ready-made kit opens as itself, a book's kit
          // as its chapter.
          if (decision.target === "board" && decision.kitQuery) {
            const hits = await searchLibrary(ctx, deps, decision.kitQuery, 40);
            const hit = pickKitHit(hits, decision.kitQuery);
            send({ type: "tool", name: "library.find", ok: true, summary: hit ? `Found "${hit.title}".` : `No kit matches "${decision.kitQuery}".` });
            if (hit) {
              Object.assign(filters, kitFilters(hit));
              entities.push({ kind: hit.bookId ? "chapter" : "generation", id: hit.id, label: hit.title, via: "library.find" });
              sources.push("library.find");
            } else missing = missing ? `${missing} or kit "${decision.kitQuery}"` : `kit "${decision.kitQuery}"`;
          }
          if (decision.target === "board" && decision.filters.autostart) {
            // Start the lesson: from the words when they named one, else from
            // the Board's pick or the timetable (start-lesson.ts).
            await startLesson(filters as NavFilters, sources, entities, namesLesson(filters as NavFilters) ? null : missing);
            finish();
            return;
          }
          const nav = await runCapability(ctx, "navigate", { target: decision.target, ...filters }, deps);
          send({ type: "tool", name: "navigate", ok: nav.ok, summary: nav.summary });
          if (nav.ok && nav.navigate) {
            const text = missing ? `I couldn't find ${missing} — ${nav.summary}` : nav.summary;
            send({ type: "text", text });
            send({ type: "navigate", path: nav.navigate.path, label: nav.navigate.label });
            done({ sources: [...new Set([...sources, "navigate"])], label: "navigation" }, text, entities);
          } else {
            send({ type: "text", text: nav.summary });
            done({ sources: [], label: "declined" }, nav.summary, entities);
          }
          finish();
          return;
        }

        // ── Bare acknowledgement with nothing pending ────────────────────────
        if (decision.intent === "chat") {
          send({ type: "text", text: decision.reply });
          done({ sources: [], label: "supplementary" }, decision.reply, []);
          finish();
          return;
        }

        // ── S4: a parent's question about a child — the child.* capability
        // answers itself (one block per child), deterministic, no model. A
        // capability this context may not use falls through to the model.
        if ("parent" in decision && decision.parent) {
          const name = decision.parent.capability;
          const r = await runCapability(ctx, name, decision.parent.args, deps);
          if (r.error !== "not_allowed") {
            send({ type: "tool", name, ok: r.ok, summary: r.summary.slice(0, 200) });
            send({ type: "text", text: r.summary });
            done({ sources: r.ok ? [name] : [], label: r.ok ? "grounded" : "declined" }, r.summary, r.entities ?? []);
            finish();
            return;
          }
        }

        // ── S5: a leader's school question — the school.health / leader-mode
        // capability answers itself (school or scope by hat), deterministic,
        // no model; every number is one of its facts. Not allowed → the model.
        if ("leader" in decision && decision.leader) {
          const name = decision.leader.capability;
          // S5 slice B: school analytics off for this school → the fixed line
          // (school.health carries the `analytics` flag, so the runner would
          // only say not_allowed and hand a school question to the model).
          if (ctx.flags.analytics !== true) {
            gaps.note("refusal", { kind: "analytics_off", capability: name });
            const text = lineFor(SM_ANALYTICS_OFF, ctx.user.locale);
            send({ type: "text", text });
            done({ sources: [], label: "declined" }, text, []);
            finish();
            return;
          }
          // The read is gated + metered inside runCapability (deps.schoolRead).
          const r = await runCapability(ctx, name, decision.leader.args, deps);
          if (r.error !== "not_allowed") {
            send({ type: "tool", name, ok: r.ok, summary: r.summary.slice(0, 200) });
            send({ type: "text", text: r.summary });
            done({ sources: r.ok ? [name] : [], label: r.ok ? "grounded" : "declined" }, r.summary, r.entities ?? []);
            finish();
            return;
          }
        }

        // ── The model, with the allowed tools ────────────────────────────────
        // Rules routing: the full model, as before. Model routing: Haiku or
        // Sonnet by the message (chooseModel), Haiku escalating to Sonnet
        // when its first round wants a teaching tool (SkModelProvider).
        if (routing === "model") timing.route = "model";
        const choice = routing === "model" ? chooseModel(body.text, ctx) : { tier: "full" as const, model: process.env.SK_SHELL_MODEL || SK_SHELL_DEFAULT_MODEL, reason: "rules" };
        const provider = new SkModelProvider(choice, (model) => new AnthropicProvider(model, skProviderTarget()), routing === "model" ? escalationTools(ctx) : new Set<string>(), t0);
        timing.model = provider.stats;
        const trace: ToolTrace[] = [];
        // The chip for a tool goes out the moment THAT tool finishes; the
        // orchestrator runs a round's tools side by side, so "the last trace
        // entry" would name the wrong one.
        // 2026-10-30: the model's safety net (shell-controls.ts). When it picks
        // start_tour / tour_control / set_answer_language / repeat_in_language
        // the model stops right there (no second round to narrate) and the
        // control runs exactly as its rule would: the same events, the same
        // memory override. Its own signal, so stopping it never cancels the turn.
        const modelAbort = new AbortController();
        const stopModel = () => modelAbort.abort();
        if (abort.signal.aborted) stopModel();
        else abort.signal.addEventListener("abort", stopModel, { once: true });
        const control: { hit: ToolTrace | null } = { hit: null };
        const onTrace = (t: ToolTrace) => {
          send({ type: "tool", name: t.name, ok: t.result.ok, summary: t.result.summary.slice(0, 200) });
          // A control (tour / language) — and, in model routing, a tutor move
          // or tutor.*'s own reply — IS the answer: stop the model there.
          const kind = handoffAfter(t.result);
          if (!control.hit && kind && (kind === "control" || routing === "model")) {
            control.hit = t;
            stopModel();
          }
        };
        const runShell = makeRunTool(ctx, deps, trace, onTrace);
        const runBoard = makeRunTool(ctx, boardDeps, trace, onTrace);
        // Model routing: a tool the route performs ITSELF, decided before it
        // runs (routing.ts handoffBefore) — a student's knowledge question
        // (her metered kit turn) and a bare "start the lesson" (the Board's
        // pick / the timetable). The model stops there.
        const before: { kind: HandoffBefore | null; args: Record<string, unknown> } = { kind: null, args: {} };
        // A board.* tool the model chose is audited against the present session too.
        const run = async (call: Parameters<typeof runShell>[0], signal?: AbortSignal): Promise<string> => {
          // Gap tracker (signal A): SK's own note — recorded, never run, never
          // traced (so it is not a tool that answered, a chip or an action).
          if (isNoteGapCall(call.name)) {
            const n = parseNoteGap(call.args);
            gaps.note("self", { wanted: n?.wanted ?? null, why: n?.why ?? null }, n?.wanted ?? null);
            return NOTE_GAP_RESULT;
          }
          const hb = routing === "model" ? handoffBefore(call.name, call.args ?? {}, ctx) : null;
          if (hb) {
            if (!before.kind) {
              before.kind = hb;
              before.args = call.args ?? {};
            }
            stopModel();
            return toolResultText({ ok: true, summary: "Handled by SK.", facts: [] });
          }
          return fromApiToolName(call.name).startsWith("board.") ? runBoard(call, signal) : runShell(call, signal);
        };
        const history: Turn[] = memory.turns.map((t) => ({ role: t.role, text: t.text }));
        // 2026-10-30: a tour is on in her tab — the model knows, so it never
        // says there is no tour, and points her at "continue the tour".
        const system = [buildShellPrompt({ ctx, capabilities: allowed.map((c) => c.meta), memory, routing, noteGap: true }), body.walk?.active ? walkPromptLine(body.walk) : ""].filter(Boolean).join("\n\n");
        let full = "";
        let usage: Usage | undefined;
        let cancelled = false;
        let failed = false;

        for await (const ev of runAssistantTurn({
          provider,
          system,
          history,
          question: body.text,
          // + sk.note_gap (gap tracker): intercepted in `run`, never a capability.
          tools: [...toToolDefs(allowed), NOTE_GAP_TOOL_DEF],
          runTool: run,
          maxToolRounds: 3,
          maxTokens: 600,
          signal: modelAbort.signal,
        })) {
          if (ev.type === "text") full += ev.text; // buffered: grounding runs before the client sees a word
          else if (ev.type === "done") usage = ev.usage;
          else if (ev.type === "cancelled") {
            cancelled = true;
            usage = ev.usage;
          } else if (ev.type === "error") {
            failed = true;
            // The raw provider message stays server-side (Vercel runtime logs);
            // the client only ever gets the friendly line.
            console.error("sk-shell.turn provider", ev.retryable ? "retryable" : "fatal", ev.message);
            send({ type: "error", message: ev.retryable ? "One moment — try that again in a few seconds." : "I couldn't answer that one. Try asking a different way?" });
          }
        }
        if (usage && (usage.cacheReadTokens || usage.cacheWriteTokens)) carriedCache = { cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens };
        if (before.kind && !failed && !abort.signal.aborted) {
          carried = usage;
          if (before.kind === "student_knowledge") {
            // As the rules path: her knowledge, else the open lesson, else her chapters.
            timing.route = "model>student_knowledge";
            if (!(await runStudentKnowledge())) {
              if (ctx.tutor) await runTutor("tutor.explain", { question: body.text });
              else await runTutor("tutor.where", {});
            }
          } else if (before.kind === "selection") {
            // 2026-10-31: the highlight, as the rules path explains it — the
            // slide read here, ONE grounded call; the model wrote nothing.
            timing.route = "model>selection";
            await runSelection();
          } else {
            timing.route = "model>lesson_plan";
            await planLesson(before.args);
          }
          finish();
          return;
        }
        if (control.hit && !failed && !abort.signal.aborted) {
          if (handoffAfter(control.hit.result) === "tutor") {
            timing.route = "model>tutor";
            carried = usage;
            emitTutor(control.hit.name, control.hit.result);
          } else await runControl(control.hit, usage);
          finish();
          return;
        }
        if (cancelled || failed) {
          finish();
          return;
        }

        // ── S1: a Board move or a confirm card the MODEL chose ───────────────
        // The last successful one wins; the token (if any) is issued before a
        // word reaches the client so a refusal can replace the text.
        const actHit = [...trace].reverse().find((t) => t.result.ok && (t.result.board || t.result.confirm));
        const act = actHit ? await actionEvent(actHit.result) : null;

        // ── Grounding (§2.3, §9.3) ───────────────────────────────────────────
        // Model routing: a tool that answered ok with its own line and no rows
        // ("No one is at risk", "Grade 6 is outside your scope") answered too —
        // the rules path said that line; so may the model.
        const productive = trace.filter(
          (t) =>
            (t.result.facts?.length ?? 0) > 0 ||
            !!t.result.navigate ||
            (t.result.entities?.length ?? 0) > 0 ||
            (t.result.ok && (!!t.result.board || !!t.result.confirm)) ||
            (routing === "model" && t.result.ok && !!t.result.summary.trim()),
        );
        const support = trace.flatMap((t) => [t.result.summary, ...(t.result.facts ?? [])]);
        // S5 slice E (§8.4 gates): a sentence claiming SK DID something —
        // deleted, emailed, posted, assigned, graded … (EN/MS/AR) — is dropped
        // before grounding. Nothing of act tier completes in this route (a
        // confirm-tier tool only issues a card; it runs at /api/sk/act), so no
        // completed action backs a claim here. The guard ignores the support
        // set, so the question's own words ("delete Amir's record") never
        // make "I have deleted Amir's record." pass.
        // 2026-10-31: a tool call written out as text (`<invoke …>`) is never
        // an answer: it goes before anything else reads the text (markup.ts).
        const markup = stripToolMarkup(full);
        if (markup.stripped) console.warn("sk-shell.turn tool markup", JSON.stringify({ turnId: body.turnId, where: "model", tools: trace.map((t) => t.name), left: markup.text.length }));
        const claims = actionClaimGuard(markup.text, []);
        const modelText = claims.text;
        // 2026-10-30: a clarifying question that names HER class, book,
        // chapter, child or school ("Do you mean a class like 7B …?") is not
        // invented — when the tools alone do not carry it, the check runs
        // again with her own context entities (context-entities.ts).
        // Model routing: the SOFTER check (prompt.ts soft mode) — contacts and
        // invented people always; numbers only where a sentence cites tool data.
        const verdict = await groundWithContext(modelText, support, body.text, () => contextEntities(ctx, deps), routing === "model" ? "soft" : "strict");
        if (!verdict.ok || claims.dropped.length || verdict.context) {
          // Server-side only: which tokens failed and what was dropped, so a
          // false positive can be diagnosed from the runtime logs (2026-10-28).
          console.info("sk-shell.turn grounding", JSON.stringify({ turnId: body.turnId, tools: trace.map((t) => t.name), unsupported: verdict.unsupported, claims: claims.dropped, dropped: verdict.dropped, context: verdict.context }));
          if (!verdict.ok || claims.dropped.length) gaps.note("grounding", { where: "model", unsupported: verdict.unsupported, claims: claims.dropped, dropped: verdict.dropped });
        }
        const navHit = [...trace].reverse().find((t) => t.result.ok && t.result.navigate)?.result.navigate;
        let text: string;
        let label: Extract<SkTurnEvent, { type: "done" }>["label"];
        let trimmed = false;
        // Model routing: a tool that answered with its own fixed line ("no
        // lesson is running", "outside your scope") says it; otherwise SK's line.
        const failedLine =
          routing === "model" ? [...trace].reverse().find((t) => !t.result.ok && t.result.summary.trim() && !["unknown_capability", "aborted", "not_allowed"].includes(t.result.error ?? ""))?.result.summary : undefined;
        if (trace.length && !productive.length) {
          text = failedLine ?? SK_NOTHING_ON_THAT;
          label = "declined";
        } else if (!trace.length && routing === "model" && !verdict.ok && verdict.text.trim()) {
          // Model routing, no tool: the sentences that passed the softer check
          // stand (SK's own phrasing); the blocked ones are gone.
          text = verdict.text.trim();
          label = "supplementary";
          trimmed = true;
        } else if (!trace.length) {
          text = verdict.ok && modelText.trim() ? modelText.trim() : SK_NOTHING_ON_THAT;
          label = verdict.ok && modelText.trim() ? "supplementary" : "declined";
        } else if (verdict.ok && modelText.trim()) {
          text = modelText.trim();
          label = navHit ? "navigation" : "grounded";
          trimmed = claims.dropped.length > 0;
        } else if (verdict.text) {
          // What the user sees is only the supported sentences, so the shown
          // text IS grounded; `trimmed` records that something was dropped.
          text = verdict.text;
          label = navHit ? "navigation" : "grounded";
          trimmed = true;
        } else {
          text = navHit ? `Opening ${navHit.label}.` : SK_NOTHING_ON_THAT;
          label = navHit ? "navigation" : "declined";
        }
        // The model wrote ONLY a tool call as text: nothing it said is left,
        // and "nothing on that" would be untrue — SK's honest line instead.
        if (markup.stripped && !modelText.trim() && (text === SK_NOTHING_ON_THAT || !text.trim())) {
          text = lineFor(COULD_NOT_DO, ctx.user.locale);
          label = "declined";
          trimmed = false;
        }
        if (act && "declined" in act) {
          // No token secret: the action is unavailable, whatever the model said.
          text = act.declined;
          label = "declined";
          trimmed = false;
        } else if (act) {
          // The move/card carries the grounded content; a silent model still
          // gets SK's own line for the transcript and the speaker.
          if (text === SK_NOTHING_ON_THAT) text = act.say;
          label = "grounded";
        }
        // The claim was dropped; say the true thing instead. A card this turn
        // already IS the confirm flow (its own line stands); otherwise: the
        // confirm-card line when a capability of that kind is open to this
        // user, else "I can't do that from here."
        if (claims.dropped.length && !(act && "event" in act && act.event.type === "confirm") && !(act && "declined" in act)) {
          const line = claimCorrection(claims.kinds, allowed.map((c) => c.meta.name), ctx.user.locale);
          // "I can't do that from here." is a refusal (the card line is not: it offers the way).
          if (line === lineFor(CLAIM_CANT, ctx.user.locale)) gaps.note("refusal", { kind: "action_claim", kinds: claims.kinds, line });
          if (text === SK_NOTHING_ON_THAT || !text.trim()) {
            text = line;
            label = "declined";
            trimmed = false;
          } else {
            text = `${text} ${line}`;
            trimmed = true;
          }
        }
        let sources = [...new Set(productive.map((t) => t.name))];
        // 2026-10-30: tool results that name their source's language decide
        // the answer's, when they agree (and she chose none).
        const toolLangs = productive.map((t) => t.result.language).filter((x): x is string => !!x);
        let finalLang: SkAnswerLang | null = toolLangs.length && !languageChosen(answer) ? answerLanguage({ override: null, sourceLanguages: [...preSources, ...toolLangs], uiLocale }).lang : null;
        // S1 slice C: the model chose explain/compare → the narration-grounded
        // teaching text replaces what the model wrote from headings alone.
        if (actHit && act && "event" in act && (actHit.name === "board.explain" || actHit.name === "board.compare") && actHit.result.board) {
          const taught = await teach(actHit.name === "board.explain" ? "explain" : "compare", actHit.result.board.args, act.say);
          if (taught) {
            if (taught.lang) finalLang = taught.lang;
            text = taught.text;
            label = "grounded";
            trimmed = !!taught.trimmed;
            sources = [...new Set([...sources, ...taught.sources])];
            if (taught.usage) usage = usage ? { inputTokens: usage.inputTokens + taught.usage.inputTokens, outputTokens: usage.outputTokens + taught.usage.outputTokens } : taught.usage;
          }
        }
        // The model chose explain_selection: the slide-grounded explanation
        // replaces what it wrote from the capability's facts alone.
        if (trace.some((t) => t.name === "board.explain_selection" && t.result.ok)) {
          const s = await explainSelection();
          text = s.text;
          label = s.label;
          trimmed = !!s.trimmed;
          sources = [...new Set([...sources, ...s.sources])];
          if (s.usage) usage = usage ? { inputTokens: usage.inputTokens + s.usage.inputTokens, outputTokens: usage.outputTokens + s.usage.outputTokens } : s.usage;
        }
        // S5 slice B: a leader school read the gate refused (analytics off,
        // the 60/day cap, the audit write failed) — its line is the answer
        // when nothing else in the turn produced one.
        const refusedRead = trace.find((t) => SCHOOL_READ_REFUSALS.has(t.result.error ?? ""));
        if (refusedRead && (!productive.length || text === SK_NOTHING_ON_THAT)) {
          text = refusedRead.result.summary;
          label = "declined";
          trimmed = false;
        }
        // S7 K2: the documents behind the answer (knowledge.search, library.find's
        // text search) — only when the answer rests on the tools.
        let citations: SkCitation[] = label === "grounded" || label === "navigation" ? productive.flatMap((t) => t.result.citations ?? []) : [];
        // The model asked the Board to explain what the lesson does not teach:
        // the kit's own book, when nothing else answered.
        const boardMiss = trace.find((t) => t.name === "board.explain" && t.result.error === "no_match");
        if (boardMiss && (label === "declined" || text === SK_NOTHING_ON_THAT)) {
          const concept = typeof boardMiss.args?.concept === "string" ? boardMiss.args.concept : body.text;
          const k = await boardKnowledge(concept).catch(() => null);
          if (k) {
            finalLang = k.lang;
            text = k.text;
            label = "grounded";
            trimmed = !!k.trimmed;
            sources = [...new Set([...sources, ...k.sources])];
            citations = k.citations;
            if (k.usage) usage = usage ? { inputTokens: usage.inputTokens + k.usage.inputTokens, outputTokens: usage.outputTokens + k.usage.outputTokens } : k.usage;
          }
        }
        citations = [...new Map(citations.map((c) => [`${c.kind}|${c.title}|${c.chapter ?? ""}|${c.section ?? ""}`, c])).values()].slice(0, 3);
        const entities = trace.flatMap((t) => t.result.entities ?? []);
        if (finalLang) sendLang(finalLang);
        send({ type: "text", text });
        if (navHit && !(act && "event" in act && act.event.type === "board")) send({ type: "navigate", path: navHit.path, label: navHit.label });
        if (act && "event" in act) send(act.event);
        done({ sources, label, ...(usage ? { usage } : {}), ...(trimmed ? { trimmed } : {}), ...(citations.length ? { citations } : {}) }, text, entities);
        finish();
      } catch (e) {
        if (!abort.signal.aborted) {
          console.error("sk-shell.turn", (e as Error).message);
          send({ type: "error", message: "Something went wrong — try again in a moment." });
        }
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
