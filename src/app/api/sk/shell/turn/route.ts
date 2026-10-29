import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skShellEnabledFor } from "@/utils/flags";
import { LOCALE_COOKIE, isLocale } from "@/i18n/locales";
import { AnthropicProvider } from "@/utils/assistant/providers/anthropic";
import type { Turn } from "@/utils/assistant/provider";
import { runAssistantTurn } from "@/utils/assistant/orchestrator";
import { loadContext } from "@/sk/shell/context";
import { openMemory, rememberTurn, sealMemory, type SkMemory } from "@/sk/shell/memory";
import { allowedFor, fromApiToolName, toToolDefs } from "@/sk/shell/registry";
import { makeRunTool, runCapability, type RunnerDeps, type ToolTrace } from "@/sk/shell/runner";
import { auditSinkFor } from "@/sk/shell/audit";
import { routeByRules } from "@/sk/shell/rules";
import { offerAnswer } from "@/sk/shell/offer";
import { lineFor } from "@/sk/shell/lines";
import { KIT_OFFER_DECLINED } from "@/sk/shell/act-lines";
import { buildShellPrompt, groundingCheck } from "@/sk/shell/prompt";
import { issueActionToken, publicParams } from "@/sk/shell/tokens";
import { maskBookSecrets } from "@/sk/book-activate";
import { TEACH_MAX_TOKENS, clipWords, teachingBlock, teachingQuestion, teachingSupport, teachingSupportTokens, type TeachRef, type TeachTarget, type TeachingSupport } from "@/sk/shell/teach";
import { loadSelectionSlide, selectionBlock, selectionOnSlide, selectionQuestion, selectionSupportTokens, type SelectionAdmin } from "@/sk/shell/selection";
import { BOARD_NO_MAP, BOARD_SELECTION_NO_SLIDE, sayFor } from "@/sk/capabilities/board";
import { searchLibrary } from "@/sk/capabilities/library";
import type { NavFilters } from "@/sk/capabilities/navigate";
import { kitFilters, lessonNotStarted, namesLesson, pickKitHit, planStartLesson } from "@/sk/shell/start-lesson";
import { LOCALES } from "@/i18n/locales";
import { SK_CANNOT_CONFIRM, SK_NOTHING_ON_THAT, type ResolvedEntity, type SkCapabilityResult, type SkCollector, type SkTurnEvent, type SkTurnRequest } from "@/sk/shell/types";

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

