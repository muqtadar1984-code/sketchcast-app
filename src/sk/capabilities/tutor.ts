// SK S3 slice D — the STUDENT capabilities (Final Plan §4 "Tutor session:
// play, check, practise, hints — student, immediate (metered)", §4.2, §9.7).
//
// Roles: student only. No hats (a student has none). All immediate tier:
// moves on her own kit player and reads of her own progress — no confirm-tier
// action exists for a student in S3.
//
//   tutor.play / tutor.section / tutor.slide / tutor.practise
//       client moves on the kit player, the S1 Board pattern: the capability
//       decides and audits the move, the route emits a `tutor` event, the
//       panel performs it through the tutor bridge (shell/client/tutor-bridge.ts)
//       on the player's controller port. They act only on what the student
//       already has open; the player's own routes still make every refusal.
//   tutor.explain
//       the kit turn itself (kit-turn.ts runKitExplain, through kit-server's
//       resolveKit + readyManifest exactly like /api/sk/kit/turn): ONE model
//       call grounded on the section's narration, METERED ONCE through the
//       loop's write point (one sk_usage live_turns). The Shell turn id is
//       claimed in the kit turn's own replay scope, so a resent turn replays
//       the answer and never reaches the model, or the meter, twice.
//   tutor.where / tutor.progress
//       deterministic reads (src/sk/tutor.ts): the kit's sections and
//       objectives, her sk_objective_mastery rows and her kit session's
//       attempts — her own rows only.
//
// Every line SK says here is a fixed line in her language (shell/tutor-lines.ts).

import type { SkCapability, SkCapabilityDeps, SkCapabilityMeta, SkCapabilityResult, SkCitation, SkContext, SkJsonSchema, SkTutorMove, SkTutorState } from "@/sk/shell/types";
import { lineFor } from "@/sk/shell/lines";
import {
  TUTOR_CHAPTER,
  TUTOR_NEED_SECTION,
  TUTOR_NO_KIT,
  TUTOR_NO_SECTION,
  TUTOR_PAUSE,
  TUTOR_PLAY,
  TUTOR_PRACTISE,
  TUTOR_PREPARING,
  TUTOR_PROGRESS_HEAD,
  TUTOR_PROGRESS_MASTERED,
  TUTOR_PROGRESS_NEEDS_WORK,
  TUTOR_PROGRESS_NONE,
  TUTOR_PROGRESS_PROVISIONAL,
  TUTOR_REFUSED,
  TUTOR_RESTART,
  TUTOR_SECTION,
  TUTOR_SECTION_N,
  TUTOR_SLIDE,
  TUTOR_WHERE_DONE,
  TUTOR_WHERE_PRACTISE,
  TUTOR_WHERE_WATCH,
  TUTOR_WHERE_WEAK,
} from "@/sk/shell/tutor-lines";
import { SK_STUDENT_KNOWLEDGE_RULES, SK_STUDENT_RULES } from "@/sk/shell/prompt";
import { isEventId } from "@/sk/ids";
import { kitDeps, readyManifest, resolveKit } from "@/sk/kit-server";
import { runKitExplain, runKitRepeat, runKnowledgeExplain } from "@/sk/kit-turn";
import { liveAllowed } from "@/sk/entitlement";
import { loadAccessFor } from "@/sk/loop";
import { supportFrom, teachingSupportTokens } from "@/sk/shell/teach";
import { citeLine } from "@/sk/shell/knowledge-lines";
import { narrationCovers, type Passage } from "@/sk/knowledge/answer";
import { kitOwnSources, searchForUser } from "./knowledge";
import { answerLanguage, languageName, linesLocale, type SkAnswerLang } from "@/sk/shell/language";
import type { SseEvent } from "@/sk/types";
import { loadTutorKit, practisedSections, progressGroups, readKitAttempts, readObjectiveMastery, studentChapters, visibleProducts, whereNext } from "@/sk/tutor";
import { resolveSegment } from "./board";
// Phase 4 (student Board): "how am I doing?" from her worksheet practice.
import { readPracticeMastery } from "@/sk/practice/mastery-read";
import { progressFromPractice } from "@/sk/practice/focus";
import type { SkDb } from "@/sk/store-supabase";

