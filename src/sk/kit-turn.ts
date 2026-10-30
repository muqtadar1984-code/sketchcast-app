// SK S3 slice B — the student's "explain this" on kit content: ONE model turn
// grounded on the section's own narration and points from the Kit Manifest.
//
// Same rules as the graph loop's question turn (src/sk/loop.ts runTurn):
//   - live help needs TUTOR access with allowance left (loadAccessFor →
//     liveAllowed); without it SK says so in its own words and no model runs;
//   - a turn that reached the model is METERED through the loop's own write
//     point (meterUsage → sk_usage, one live_turns), cancelled or not;
//   - the answer is buffered and held to the narration by groundingCheck
//     (§9.3): a sentence with a name or number the kit does not say is dropped,
//     and if nothing survives SK reads the section's heading and points.
// The narration reaches the model as DATA inside the TEACHING block
// (shell/teach.ts), exactly as the Board's explain does, and never the client.
//
// Server-only by use (it is handed a provider and a store); no I/O of its own.

import type { LLMProvider } from "@/utils/assistant/provider";
import { liveAllowed } from "./entitlement";
import { accessView, liveRefusalText, loadAccessFor, meterUsage, type AccessDeps } from "./loop";
import type { KitManifest } from "./manifest/derive";
import { groundingCheck } from "./shell/prompt";
import type { SkAnswerLang } from "./shell/language";
import { repeatAnswer } from "./shell/repeat";
import { supportFrom, TEACH_MAX_TOKENS, teachingBlock, teachingSupportTokens } from "./shell/teach";
import { NO_TEACHER_TEXT } from "./teacher";
import type { SseEvent } from "./types";
import { citationsOf, knowledgeBlock, knowledgeSupportTokens, type Passage } from "./knowledge/answer";

/** `translateProvider`: the re-expression model for "repeat that in X"
 *  (Haiku 5.5, shell/repeat.ts); absent → the teacher provider. */
export type KitTurnDeps = AccessDeps & { teacherProvider?: LLMProvider; translateProvider?: LLMProvider };

export type KitTurnInput = {
  studentId: string;
  /** The product's slug (entitlements and sk_usage are keyed through it). */
  productSlug: string;
  manifest: KitManifest;
  /** The section, by manifest key ("p1:s003"). */
  segmentKey: string;
  /** The student's own question about the section; absent = "explain this". */
  question?: string;
  /** The locale's language name, for the reply ("English", "Bahasa Melayu"…). */
  language: string;
  signal?: AbortSignal;
  /** S3 slice D: extra rules appended to the tutor's system prompt (the SK
   *  Shell passes its student rule block, shell/prompt.ts SK_STUDENT_RULES).
   *  Absent = the player's own explain, unchanged. */
  rules?: string;
  /** S7 K2: passages from the kit's OWN book or article, found because the
   *  section's narration does not cover the question (tutor.ts). They join
   *  TEACHING as KNOWLEDGE data and widen the grounding support; still ONE
   *  model call, metered once. */
  knowledge?: Passage[];
  /** S7 K2: the citation line SK adds under an answer that had knowledge. */
  cite?: string;
};

export const KIT_TUTOR_SYSTEM = [
  "You are SK, a friendly tutor helping ONE student through a lesson video, section by section.",
  "Speak to the student directly and warmly, at their level. Plain text only: 2–4 short sentences, no headings, no lists, no markdown.",
  "Teach only from the TEACHING data below. You may rephrase and give a simple everyday comparison, but add no names, numbers, dates, definitions or formulae of your own.",
].join("\n");

export const NO_SECTION_TEXT = "I can't find that section of the lesson. Pick a section from the list and ask me again.";

