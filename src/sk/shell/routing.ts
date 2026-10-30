// SK Shell — MODEL-FIRST routing (founder 2026-10-30: "cant we use one of the
// LLMs like haiku 5.5 or sonnet 5.5 and combine it with the underlying
// knowledge as the RAG and let them handle the conversations?" → "Yes, switch").
//
// Two routings, chosen per user by env (docs/sk-model-first.md):
//   rules  — today's path: routeByRules decides first, only "ask" reaches the model.
//   model  — every message goes to the model first, with the role's full tool
//            set. Rules keep three jobs only, decided BEFORE the model:
//              · a yes/no to the greeting's pending offer (offer.ts);
//              · next/pause/skip/back/resume while a tour is narrating (walk);
//              · a book code / the answer SK asked for (a code never reaches a prompt);
//            permission and safety stay in the capability registry and role gates.
//
// The model per message (chooseModel): Haiku 5.5 (SK_FAST_MODEL) for a short or
// command-like message with no teaching context open; Sonnet 5.5
// (SK_SHELL_MODEL) for teaching, explanations from books and anything long.
// Haiku escalates to Sonnet when its FIRST round wants a knowledge / teaching
// tool or answers with low confidence (SkModelProvider) — before any of its
// tool calls run, so nothing is done twice.
//
// Pure except SkModelProvider (it wraps the providers it is given).

import type { GenerateOpts, LLMProvider, StreamEvent, ToolCall, Usage } from "@/utils/assistant/provider";
import { isContentQuestion } from "@/sk/knowledge/answer";
import { findBookCode } from "@/sk/book-activate";
import { normalizeIntent } from "./intent-normalize";
import { fromApiToolName } from "./registry";
import { bookActivateOf, normRuleText, type RulesDecision } from "./rules";
import { SK_NOTHING_ON_THAT, type SkCapabilityResult, type SkContext } from "./types";

export type SkRouting = "rules" | "model";

export const SK_FAST_DEFAULT_MODEL = "claude-haiku-5-5";
export const SK_FULL_DEFAULT_MODEL = "claude-sonnet-5-5";