// ── shared ──────────────────────────────────────────────────────────────────

function meta(name: string, description: string, parameters: SkJsonSchema, kind: SkCapabilityMeta["kind"]): SkCapabilityMeta {
  return { name, description, parameters, tier: "immediate", kind, roles: ["student"], flags: ["sk"] };
}

const NONE: SkJsonSchema = { type: "object", properties: {}, additionalProperties: false };

const say = (ctx: SkContext, table: Record<string, string>, vars: Record<string, string | number> = {}) => lineFor(table, ctx.user.locale, vars);

/** A fixed line as the whole answer (SK's own words, labelled grounded on the tool). */
function answer(name: string, text: string, ok = true, error?: string, facts: SkCapabilityResult["facts"] = []): SkCapabilityResult {
  return { ok, summary: text, facts, ...(error ? { error } : {}), reply: { text, label: ok ? "grounded" : "declined", sources: ok ? [name] : [] } };
}

function tutorOf(ctx: SkContext): SkTutorState | null {
  return ctx.tutor?.kit ? ctx.tutor : null;
}

const noKit = (ctx: SkContext, name: string) => answer(name, say(ctx, TUTOR_NO_KIT), false, "no tutor");

const intArg = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
};
const strArg = (v: unknown, max = 160): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

type Section = { k: number; key: string; heading: string };

/** The section a move addresses: an explicit k, a step from the current one,
 *  or the words she said ("the red blood cells part") matched to a heading —
 *  the Board's own resolver (board.ts resolveSegment). Null = no such part. */
export function sectionFor(t: SkTutorState, args: Record<string, unknown>): Section | null {
  const segs = t.segments ?? [];
  const at = (k: number) => segs.find((s) => s.k === k) ?? null;
  const k = intArg(args.k);
  if (k !== null) return segs.length ? at(k) : null;
  const cur = typeof t.k === "number" ? t.k : 0;
  if (args.step === "next") return at(cur + 1);
  if (args.step === "previous") return at(Math.max(0, cur - 1));
  const query = strArg(args.query) || strArg(args.concept);
  if (query) {
    const hit = resolveSegment(query, { sessionId: "tutor", segments: segs.map((s) => ({ k: s.k, heading: s.heading, id: s.key })) });
    return hit ? at(hit.k) : null;
  }
  return at(cur) ?? (t.key ? { k: cur, key: t.key, heading: "" } : null);
}

function move(m: SkTutorMove, args: Record<string, unknown>, line: string, facts: SkCapabilityResult["facts"] = []): SkCapabilityResult {
  return { ok: true, summary: line, facts, tutor: { move: m, args, say: line } };
}

const SECTION_ARGS: SkJsonSchema = {
  type: "object",
  properties: {
    k: { type: "integer", minimum: 0, description: "0-based section index (the student's 'section 3' is k=2)." },
    query: { type: "string", description: "The section in the student's words, matched to the section headings (e.g. 'red blood cells')." },
    step: { type: "string", enum: ["next", "previous"], description: "The next or previous section." },
  },
  additionalProperties: false,
};

// ── the moves ───────────────────────────────────────────────────────────────