/** The user turn for the call. The question is quoted as the student's words. */
export function kitTurnQuestion(heading: string, language: string, question?: string, knowledge = false): string {
  const q = (question ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (q && knowledge) {
    return `The student asks about "${heading || "this section"}": "${q}". Answer in ${language}, from the narration in TEACHING; where TEACHING does not cover it, answer from the passages in KNOWLEDGE (this lesson's own book).`;
  }
  if (q) {
    return `The student asks about "${heading || "this section"}": "${q}". Answer in ${language}, from the narration in TEACHING. If TEACHING does not cover it, say this section does not cover it and say what it does cover.`;
  }
  return `Explain "${heading || "this section"}" to the student in ${language}, using only the narration in TEACHING.`;
}

/** What SK says when the model's words did not survive the grounding check:
 *  the section's own heading and points (kit text, so grounded by definition). */
export function captionLine(heading: string, points: string[]): string {
  const parts = [heading, ...points.slice(0, 4)].map((p) => (p ?? "").trim()).filter(Boolean);
  return parts.map((p) => (/[.!?؟。]$/u.test(p) ? p : `${p}.`)).join(" ");
}

export async function* runKitExplain(deps: KitTurnDeps, input: KitTurnInput): AsyncGenerator<SseEvent, void, void> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let access = await loadAccessFor(deps, input.studentId, input.productSlug);
  const usage = { inputTokens: 0, outputTokens: 0 };
  let modelReached = false;
  let cancelled = false;
  let label: "grounded" | "declined" = "grounded";
  let trimmed = false;
  let citations: ReturnType<typeof citationsOf> | null = null;

  const sup = supportFrom(input.manifest, { segmentId: input.segmentKey });
  yield { event: "meta", data: { move: input.question ? "ask" : "explain", segment: input.segmentKey } };

  if (sup.status !== "ready") {
    label = "declined";
    yield { event: "text", data: NO_SECTION_TEXT };
  } else if (!liveAllowed(access)) {
    // Live help is what tutor access buys; the lesson itself plays on book access.
    label = "declined";
    yield { event: "text", data: liveRefusalText(access) };
  } else if (!deps.teacherProvider) {
    label = "declined";
    yield { event: "text", data: NO_TEACHER_TEXT };
  } else {
    const seg = sup.segments[0]!;
    const passages = input.knowledge ?? [];
    const system = `${KIT_TUTOR_SYSTEM}${input.rules ? `\n${input.rules}` : ""}\n${teachingBlock(sup)}${passages.length ? `\n${knowledgeBlock(passages)}` : ""}`;
    const question = kitTurnQuestion(seg.heading, input.language, input.question, passages.length > 0);
    let full = "";
    modelReached = true;
    try {
      for await (const ev of deps.teacherProvider.stream({ system, messages: [{ role: "user", text: question }], maxTokens: TEACH_MAX_TOKENS, signal: input.signal })) {
        if (ev.type === "text") full += ev.text;
        else if (ev.type === "done") Object.assign(usage, ev.usage);
        else if (ev.type === "error") console.error("[sk] kit explain", ev.retryable ? "retryable" : "fatal", ev.message);
      }
    } catch (e) {
      if (input.signal?.aborted) cancelled = true;
      else console.error("[sk] kit explain failed:", (e as Error).message);
    }
    if (input.signal?.aborted) cancelled = true;
    // §9.3: every name and number must occur in the kit's words (or the student's question).
    const verdict = groundingCheck(full, [...teachingSupportTokens(sup), ...knowledgeSupportTokens(passages)], input.question ?? "");
    if (!verdict.ok) {
      trimmed = true;
      console.info("[sk] kit explain grounding", JSON.stringify({ segment: input.segmentKey, unsupported: verdict.unsupported }));
    }
    const said = verdict.ok ? full.trim() : verdict.text.trim();
    const text = said ? (passages.length && input.cite ? `${said}\n${input.cite}` : said) : captionLine(seg.heading, seg.points);
    if (said && passages.length) citations = citationsOf(passages);
    if (!cancelled) yield { event: "text", data: text };
  }

  // B8 write point, unchanged: a turn that reached the model is one live turn.
  if (modelReached) access = await meterUsage(deps.store, input.studentId, access, { live_turns: 1, generated_segments: 0 }, input.productSlug);
  yield {
    event: "done",
    data: {
      latency: { totalMs: now() - t0 },
      usage,
      label,
      ...(trimmed ? { trimmed: true } : {}),
      ...(modelReached ? { metered: { live_turns: 1, generated_segments: 0 } } : {}),
      ...(cancelled ? { cancelled: true } : {}),
      ...(citations?.length ? { citations } : {}),
      access: accessView(access),
    },
  };
}