const SK_SHELL_DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_TEXT = 600;

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
  const text = typeof b.text === "string" ? b.text.trim() : "";
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
  return { turnId, text, modality, collector, memory };
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

  let memory = openMemory(body.memory, ctx, now).memory;
  // The conversation's resolved entities (signed memory) become ctx.recent, so a
  // capability can resolve "their parents" from the last not-done list (§5.4).
  ctx.recent = { ...ctx.recent, entities: memory.entities };
  // S4 slice D: what SK asked for last turn (book.activate: the order number
  // or the child), so the rules can take the short answer.
  if (memory.pending) ctx.pending = memory.pending;
  const allowed = allowedFor(ctx);
  const sink = auditSinkFor(admin);
  const decision = routeByRules(body.text, ctx, now, body.collector.clock);
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
  };

  // Board moves are audited against the PRESENT session (sk_actions.session_id:
  // "present session / assistant session, whichever applies") — that is the id
  // the recap route reads them back by. Everything else keeps the Shell's own.
  const boardDeps: RunnerDeps = ctx.board?.sessionId ? { ...deps, sessionId: ctx.board.sessionId } : deps;
  const boardGen = ctx.board?.sessionId && ctx.board.generationId ? ctx.board.generationId : null;
  const language = LOCALES.find((l) => l.value === ctx.user.locale)?.label ?? "English";

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
  ): Promise<{ text: string; sources: string[]; usage?: { inputTokens: number; outputTokens: number }; trimmed?: boolean } | null> => {
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
    const provider = new AnthropicProvider(process.env.SK_SHELL_MODEL || SK_SHELL_DEFAULT_MODEL);
    const system = `${buildShellPrompt({ ctx, capabilities: allowed.map((c) => c.meta), memory })}\n${teachingBlock(sup)}`;
    let full = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const ev of runAssistantTurn({ provider, system, history: [], question: teachingQuestion(kind, sup, language), tools: undefined, maxToolRounds: 0, maxTokens: TEACH_MAX_TOKENS, signal: abort.signal })) {
      if (ev.type === "text") full += ev.text;
      else if (ev.type === "done" || ev.type === "cancelled") usage = ev.usage;
      else if (ev.type === "error") console.error("sk-shell.turn teach", ev.retryable ? "retryable" : "fatal", ev.message);
    }
    // §9.3: every name and number must occur in the narration (or the question).
    const verdict = groundingCheck(full, [...teachingSupportTokens(sup), say], body.text);
    if (!verdict.ok) console.info("sk-shell.turn teach grounding", JSON.stringify({ turnId: body.turnId, unsupported: verdict.unsupported, dropped: verdict.dropped }));
    const text = (verdict.ok ? full.trim() : verdict.text.trim()) || say;
    return { text, sources: [name, "manifest"], ...(usage ? { usage } : {}), ...(!verdict.ok && verdict.text.trim() ? { trimmed: true } : {}) };
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
  }> => {
    const name = "board.explain_selection";
    const sel = ctx.board?.selection;
    const noSelection = sayFor("no_selection", ctx.user.locale);
    if (!sel) return { text: noSelection, sources: [], label: "declined" };
    const slide = admin ? await loadSelectionSlide(admin as unknown as SelectionAdmin, sel, ctx.user.id) : null;
    if (!slide) return { text: BOARD_SELECTION_NO_SLIDE, sources: [name], label: "declined" };
    // Only the words that are on the slide reach the model (selection.ts).
    const selected = selectionOnSlide(sel, slide);
    if (!selected) return { text: noSelection, sources: [name], label: "declined" };
    const fallback = sayFor("explain_selection", ctx.user.locale, { n: slide.n, text: clipWords(selected, 160) });
    const provider = new AnthropicProvider(process.env.SK_SHELL_MODEL || SK_SHELL_DEFAULT_MODEL);
    const system = `${buildShellPrompt({ ctx, capabilities: allowed.map((c) => c.meta), memory })}\n${selectionBlock(slide, selected)}`;
    let full = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const ev of runAssistantTurn({ provider, system, history: [], question: selectionQuestion(language), tools: undefined, maxToolRounds: 0, maxTokens: TEACH_MAX_TOKENS, signal: abort.signal })) {
      if (ev.type === "text") full += ev.text;
      else if (ev.type === "done" || ev.type === "cancelled") usage = ev.usage;
      else if (ev.type === "error") console.error("sk-shell.turn selection", ev.retryable ? "retryable" : "fatal", ev.message);
    }
    // §9.3: every name and number must occur on the slide (text or notes) or in the question.
    const verdict = groundingCheck(full, selectionSupportTokens(slide), body.text);
    if (!verdict.ok) console.info("sk-shell.turn selection grounding", JSON.stringify({ turnId: body.turnId, unsupported: verdict.unsupported, dropped: verdict.dropped }));
    const text = (verdict.ok ? full.trim() : verdict.text.trim()) || fallback;
    return { text, sources: [name, "deck"], label: "grounded", ...(usage ? { usage } : {}), ...(!verdict.ok && verdict.text.trim() ? { trimmed: true } : {}) };
  };

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      abort.abort();
    },
    async start(controller) {
      const send = (ev: SkTurnEvent) => {
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(frame(ev));
        } catch {
          /* client gone */
        }
      };
      const finish = () => {
        request.signal?.removeEventListener("abort", onRequestAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const done = (ev: Omit<Extract<SkTurnEvent, { type: "done" }>, "type" | "latencyMs" | "memory">, assistantText: string, entities: ResolvedEntity[], pending?: SkMemory["pending"] | null) => {
        // S4 slice D: a book code / order number typed to SK is never remembered
        // (the memory travels to the browser and back into later prompts), and
        // book.activate's pending question lasts exactly one turn.
        const keep = pending !== undefined ? pending : memory.pending?.task === "book.activate" ? null : undefined;
        memory = rememberTurn(memory, { user: maskBookSecrets(body.text), assistant: assistantText, entities, pending: keep }, new Date());
        send({ type: "done", ...ev, latencyMs: Date.now() - t0, memory: sealMemory(memory) });
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
          if (!issued) return { declined: SK_CANNOT_CONFIRM };
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

      /** S3 slice D: one tutor.* capability, start to finish, no model of the
       *  route's own. A move becomes a `tutor` event the panel performs on the
       *  kit player; a read (or tutor.explain's kit turn) carries its own
       *  grounded text in `reply`. */
      const runTutor = async (name: string, args: Record<string, unknown>) => {
        const r = await runCapability(ctx, name, args, deps);
        send({ type: "tool", name, ok: r.ok, summary: r.summary.slice(0, 200) });
        if (r.ok && r.tutor) {
          const say = r.tutor.say ?? r.summary;
          send({ type: "tutor", move: r.tutor.move, args: r.tutor.args ?? {}, say: r.tutor.say });
          done({ sources: [name], label: "grounded" }, say, r.entities ?? []);
          return;
        }
        if (r.reply) {
          const text = r.reply.text || r.summary;
          send({ type: "text", text });
          done({ sources: r.reply.sources, label: r.reply.label, ...(r.reply.usage ? { usage: r.reply.usage } : {}), ...(r.reply.trimmed ? { trimmed: true } : {}) }, text, r.entities ?? []);
          return;
        }
        send({ type: "text", text: r.summary });
        done({ sources: [], label: "declined" }, r.summary, []);
      };

      try {
        send({ type: "meta", sessionId: memory.sessionId, turnId: body.turnId, intent: decision.intent, capabilities: allowed.map((c) => c.meta.name) });

        // ── S2: the answer to the greeting's offer — deterministic, no model ──
        if (offer && offerReply) {
          if (offerReply === "no") {
            const text = lineFor(KIT_OFFER_DECLINED, ctx.user.locale);
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
          const nav = await runCapability(
            ctx,
            "navigate",
            offer.target === "tutor" ? { target: "tutor", product: offer.product, chapter: offer.chapter, generationId: offer.kit } : { target: offer.target, bookId: offer.bookId },
            deps,
          );
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

        // ── S3 slice D: a STUDENT turn never reaches the teacher model ───────
        // A tutor phrasing runs its tutor.* capability (moves and reads: no
        // model call); anything else that is not a navigate or a bare
        // acknowledgement is her question about the open lesson and goes to
        // tutor.explain — the kit turn, ONE grounded model call, metered once
        // — or, with no lesson open, to tutor.where (her chapters, no model).
        if (ctx.user.role === "student" && decision.intent !== "navigate" && decision.intent !== "chat") {
          if (decision.intent === "tutor") await runTutor(decision.capability, decision.args);
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
          } else {
            const text = act && "declined" in act ? act.declined : r.summary;
            send({ type: "text", text });
            done({ sources: [], label: "declined" }, text, []);
          }
          finish();
          return;
        }

        // ── Navigate: deterministic, audited, no model ───────────────────────
        if (decision.intent === "navigate") {
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

        // ── The model, with the allowed tools ────────────────────────────────
        const provider = new AnthropicProvider(process.env.SK_SHELL_MODEL || SK_SHELL_DEFAULT_MODEL);
        const trace: ToolTrace[] = [];
        // The chip for a tool goes out the moment THAT tool finishes; the
        // orchestrator runs a round's tools side by side, so "the last trace
        // entry" would name the wrong one.
        const onTrace = (t: ToolTrace) => send({ type: "tool", name: t.name, ok: t.result.ok, summary: t.result.summary.slice(0, 200) });
        const runShell = makeRunTool(ctx, deps, trace, onTrace);
        const runBoard = makeRunTool(ctx, boardDeps, trace, onTrace);
        // A board.* tool the model chose is audited against the present session too.
        const run = (call: Parameters<typeof runShell>[0], signal?: AbortSignal) => (fromApiToolName(call.name).startsWith("board.") ? runBoard(call, signal) : runShell(call, signal));
        const history: Turn[] = memory.turns.map((t) => ({ role: t.role, text: t.text }));
        const system = buildShellPrompt({ ctx, capabilities: allowed.map((c) => c.meta), memory });
        let full = "";
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        let cancelled = false;
        let failed = false;

        for await (const ev of runAssistantTurn({
          provider,
          system,
          history,
          question: body.text,
          tools: allowed.length ? toToolDefs(allowed) : undefined,
          runTool: run,
          maxToolRounds: 3,
          maxTokens: 600,
          signal: abort.signal,
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
        const productive = trace.filter(
          (t) => (t.result.facts?.length ?? 0) > 0 || !!t.result.navigate || (t.result.entities?.length ?? 0) > 0 || (t.result.ok && (!!t.result.board || !!t.result.confirm)),
        );
        const support = trace.flatMap((t) => [t.result.summary, ...(t.result.facts ?? [])]);
        const verdict = groundingCheck(full, support, body.text);
        if (!verdict.ok) {
          // Server-side only: which tokens failed and what was dropped, so a
          // false positive can be diagnosed from the runtime logs (2026-10-28).
          console.info("sk-shell.turn grounding", JSON.stringify({ turnId: body.turnId, tools: trace.map((t) => t.name), unsupported: verdict.unsupported, dropped: verdict.dropped }));
        }
        const navHit = [...trace].reverse().find((t) => t.result.ok && t.result.navigate)?.result.navigate;
        let text: string;
        let label: Extract<SkTurnEvent, { type: "done" }>["label"];
        let trimmed = false;
        if (trace.length && !productive.length) {
          text = SK_NOTHING_ON_THAT;
          label = "declined";
        } else if (!trace.length) {
          text = verdict.ok && full.trim() ? full.trim() : SK_NOTHING_ON_THAT;
          label = verdict.ok && full.trim() ? "supplementary" : "declined";
        } else if (verdict.ok && full.trim()) {
          text = full.trim();
          label = navHit ? "navigation" : "grounded";
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
        let sources = [...new Set(productive.map((t) => t.name))];
        // S1 slice C: the model chose explain/compare → the narration-grounded
        // teaching text replaces what the model wrote from headings alone.
        if (actHit && act && "event" in act && (actHit.name === "board.explain" || actHit.name === "board.compare") && actHit.result.board) {
          const taught = await teach(actHit.name === "board.explain" ? "explain" : "compare", actHit.result.board.args, act.say);
          if (taught) {
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
        const entities = trace.flatMap((t) => t.result.entities ?? []);
        send({ type: "text", text });
        if (navHit && !(act && "event" in act && act.event.type === "board")) send({ type: "navigate", path: navHit.path, label: navHit.label });
        if (act && "event" in act) send(act.event);
        done({ sources, label, ...(usage ? { usage } : {}), ...(trimmed ? { trimmed } : {}) }, text, entities);
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