export const tutorPlay: SkCapability = {
  meta: meta(
    "tutor.play",
    "Student kit player: play (or carry on with) the current section, pause it, or play the lesson from the start. Use for 'play', 'continue', 'pause', 'start again'.",
    { type: "object", properties: { action: { type: "string", enum: ["play", "pause", "restart"], description: "play = carry on with the current section; pause; restart = from the start." } }, additionalProperties: false },
    "board",
  ),
  async handler(ctx, args) {
    const t = tutorOf(ctx);
    if (!t) return noKit(ctx, "tutor.play");
    const action = args.action === "pause" || args.action === "restart" ? args.action : "play";
    if (action === "pause") return move("pause", {}, say(ctx, TUTOR_PAUSE));
    if (action === "restart") return move("restart", {}, say(ctx, TUTOR_RESTART));
    const cur = sectionFor(t, {});
    const heading = cur?.heading || say(ctx, TUTOR_SECTION_N, { n: (cur?.k ?? t.k ?? 0) + 1 });
    return move("play", {}, say(ctx, TUTOR_PLAY, { heading }));
  },
};

export const tutorSection: SkCapability = {
  meta: meta(
    "tutor.section",
    "Student kit player: go to one section of the lesson and play it (it pauses at the section's end). Give k (0-based), step next/previous, or the student's words in query ('the red blood cells part').",
    SECTION_ARGS,
    "board",
  ),
  async handler(ctx, args) {
    const t = tutorOf(ctx);
    if (!t) return noKit(ctx, "tutor.section");
    const s = sectionFor(t, args);
    if (!s) return answer("tutor.section", say(ctx, TUTOR_NO_SECTION), false, "no_such_section");
    return move("section", { k: s.k, key: s.key }, say(ctx, TUTOR_SECTION, { n: s.k + 1, heading: s.heading || say(ctx, TUTOR_SECTION_N, { n: s.k + 1 }) }), [{ section: s.k + 1, heading: s.heading }]);
  },
};

export const tutorSlide: SkCapability = {
  meta: meta(
    "tutor.slide",
    "Student kit player: show a section's finished slide (the paused frame, or a heading-and-points card when the picture is not trusted). Defaults to the current section.",
    SECTION_ARGS,
    "board",
  ),
  async handler(ctx, args) {
    const t = tutorOf(ctx);
    if (!t) return noKit(ctx, "tutor.slide");
    const s = sectionFor(t, args);
    if (!s) return answer("tutor.slide", say(ctx, TUTOR_NO_SECTION), false, "no_such_section");
    return move("slide", { k: s.k, key: s.key }, say(ctx, TUTOR_SLIDE, { heading: s.heading || say(ctx, TUTOR_SECTION_N, { n: s.k + 1 }) }), [{ section: s.k + 1, heading: s.heading }]);
  },
};

export const tutorPractise: SkCapability = {
  meta: meta(
    "tutor.practise",
    "Student kit player: open the practice questions for a section (marked on the server; a wrong answer gets the remediation ladder). Defaults to the current section.",
    SECTION_ARGS,
    "board",
  ),
  async handler(ctx, args) {
    const t = tutorOf(ctx);
    if (!t) return noKit(ctx, "tutor.practise");
    const s = sectionFor(t, args);
    if (!s) return answer("tutor.practise", say(ctx, TUTOR_NO_SECTION), false, "no_such_section");
    return move("practise", { k: s.k, key: s.key }, say(ctx, TUTOR_PRACTISE, { heading: s.heading || say(ctx, TUTOR_SECTION_N, { n: s.k + 1 }) }), [{ section: s.k + 1, heading: s.heading }]);
  },
};

// ── tutor.explain: the kit turn, metered once ───────────────────────────────

export const tutorExplain: SkCapability = {
  meta: meta(
    "tutor.explain",
    "Student: explain a section of the open lesson, or answer the student's question about it, from the kit's own narration (one metered tutor turn). Defaults to the current section; question = the student's words.",
    {
      type: "object",
      properties: {
        question: { type: "string", description: "The student's own question, verbatim. Omit for 'explain this'." },
        k: { type: "integer", minimum: 0, description: "0-based section index; omit for the current section." },
        query: { type: "string", description: "The section in the student's words, matched to the headings." },
      },
      additionalProperties: false,
    },
    "read",
  ),
  async handler(ctx, args, deps) {
    const name = "tutor.explain";
    const t = tutorOf(ctx);
    if (!t) return answer(name, say(ctx, TUTOR_NEED_SECTION), false, "no tutor");
    const s = sectionFor(t, args);
    if (!s?.key) return answer(name, say(ctx, strArg(args.query) ? TUTOR_NO_SECTION : TUTOR_NEED_SECTION), false, "no_section");
    return explainSection(ctx, t, s, strArg(args.question, 600), deps);
  },
};