// ── S7 K2: a student's content question with no lesson open ─────────────────

export const KNOWLEDGE_TUTOR_SYSTEM = [
  "You are SK, a friendly tutor answering ONE student's question.",
  "Speak to the student directly and warmly, at their level. Plain text only: 2–4 short sentences, no headings, no lists, no markdown.",
  "Answer only from the KNOWLEDGE passages below (the student's own books, the free articles and her uploads). You may rephrase and give a simple everyday comparison, but add no names, numbers, dates, definitions or formulae of your own. If the passages do not answer it, say so in one sentence. Never give the answer to an exercise.",
].join("\n");

export type KnowledgeTurnInput = {
  studentId: string;
  /** The product the live turn is counted against (tutor.ts picks it). */
  productSlug: string;
  passages: Passage[];
  question: string;
  /** The answer language's name ("English", "Arabic"…). */
  language: string;
  /** The citation line SK adds under the answer (knowledge-lines.ts citeLine). */
  cite?: string;
  signal?: AbortSignal;
  rules?: string;
};

/** What SK says when no model sentence survived: the best passage's own words. */
export function passageLine(p: Passage | undefined): string {
  const t = (p?.text ?? "").trim();
  if (!t) return "";
  const first = t
    .split(/(?<=[.!?؟。])\s+/u)
    .slice(0, 2)
    .join(" ");
  return first.length > 320 ? `${first.slice(0, 317).trimEnd()}…` : first;
}

/**
 * A student's content question answered from her knowledge passages, under
 * the SAME rules as runKitExplain: tutor access with allowance left, or SK's
 * own line and no model; ONE grounded model call (the passages as DATA,
 * groundingCheck over them); a call that reached the model is ONE live turn
 * through meterUsage. Same event shape: meta → text → done (+ citations).
 */
export async function* runKnowledgeExplain(deps: KitTurnDeps, input: KnowledgeTurnInput): AsyncGenerator<SseEvent, void, void> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let access = await loadAccessFor(deps, input.studentId, input.productSlug);
  const usage = { inputTokens: 0, outputTokens: 0 };
  let modelReached = false;
  let cancelled = false;
  let label: "grounded" | "declined" = "grounded";
  let trimmed = false;
  let citations: ReturnType<typeof citationsOf> = [];
  yield { event: "meta", data: { move: "knowledge" } };

  if (!input.passages.length) {
    label = "declined";
  } else if (!liveAllowed(access)) {
    label = "declined";
    yield { event: "text", data: liveRefusalText(access) };
  } else if (!deps.teacherProvider) {
    label = "declined";
    yield { event: "text", data: NO_TEACHER_TEXT };
  } else {
    const system = `${KNOWLEDGE_TUTOR_SYSTEM}${input.rules ? `\n${input.rules}` : ""}\n${knowledgeBlock(input.passages)}`;
    const q = input.question.replace(/\s+/g, " ").trim().slice(0, 600);
    const question = `The student asks: "${q}". Answer in ${input.language}, from the passages in KNOWLEDGE.`;
    let full = "";
    modelReached = true;
    try {
      for await (const ev of deps.teacherProvider.stream({ system, messages: [{ role: "user", text: question }], maxTokens: TEACH_MAX_TOKENS, signal: input.signal })) {
        if (ev.type === "text") full += ev.text;
        else if (ev.type === "done") Object.assign(usage, ev.usage);
        else if (ev.type === "error") console.error("[sk] knowledge explain", ev.retryable ? "retryable" : "fatal", ev.message);
      }
    } catch (e) {
      if (input.signal?.aborted) cancelled = true;
      else console.error("[sk] knowledge explain failed:", (e as Error).message);
    }
    if (input.signal?.aborted) cancelled = true;
    // §9.3: every name and number must occur in the passages (or her question).
    const verdict = groundingCheck(full, knowledgeSupportTokens(input.passages), q);
    if (!verdict.ok) {
      trimmed = true;
      console.info("[sk] knowledge explain grounding", JSON.stringify({ unsupported: verdict.unsupported }));
    }
    const said = (verdict.ok ? full.trim() : verdict.text.trim()) || passageLine(input.passages[0]);
    citations = citationsOf(input.passages);
    const text = input.cite ? `${said}\n${input.cite}` : said;
    if (!cancelled) yield { event: "text", data: text };
  }

  // The same write point as an explain turn: a call that reached the model is one live turn.
  if (modelReached) access = await meterUsage(deps.store, input.studentId, access, { live_turns: 1, generated_segments: 0 }, input.productSlug);
  yield {
    event: "done",
    data: {
      latency: { totalMs: now() - t0 },
      usage,
      label,
      ...(trimmed ? { trimmed: true } : {}),
      ...(modelReached ? { metered: { live_turns: 1, generated_segments: 0 } } : {}),
      ...(cancelled ? { cancelled: true } : {}),
      ...(citations.length ? { citations } : {}),
      access: accessView(access),
    },
  };
}