const emails = (raw: string | undefined) =>
  (raw ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/**
 * The routing for this user:
 *   SK_ROUTING=model → model for everyone;
 *   SK_ROUTING=rules → rules for everyone (the one-switch rollback; the
 *                      allow-list is ignored);
 *   unset            → rules, except the users in SK_MODEL_FIRST_EMAILS.
 */
export function skRouting(email: string | null | undefined): SkRouting {
  const env = (process.env.SK_ROUTING ?? "").trim().toLowerCase();
  if (env === "model") return "model";
  if (env === "rules") return "rules";
  const me = (email ?? "").trim().toLowerCase();
  return me && emails(process.env.SK_MODEL_FIRST_EMAILS).includes(me) ? "model" : "rules";
}

/** SK_DEBUG_EMAILS (2026-10-30): testers whose Shell turns get one
 *  `sk-shell.turn debug` line (what was heard, the route, the tools, the
 *  reply). Unset = nobody; matching ignores case. Never anyone not listed. */
export function skDebugFor(email: string | null | undefined): boolean {
  const me = (email ?? "").trim().toLowerCase();
  return !!me && emails(process.env.SK_DEBUG_EMAILS).includes(me);
}

export const skFastModel = (): string => process.env.SK_FAST_MODEL || SK_FAST_DEFAULT_MODEL;
export const skFullModel = (): string => process.env.SK_SHELL_MODEL || SK_FULL_DEFAULT_MODEL;

// ── The pre-model rules (model routing) ─────────────────────────────────────

/**
 * What the route decides before the model in MODEL routing. Only the book
 * code is a decision here: the offer's yes/no and the running tour's
 * controls are the route's own checks (they read the memory's offer and the
 * request's `walk`), so this returns "ask" for everything else.
 *   - a book code anywhere in the text (any role): the code must never become
 *     part of a model prompt;
 *   - the short answer to SK's own book.activate question (memory.pending).
 * An activation phrase with no code ("I have a code") goes to the model,
 * whose book.activate tool asks for it.
 */
export function modelFirstDecision(text: string, ctx: SkContext): RulesDecision {
  const raw = (text ?? "").trim();
  if (findBookCode(raw) || ctx.pending?.task === "book.activate") {
    const book = bookActivateOf(raw, normRuleText(raw), ctx);
    if (book) return { intent: "act", action: "book.activate", book };
  }
  return { intent: "ask" };
}

// ── The model per message ───────────────────────────────────────────────────

export type ModelTier = "fast" | "full";
export type ModelChoice = { tier: ModelTier; model: string; reason: string };

/** Teaching / explanation openers (EN / MS / AR and the app's other Latin
 *  languages). A data question ("what's on my timetable") is not one. */
const TEACHING_RE =
  /^(?:explain|why|how (?:does|do|did|is|are|can|come)|describe|define|compare|contrast|teach|summari[sz]e|tell me (?:about|more|why|how)|what(?:'s| is| are) the difference|difference between|meaning of|what does .+ mean|terangkan|jelaskan|huraikan|mengapa|kenapa|bagaimana|bandingkan|apakah maksud|maksud|اشرح|وضح|وضّح|فسر|فسّر|لماذا|كيف|قارن|ما الفرق|ما معنى|explique|pourquoi|explica|por qué|porque)\b/u;

/** Words that make a "what is …" a question about HER data, not a concept. */
const DATA_RE =
  /(?<![\p{L}\p{N}])(?:my|our|me|i|mine|today|tomorrow|yesterday|this week|next week|left|due|class|classes|students?|learners?|kids?|children|child|parents?|school|timetable|schedule|diary|notices?|marking|credits?|seats?|kits?|saya|kami|kita|hari ini|esok|kelas|murid|pelajar|anak|sekolah|jadual)(?![\p{L}\p{N}])|\d/u;

/** A command: an imperative verb first (after the greeting / politeness frame). */
const COMMAND_RE =
  /^(?:open|show|go|take|bring|start|begin|play|stop|pause|resume|continue|carry on|next|back|previous|skip|jump|post|send|tell|remind|write|add|note|mark|grade|give|prepare|make|create|generate|say|repeat|switch|speak|reply|answer|translate|activate|redeem|load|put|hide|close|end|finish|wrap|assign|find|search|list|freeze|blank|let'?s|buka|tunjuk(?:kan)?|pergi|mula(?:kan)?|main(?:kan)?|hantar|beritahu|ingatkan|tulis|tanda|sediakan|cakap|ulang|sambung|teruskan|berhenti|jeda|افتح|اعرض|أرني|اذهب|انتقل|ابدأ|ابدا|شغل|شغّل|أرسل|ارسل|أخبر|اخبر|ذكر|ذكّر|اكتب|قل|أعد|توقف|تابع)(?![\p{L}])/u;

const SHORT_WORDS = 12;
const LONG_CHARS = 160;
const LONG_WORDS = 24;

/** A lesson, a kit or a highlighted slide is open: the turn is teaching. */
export function teachingOpen(ctx: SkContext): boolean {
  return !!(ctx.board?.sessionId || ctx.board?.selection || ctx.tutor?.kit);
}

/** Is this message a teaching / explanation request (a concept, not her data)? */
export function isTeachingAsk(text: string): boolean {
  const core = normalizeIntent(text ?? "");
  if (TEACHING_RE.test(core)) return true;
  return isContentQuestion(text ?? "") && !DATA_RE.test(core);
}

/**
 * Haiku (fast) when the message is short or command-like and no teaching
 * context is open; otherwise Sonnet (full). Deterministic, from cheap signals.
 */
export function chooseModel(text: string, ctx: SkContext): ModelChoice {
  const full = (reason: string): ModelChoice => ({ tier: "full", model: skFullModel(), reason });
  const fast = (reason: string): ModelChoice => ({ tier: "fast", model: skFastModel(), reason });
  if (teachingOpen(ctx)) return full("teaching_open");
  if (isTeachingAsk(text)) return full("teaching_ask");
  const raw = (text ?? "").trim();
  const core = normalizeIntent(raw);
  const words = core.split(/\s+/).filter(Boolean).length;
  if (raw.length > LONG_CHARS || words > LONG_WORDS) return full("long");
  if (COMMAND_RE.test(core)) return fast("command");
  if (words <= SHORT_WORDS) return fast("short");
  return full("default");
}

// ── Escalation (fast → full) ────────────────────────────────────────────────

/** The tools that mean "this is teaching from content": a fast first round
 *  that wants one of them re-runs on the full model. */
export const ESCALATE_TOOLS: readonly string[] = ["knowledge.search", "kit.documents", "board.explain", "board.compare", "board.explain_selection", "tutor.explain"];

/** A student's knowledge.search and tutor.explain are handed to their own
 *  metered kit turn (handoffBefore / handoffAfter) — escalating first would
 *  only buy a second Shell round that is thrown away. */
export function escalationTools(ctx: SkContext): ReadonlySet<string> {
  const handedOff = ctx.user.role === "student" ? new Set(["knowledge.search", "tutor.explain"]) : new Set<string>();
  return new Set(ESCALATE_TOOLS.filter((t) => !handedOff.has(t)));
}

const LOW_CONFIDENCE_RE =
  /\b(?:i'?m not sure|i am not sure|not certain|i don'?t know|i do not know|i can'?t tell|i'?m unsure|no idea|i don'?t have (?:that|enough) information)\b|tidak pasti|saya tidak tahu|لست متأكد|لا أعرف/iu;

/** Why the fast model's first round must be redone on the full model, or null. */
export function escalationReason(calls: ToolCall[], text: string, escalateOn: ReadonlySet<string>): string | null {
  const hit = calls.map((c) => fromApiToolName(c.name)).find((n) => escalateOn.has(n));
  if (hit) return `tool:${hit}`;
  if (calls.length) return null;
  const t = text.trim();
  if (!t) return "empty";
  if (t === SK_NOTHING_ON_THAT || LOW_CONFIDENCE_RE.test(t)) return "low_confidence";
  return null;
}

/** What one turn's model calls did, for the timing line. */
export type ModelStats = {
  tier: ModelTier;
  models: string[];
  rounds: number;
  escalated: string | null;
  /** ms from the stats' t0 to the first answer text (the round that narrates). */
  firstTokenMs: number | null;
};

/**
 * The turn's provider in MODEL routing. Round 1 on the chosen model; when that
 * is the fast one, its round is BUFFERED and checked (escalationReason) before
 * the orchestrator sees it — on escalation the round is replayed on the full
 * model (the fast round's tokens are added to the usage) and every later round
 * stays there. Tool calls only run after a round ends, so an escalated round
 * never ran a tool. The full provider is built lazily (only when needed).
 */
export class SkModelProvider implements LLMProvider {
  readonly id = "sk-model-first";
  private active: LLMProvider;
  private full: LLMProvider | null = null;
  readonly stats: ModelStats;

  constructor(
    private readonly choice: ModelChoice,
    private readonly make: (model: string) => LLMProvider,
    private readonly escalateOn: ReadonlySet<string>,
    private readonly t0: number = Date.now(),
  ) {
    this.active = make(choice.model);
    this.stats = { tier: choice.tier, models: [choice.model], rounds: 0, escalated: null, firstTokenMs: null };
  }

  get model(): string {
    return this.active.model;
  }

  private mark(ev: StreamEvent): StreamEvent {
    if (ev.type === "text" && this.stats.firstTokenMs === null && ev.text) this.stats.firstTokenMs = Date.now() - this.t0;
    return ev;
  }

  async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
    const round = this.stats.rounds++;
    if (round > 0 || this.choice.tier !== "fast") {
      for await (const ev of this.active.stream(opts)) yield this.mark(ev);
      return;
    }
    // Round 1 on the fast model: hold it until it has finished.
    const held: StreamEvent[] = [];
    const calls: ToolCall[] = [];
    let text = "";
    let fastUsage: Usage | null = null;
    for await (const ev of this.active.stream(opts)) {
      held.push(ev);
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "tool_call") calls.push(ev.call);
      else if (ev.type === "done") fastUsage = ev.usage;
      else if (ev.type === "error") break;
    }
    const errored = held.some((e) => e.type === "error");
    const reason = errored || opts.signal?.aborted ? null : escalationReason(calls, text, this.escalateOn);
    if (!reason) {
      for (const ev of held) yield this.mark(ev);
      return;
    }
    this.stats.escalated = reason;
    this.full = this.full ?? this.make(skFullModel());
    this.active = this.full;
    this.stats.models.push(skFullModel());
    for await (const ev of this.active.stream(opts)) {
      if (ev.type === "done" && fastUsage) yield this.mark({ type: "done", usage: addUsage(fastUsage, ev.usage) ?? ev.usage });
      else yield this.mark(ev);
    }
  }
}

/** Two usages summed (the cache fields only when either has them). */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: Usage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
  const read = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  const write = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  if (read) out.cacheReadTokens = read;
  if (write) out.cacheWriteTokens = write;
  return out;
}

// ── Hand-offs: a tool the model chose that the route performs itself ────────

export type HandoffBefore = "student_knowledge" | "lesson_plan";
export type HandoffAfter = "control" | "tutor";

/**
 * Checked BEFORE the tool runs (the route then stops the model and performs
 * the turn as the rules path would):
 *   student_knowledge — a student's knowledge.search: her own metered,
 *     student-ruled kit turn (knowledgeForStudent), never the Shell model
 *     narrating passages;
 *   lesson_plan — start_lesson with nothing named (no book, chapter or kit) by
 *     a teacher: the Board's own pick, then the timetable (start-lesson.ts).
 */
export function handoffBefore(name: string, args: Record<string, unknown>, ctx: SkContext): HandoffBefore | null {
  const n = fromApiToolName(name);
  if (ctx.user.role === "student" && n === "knowledge.search") return "student_knowledge";
  if (n === "start_lesson" && ctx.user.role !== "student") {
    const named = ["book", "chapter", "kit"].some((k) => typeof args?.[k] === "string" ? (args[k] as string).trim() !== "" : args?.[k] != null);
    if (!named) return "lesson_plan";
  }
  return null;
}

/**
 * Checked AFTER the tool ran: a result that IS the turn's answer, performed
 * exactly as its rule performs it, with no narrating round:
 *   control — the tour / the answer language (shell-controls.ts);
 *   tutor   — a move on her kit player, or tutor.*'s own grounded reply.
 */
export function handoffAfter(r: SkCapabilityResult): HandoffAfter | null {
  if (!r.ok) return null;
  if (r.walkthrough || r.langCommand) return "control";
  if (r.tutor || r.reply) return "tutor";
  return null;
}