/** The kit turn route's own steps (kit/turn/route.ts), minus the HTTP. */
async function explainSection(ctx: SkContext, t: SkTutorState, s: Section, question: string, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const name = "tutor.explain";
  const kd = kitDeps();
  const r = await resolveKit(kd, ctx.user.id, { product: t.product, chapter: t.chapter, kit: t.kit });
  if (!r.ok) return answer(name, say(ctx, TUTOR_REFUSED), false, r.reason);
  const ready = await readyManifest(kd, r);
  if (!ready) return answer(name, say(ctx, TUTOR_PREPARING), false, "preparing");
  // 2026-10-30: her choice this turn (the language her question is written
  // in, else the conversation's — ctx.answer.override), else the KIT's
  // language (the manifest, read here — the player's report is only a hint),
  // else her UI locale.
  const sourceLanguage = ready.manifest.language ?? null;
  const lang = answerLanguage({ override: ctx.answer?.override ?? null, sourceLanguages: [sourceLanguage], uiLocale: ctx.answer?.uiLocale ?? ctx.user.locale });
  const language = languageName(lang.lang);

  // Replay guard: the Shell turn id, in the kit turn's own scope, so a resent
  // turn replays the first answer — never a second model call or meter.
  const scope = `kit:${ctx.user.id}`;
  const eventId = isEventId(deps.turnId) ? deps.turnId : null;
  let events: SseEvent[] | null = null;
  let replayed = false;
  if (eventId) {
    const claim = await kd.store.claimEvent<SseEvent[]>(scope, eventId);
    if (claim.status !== "new") {
      const stored = claim.status === "stored" ? claim.event : await claim.done.catch(() => null);
      events = stored?.result ?? [];
      replayed = true;
    }
  }
  if (!events) {
    const sent: SseEvent[] = [];
    // S7 K2: her question goes beyond this section's narration → the kit's
    // OWN book / article (never another source) adds passages to the ONE call.
    let knowledge: Passage[] = [];
    if (question) {
      const sup = supportFrom(ready.manifest, { segmentId: s.key });
      if (sup.status === "ready" && !narrationCovers(question, teachingSupportTokens(sup))) {
        try {
          const own = await kitOwnSources(ctx, deps, { productSlug: r.product.slug, bookId: ready.manifest.book_id, articleId: ready.manifest.article_id });
          const k = own.length ? await searchForUser(ctx, deps, { query: question, restrict: own, limit: 4 }) : null;
          if (k?.status === "ok") knowledge = k.passages;
        } catch (e) {
          console.error("[sk] tutor.explain knowledge:", (e as Error).message);
        }
      }
    }
    const cite = knowledge.length ? citeLine(knowledge.map((p) => ({ title: p.source_title, chapter: p.chapter, section: p.section })), linesLocale(lang.lang)) : undefined;
    try {
      for await (const ev of runKitExplain(kd, {
        studentId: ctx.user.id,
        productSlug: r.product.slug,
        manifest: ready.manifest,
        segmentKey: s.key,
        question: question || undefined,
        language,
        signal: deps.signal,
        rules: SK_STUDENT_RULES,
        ...(knowledge.length ? { knowledge, ...(cite ? { cite } : {}) } : {}),
      }))
        sent.push(ev);
      if (eventId) await kd.store.completeEvent(scope, eventId, "kit_turn", sent);
    } catch (e) {
      if (eventId) await kd.store.releaseEvent(scope, eventId, e);
      throw e;
    }
    events = sent;
  }
  const text = events
    .filter((e) => e.event === "text")
    .map((e) => String(e.data ?? ""))
    .join("")
    .trim();
  const done = (events.find((e) => e.event === "done")?.data ?? {}) as { label?: string; usage?: { inputTokens: number; outputTokens: number }; trimmed?: boolean; metered?: unknown; citations?: SkCitation[] };
  const label = done.label === "grounded" && text ? "grounded" : "declined";
  const citations = label === "grounded" && done.citations?.length ? done.citations : null;
  return {
    ok: !!text,
    summary: text.slice(0, 300) || "No answer.",
    ...(sourceLanguage ? { language: sourceLanguage } : {}),
    ...(citations ? { citations } : {}),
    facts: [{ section: s.k + 1, heading: s.heading, label, metered: !!done.metered && !replayed, replayed }],
    reply: {
      text,
      label,
      sources: label === "grounded" ? [name, "kit", ...(citations ? ["knowledge.search"] : [])] : [],
      ...(done.usage && !replayed ? { usage: done.usage } : {}),
      ...(done.trimmed ? { trimmed: true } : {}),
    },
  };
}