// ── "repeat that in X" (2026-10-30) ─────────────────────────────────────────

export type KitRepeatInput = {
  studentId: string;
  productSlug: string;
  /** SK's last explanation, whole (the kit session / the Shell memory keeps it). */
  original: string;
  target: SkAnswerLang;
  /** The original's sources (the section's narration), widening the support. */
  support?: unknown[];
  /** The student's words ("say that in Malay"). */
  question?: string;
  signal?: AbortSignal;
};

/**
 * The student's "say that in Malay" on a kit: the last explanation in another
 * language by ONE translation call (shell/repeat.ts), under the SAME rules as
 * runKitExplain — tutor access with allowance left, or SK's own line and no
 * model; a call that reached the model is ONE live turn through meterUsage,
 * never two. Same event shape: meta → text → done.
 */
export async function* runKitRepeat(deps: KitTurnDeps, input: KitRepeatInput): AsyncGenerator<SseEvent, void, void> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let access = await loadAccessFor(deps, input.studentId, input.productSlug);
  let usage = { inputTokens: 0, outputTokens: 0 };
  let modelReached = false;
  let cancelled = false;
  let label: "grounded" | "declined" = "grounded";
  let trimmed = false;
  yield { event: "meta", data: { move: "repeat", lang: input.target } };

  const provider = deps.translateProvider ?? deps.teacherProvider;
  if (!liveAllowed(access)) {
    label = "declined";
    yield { event: "text", data: liveRefusalText(access) };
  } else if (!provider) {
    label = "declined";
    yield { event: "text", data: NO_TEACHER_TEXT };
  } else {
    modelReached = true;
    const r = await repeatAnswer({ provider, original: input.original, target: input.target, support: input.support, question: input.question, signal: input.signal });
    if (r.usage) usage = r.usage;
    trimmed = r.trimmed || r.fellBack;
    cancelled = !!r.cancelled || !!input.signal?.aborted;
    if (!cancelled) yield { event: "text", data: r.text };
  }

  // The same write point as an explain turn: a call that reached the model is one live turn.
  if (modelReached) access = await meterUsage(deps.store, input.studentId, access, { live_turns: 1, generated_segments: 0 }, input.productSlug);
  yield {
    event: "done",
    data: {
      latency: { totalMs: now() - t0 },
      usage,
      label,
      ...(trimmed ? { trimmed: true } : {}),
      ...(modelReached ? { metered: { live_turns: 1, generated_segments: 0 } } : {}),
      ...(cancelled ? { cancelled: true } : {}),
      access: accessView(access),
    },
  };
}