// ── S7 K2: her content question with no lesson open ────────────────────────

/** The product a student's knowledge turn is counted against: a book the
 *  passages came from first, then every product she can see — the first one
 *  her tutor access (with allowance left) covers. None → the first, so the
 *  turn says SK's own "live help has ended" line and makes no model call. */
async function meterProductFor(ctx: SkContext, deps: SkCapabilityDeps, kd: ReturnType<typeof kitDeps>, preferred: string[]): Promise<string> {
  const all = [...new Set([...preferred, ...(await visibleProducts(deps.session).catch(() => [] as string[]))])];
  for (const slug of all) {
    try {
      if (liveAllowed(await loadAccessFor(kd, ctx.user.id, slug))) return slug;
    } catch {
      // an unreadable product is skipped
    }
  }
  return all[0] ?? "";
}

/**
 * A student's content question ("what is osmosis?") with no lesson open: her
 * knowledge.search passages (her own sources only), then ONE grounded model
 * call METERED ONCE through meterUsage (kit-turn.ts runKnowledgeExplain) —
 * the same rules and write point as tutor.explain, the Shell turn id claimed
 * in the kit turn's replay scope so a resend never meters twice. Null when no
 * passage answers it (the route then shows her where she is, as before).
 * Not a registry entry: the route calls it for a student's content question.
 */
export async function knowledgeForStudent(ctx: SkContext, question: string, deps: SkCapabilityDeps): Promise<(SkCapabilityResult & { metered: boolean; passages: number }) | null> {
  const name = "knowledge.search";
  const q = strArg(question, 600);
  if (!q || ctx.user.role !== "student") return null;
  const k = await searchForUser(ctx, deps, { query: q, limit: 5 });
  if (k.status !== "ok" || !k.passages.length) return null;
  const passages = k.passages;
  const lang = answerLanguage({ override: ctx.answer?.override ?? null, sourceLanguages: passages.map((p) => p.language), uiLocale: ctx.answer?.uiLocale ?? ctx.user.locale });
  const cite = citeLine(passages.map((p) => ({ title: p.source_title, chapter: p.chapter, section: p.section })), linesLocale(lang.lang));
  const kd = kitDeps();

  const scope = `kit:${ctx.user.id}`;
  const eventId = isEventId(deps.turnId) ? deps.turnId : null;
  let events: SseEvent[] | null = null;
  let replayed = false;
  if (eventId) {
    const claim = await kd.store.claimEvent<SseEvent[]>(scope, eventId);
    if (claim.status !== "new") {
      const stored = claim.status === "stored" ? claim.event : await claim.done.catch(() => null);
      events = stored?.result ?? [];
      replayed = true;
    }
  }
  if (!events) {
    const sent: SseEvent[] = [];
    try {
      const preferred = passages
        .filter((p) => p.kind === "sketchcast_book")
        .map((p) => k.searched.find((s) => s.kind === "sketchcast_book" && s.id === p.source_id)?.product?.slug)
        .filter((x): x is string => !!x);
      const productSlug = await meterProductFor(ctx, deps, kd, preferred);
      for await (const ev of runKnowledgeExplain(kd, { studentId: ctx.user.id, productSlug, passages, question: q, language: languageName(lang.lang), cite, signal: deps.signal, rules: SK_STUDENT_KNOWLEDGE_RULES })) sent.push(ev);
      if (eventId) await kd.store.completeEvent(scope, eventId, "kit_turn", sent);
    } catch (e) {
      if (eventId) await kd.store.releaseEvent(scope, eventId, e);
      throw e;
    }
    events = sent;
  }
  const text = events
    .filter((e) => e.event === "text")
    .map((e) => String(e.data ?? ""))
    .join("")
    .trim();
  const done = (events.find((e) => e.event === "done")?.data ?? {}) as { label?: string; usage?: { inputTokens: number; outputTokens: number }; trimmed?: boolean; metered?: unknown; citations?: SkCitation[] };
  const label = done.label === "grounded" && text ? "grounded" : "declined";
  const citations = label === "grounded" && done.citations?.length ? done.citations : null;
  const shared = lang.from === "source" ? lang.lang : null;
  return {
    ok: !!text,
    summary: text.slice(0, 300) || "No answer.",
    ...(shared ? { language: shared } : {}),
    ...(citations ? { citations } : {}),
    facts: [{ passages: passages.length, label, metered: !!done.metered && !replayed, replayed }],
    reply: {
      text,
      label,
      sources: label === "grounded" ? [name, "knowledge"] : [],
      ...(done.usage && !replayed ? { usage: done.usage } : {}),
      ...(done.trimmed ? { trimmed: true } : {}),
    },
    metered: !!done.metered && !replayed,
    passages: passages.length,
  };
}

// ── "say that in Malay" on her open kit (2026-10-30) ────────────────────────

/** The student's repeat-in-another-language with her kit open: the Shell's
 *  last answer, re-expressed by ONE translation call (kit-turn.ts
 *  runKitRepeat) under her tutor access and METERED ONCE like the kit turn it
 *  came from — the Shell turn id claimed in the kit turn's replay scope, so a
 *  resent turn replays and never meters twice. Not a registry capability:
 *  the route calls it for the rules router's `lang` intent. */
export async function repeatForStudent(
  ctx: SkContext,
  input: { original: string; target: SkAnswerLang; question: string },
  deps: SkCapabilityDeps,
): Promise<{ text: string; label: "grounded" | "declined"; usage?: { inputTokens: number; outputTokens: number }; trimmed?: boolean; metered: boolean }> {
  const t = tutorOf(ctx);
  if (!t) return { text: say(ctx, TUTOR_NO_KIT), label: "declined", metered: false };
  const kd = kitDeps();
  const r = await resolveKit(kd, ctx.user.id, { product: t.product, chapter: t.chapter, kit: t.kit });
  if (!r.ok) return { text: say(ctx, TUTOR_REFUSED), label: "declined", metered: false };
  const scope = `kit:${ctx.user.id}`;
  const eventId = isEventId(deps.turnId) ? deps.turnId : null;
  let events: SseEvent[] | null = null;
  let replayed = false;
  if (eventId) {
    const claim = await kd.store.claimEvent<SseEvent[]>(scope, eventId);
    if (claim.status !== "new") {
      const stored = claim.status === "stored" ? claim.event : await claim.done.catch(() => null);
      events = stored?.result ?? [];
      replayed = true;
    }
  }
  if (!events) {
    const sent: SseEvent[] = [];
    try {
      for await (const ev of runKitRepeat(kd, { studentId: ctx.user.id, productSlug: r.product.slug, original: input.original, target: input.target, question: input.question, signal: deps.signal })) sent.push(ev);
      if (eventId) await kd.store.completeEvent(scope, eventId, "kit_turn", sent);
    } catch (e) {
      if (eventId) await kd.store.releaseEvent(scope, eventId, e);
      throw e;
    }
    events = sent;
  }
  const text = events
    .filter((e) => e.event === "text")
    .map((e) => String(e.data ?? ""))
    .join("")
    .trim();
  const done = (events.find((e) => e.event === "done")?.data ?? {}) as { label?: string; usage?: { inputTokens: number; outputTokens: number }; trimmed?: boolean; metered?: unknown };
  const label = done.label === "grounded" && text ? "grounded" : "declined";
  return { text, label, ...(done.usage && !replayed ? { usage: done.usage } : {}), ...(done.trimmed ? { trimmed: true } : {}), metered: !!done.metered && !replayed };
}

// ── tutor.where / tutor.progress: deterministic reads ───────────────────────

const chapterLine = (ctx: SkContext, c: { chapterRef: string; title: string }) => `${say(ctx, TUTOR_CHAPTER, { n: c.chapterRef })}: ${c.title}`;

export const tutorWhere: SkCapability = {
  meta: meta(
    "tutor.where",
    "Student: where am I and what's next — the next section to watch or practise in the open lesson, or the next idea that needs work. Without an open lesson, lists the student's chapters.",
    NONE,
    "read",
  ),
  async handler(ctx, _args, deps) {
    const name = "tutor.where";
    const t = tutorOf(ctx);
    if (!t) {
      const chapters = await studentChapters(ctx.user.id, await visibleProducts(deps.session));
      const text = chapters.length ? `${say(ctx, TUTOR_NO_KIT)} ${chapters.map((c) => chapterLine(ctx, c)).join("; ")}.` : say(ctx, TUTOR_NO_KIT);
      return answer(name, text, true, undefined, chapters.map((c) => ({ product: c.product, chapter: c.chapterRef, title: c.title })));
    }
    const loaded = await loadTutorKit(ctx.user.id, { product: t.product, chapter: t.chapter, kit: t.kit });
    if (!loaded.ok) return answer(name, say(ctx, loaded.reason === "preparing" ? TUTOR_PREPARING : TUTOR_REFUSED), false, loaded.reason);
    const kit = loaded.kit;
    const [mastery, attempts] = await Promise.all([readObjectiveMastery(deps.session, ctx.user.id, kit.objectives.map((o) => o.key)), readKitAttempts(deps.session, ctx.user.id, kit.generationId)]);
    const practised = [...new Set([...(t.practised ?? []), ...practisedSections(kit, attempts.map((a) => a.itemId))])];
    const next = whereNext({ sections: kit.sections, objectives: kit.objectives, mastery, current: t.k ?? 0, watched: t.watched ?? [], practised });
    const n = next.kind === "done" ? 0 : next.index + 1;
    const heading = next.kind === "done" ? "" : next.heading || say(ctx, TUTOR_SECTION_N, { n });
    const text =
      next.kind === "weak"
        ? say(ctx, TUTOR_WHERE_WEAK, { heading })
        : next.kind === "watch"
          ? say(ctx, TUTOR_WHERE_WATCH, { n, heading })
          : next.kind === "practise"
            ? say(ctx, TUTOR_WHERE_PRACTISE, { n, heading })
            : say(ctx, TUTOR_WHERE_DONE);
    return answer(name, text, true, undefined, [{ next: next.kind, section: n || null, heading: heading || null }]);
  },
};

export const tutorProgress: SkCapability = {
  meta: meta(
    "tutor.progress",
    "Student: how am I doing — the open lesson's ideas the student has mastered, is getting there with help, or needs to work on (her own results only).",
    NONE,
    "read",
  ),
  async handler(ctx, _args, deps) {
    const name = "tutor.progress";
    const t = tutorOf(ctx);
    // Phase 4 (student Board): no kit player open → her WORKSHEET PRACTICE
    // mastery (sk_practice_attempts through her own session, rule sk-learn.1),
    // for the kit open on her Board, else across her kits.
    if (!t) return ctx.user.role === "student" ? practiceProgress(ctx, deps) : noKit(ctx, name);
    const loaded = await loadTutorKit(ctx.user.id, { product: t.product, chapter: t.chapter, kit: t.kit });
    if (!loaded.ok) return answer(name, say(ctx, loaded.reason === "preparing" ? TUTOR_PREPARING : TUTOR_REFUSED), false, loaded.reason);
    const kit = loaded.kit;
    const mastery = await readObjectiveMastery(deps.session, ctx.user.id, kit.objectives.map((o) => o.key));
    const g = progressGroups(kit.objectives, mastery);
    const lines: string[] = [];
    if (g.mastered.length) lines.push(say(ctx, TUTOR_PROGRESS_MASTERED, { list: g.mastered.join(", ") }));
    if (g.provisional.length) lines.push(say(ctx, TUTOR_PROGRESS_PROVISIONAL, { list: g.provisional.join(", ") }));
    if (g.needs_work.length) lines.push(say(ctx, TUTOR_PROGRESS_NEEDS_WORK, { list: g.needs_work.join(", ") }));
    const text = lines.length ? [say(ctx, TUTOR_PROGRESS_HEAD, { kit: kit.title }), ...lines].join(" ") : say(ctx, TUTOR_PROGRESS_NONE);
    const facts = [...g.mastered.map((h) => ({ idea: h, status: "mastered" })), ...g.provisional.map((h) => ({ idea: h, status: "provisional" })), ...g.needs_work.map((h) => ({ idea: h, status: "needs_work" }))];
    return answer(name, text, true, undefined, facts);
  },
};

/** "How am I doing?" from her worksheet practice (no kit player open). */
async function practiceProgress(ctx: SkContext, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const name = "tutor.progress";
  const kitId = ctx.board?.generationId ?? null;
  let read = await readPracticeMastery(deps.session as unknown as SkDb, [ctx.user.id], { kitId, now: deps.now.getTime() });
  // The open unit's id may not be the kit's (a later part): fall back to all her kits.
  if (!read.rows.length && kitId) read = await readPracticeMastery(deps.session as unknown as SkDb, [ctx.user.id], { now: deps.now.getTime() });
  if (!read.rows.length) return answer(name, say(ctx, TUTOR_PROGRESS_NONE), true, undefined, []);
  const g = progressFromPractice(read.rows);
  const getting = read.rows.filter((r) => r.band === "new" || (r.band === "learning" && r.score >= 60)).map((r) => r.name);
  const work = read.rows.filter((r) => r.band === "learning" && r.score < 60).map((r) => r.name);
  const uniq = (xs: string[]) => [...new Set(xs)];
  const lines: string[] = [];
  if (g.secure.length) lines.push(say(ctx, TUTOR_PROGRESS_MASTERED, { list: g.secure.join(", ") }));
  if (getting.length) lines.push(say(ctx, TUTOR_PROGRESS_PROVISIONAL, { list: uniq(getting).join(", ") }));
  if (work.length) lines.push(say(ctx, TUTOR_PROGRESS_NEEDS_WORK, { list: uniq(work).join(", ") }));
  const kits = [...new Set(read.rows.map((r) => read.kits.get(r.kitId) ?? ""))].filter(Boolean).slice(0, 3).join(", ");
  const text = [say(ctx, TUTOR_PROGRESS_HEAD, { kit: kits }), ...lines].join(" ");
  const facts = read.rows.map((r) => ({ idea: r.name, status: r.band, score: r.score, questions: r.evidence }));
  return answer(name, text, true, undefined, facts);
}

/** Every student entry, in the order the registry lists them. */
export const TUTOR_CAPABILITIES: SkCapability[] = [tutorWhere, tutorProgress, tutorPlay, tutorSection, tutorSlide, tutorPractise, tutorExplain];
