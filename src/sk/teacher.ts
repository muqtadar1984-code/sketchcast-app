// SK B4 — the question path ("Teacher", plan §3): ONE Sonnet 5.5 call through
// the existing LLMProvider. The unit's content is the system prefix (the
// Anthropic adapter marks the system block cache_control: ephemeral, so every
// question on the same unit reuses the cached prefix); the student's question
// is the only user turn beyond the short history. The model streams the spoken
// answer as text and may call `draw_aside` ONCE with a TAL-shaped program;
// that program is checked by `validateAside` before anything is sent — a
// rejected program is dropped whole and the spoken answer still goes out.

import type { LLMProvider, ToolDef, Turn } from "@/utils/assistant/provider";
import { ASIDE_LIMITS, ASIDE_TAL, asideTargets, validateAside, type AsideProgram, type AsideTargets } from "./aside";
import type { Segment } from "./board/engine";
import type { RetrievalResult, RetrievedPassage } from "./retrieval";
import type { GraphUnit } from "./types";

export const TEACHER_MAX_TOKENS = 700;
export const MAX_HISTORY_TURNS = 8;

export const ASIDE_TOOL: ToolDef = {
  name: "draw_aside",
  description:
    "Optionally draw on the paused board while you speak: label, highlight or write, cued in milliseconds from the start of your answer. Call at most once. Target ONLY the ids listed in the system prompt. Keep it to a few marks that make the answer clearer.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["actions"],
    properties: {
      tal: { type: "string", enum: [ASIDE_TAL] },
      duration_ms: { type: "integer", minimum: 0, maximum: ASIDE_LIMITS.duration },
      actions: {
        type: "array",
        maxItems: ASIDE_LIMITS.actions,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "id", "t"],
          properties: {
            op: { type: "string", enum: ["label", "highlight", "write"] },
            id: { type: "string", pattern: "^g[a-z0-9_-]{0,20}$", description: "Unique, starts with g (e.g. g1)." },
            t: { type: "integer", minimum: 0, maximum: ASIDE_LIMITS.duration },
            dur: { type: "integer", minimum: 0, maximum: 5000 },
            target: { type: "string", description: "label/highlight: one of the listed target ids." },
            text: { type: "string", maxLength: 60, description: "label/write: plain text." },
            side: { type: "string", enum: ["left", "right"] },
            style: { type: "string", enum: ["circle", "strike", "muted"] },
            at: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: { type: "number", minimum: 0, maximum: 100 }, y: { type: "number", minimum: 0, maximum: 100 } } },
            size: { type: "number", minimum: 1, maximum: 8 },
          },
        },
      },
      gestures: {
        type: "array",
        maxItems: ASIDE_LIMITS.gestures,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["t", "kind"],
          properties: {
            t: { type: "integer", minimum: 0 },
            kind: { type: "string", enum: ["point", "write", "idle"] },
            target: { type: "string" },
            until: { type: "integer", minimum: 0 },
          },
        },
      },
    },
  },
};

export function describeTargets(targets: AsideTargets): string {
  const lines: string[] = [];
  for (const [asId, regions] of Object.entries(targets.placed)) {
    lines.push(`${asId} (the whole figure)`);
    for (const r of regions) lines.push(`${asId}.${r}`);
  }
  for (const e of targets.elements) lines.push(e);
  return lines.join(", ");
}

/** The cached prefix: who SK is, the rules, and the unit's content. Stable per
 * unit so the provider's prompt cache serves every question on it. */
export function buildTeacherSystem(input: { unit: GraphUnit; segment: Segment; targets: AsideTargets; language?: string }): string {
  const { unit, segment, targets } = input;
  return [
    "You are SK, an animated tutor for school students. A lesson segment is PAUSED on the board and the student has just asked you something.",
    "Answer in the lesson's language, spoken style, 2–4 short sentences (under 70 words), warm and plain. You are talking to a child: no sarcasm, nothing frightening, nothing personal.",
    "GROUND every fact in the UNIT CONTENT below. If the question goes beyond it, say so in one sentence and offer to come back to it after the lesson — do not invent anatomy, numbers or formulas.",
    "When BOOK PASSAGES come with the question, they are the book's own words on it: ground on them first, then on the unit content, and nothing else.",
    "Never give the answer to a check question that is being asked; guide instead.",
    `You may call draw_aside once to label, highlight or write on the board. Allowed targets: ${describeTargets(targets) || "(none)"}. Coordinates for write are 0–100 on the board.`,
    "Do not describe the drawing in words beyond what you say to the student.",
    "",
    `UNIT: ${unit.unit_key} — ${unit.title}`,
    "UNIT CONTENT (what the lesson says):",
    segment.narration,
  ].join("\n");
}

export type TeacherEvent =
  | { type: "text"; text: string }
  | { type: "tal"; program: AsideProgram }
  | { type: "aside_rejected"; reason: string }
  | { type: "done"; fullText: string; usage: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string; retryable?: boolean }
  | { type: "cancelled"; fullText: string };

export type TeacherInput = {
  provider: LLMProvider;
  unit: GraphUnit;
  segment: Segment;
  hitmapElementIds?: string[];
  question: string;
  history?: Turn[];
  signal?: AbortSignal;
  maxTokens?: number;
  /** What retrieval found for this question (B6/R1). Only "grounded" changes
   * the call: its passages ride in the USER turn, so the per-unit system
   * prefix stays byte-identical and the prompt cache keeps serving it. */
  grounding?: RetrievalResult;
};

/** Each passage is capped so a long table cannot crowd out the question. */
const PASSAGE_MAX_CHARS = 700;
const MAX_PASSAGES = 5;

/** The user turn when the book has something to say: the passages (the
 * book's own words, with their unit and kind) and then the question. */
export function questionWithPassages(question: string, passages: RetrievedPassage[]): string {
  const q = question.slice(0, 600);
  const lines = passages.slice(0, MAX_PASSAGES).map((p, i) => `[${i + 1}] (${p.unitKey ?? "book"}, ${p.blockType.replace(/_/g, " ")}) ${p.text.slice(0, PASSAGE_MAX_CHARS)}`);
  if (!lines.length) return q;
  return ["BOOK PASSAGES (the book's own words on this; ground on them):", ...lines, "", `STUDENT QUESTION: ${q}`].join("\n");
}

export async function* answerQuestion(input: TeacherInput): AsyncGenerator<TeacherEvent, void, void> {
  const targets = asideTargets(input.segment, input.hitmapElementIds ?? []);
  const system = buildTeacherSystem({ unit: input.unit, segment: input.segment, targets });
  const history = (input.history ?? []).slice(-MAX_HISTORY_TURNS);
  const userText = input.grounding?.status === "grounded" ? questionWithPassages(input.question, input.grounding.passages) : input.question.slice(0, 600);
  let fullText = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  let asideSeen = false;
  for await (const ev of input.provider.stream({
    system,
    messages: [...history, { role: "user", text: userText }],
    tools: [ASIDE_TOOL],
    maxTokens: input.maxTokens ?? TEACHER_MAX_TOKENS,
    signal: input.signal,
  })) {
    if (ev.type === "text") {
      fullText += ev.text;
      yield { type: "text", text: ev.text };
    } else if (ev.type === "tool_call") {
      // The gate: the program is model output and is validated whole or dropped whole.
      if (ev.call.name !== ASIDE_TOOL.name || asideSeen) continue;
      asideSeen = true;
      try {
        yield { type: "tal", program: validateAside(ev.call.args, input.segment, input.hitmapElementIds ?? []) };
      } catch (e) {
        yield { type: "aside_rejected", reason: (e as Error).message };
      }
    } else if (ev.type === "done") {
      usage = ev.usage;
    } else if (ev.type === "error") {
      yield { type: "error", message: ev.message, retryable: ev.retryable };
      return;
    }
  }
  if (input.signal?.aborted) {
    yield { type: "cancelled", fullText };
    return;
  }
  yield { type: "done", fullText, usage };
}

/** What SK says when no model is configured (local dev without a key): honest,
 * short, and it keeps the lesson moving. */
export const NO_TEACHER_TEXT = "I can't answer questions right now, but let's keep going with the lesson and your teacher can help with that one.";

/** What SK says when retrieval reports the book has nothing on the question
 * (the hybrid gate, R1 §4.2): honest, no guess, no model call, the lesson
 * carries on. Deterministic so an off-book question can never be answered
 * from the model's memory. */
export const NOT_IN_BOOK_TEXT = "I can't find that in this book, so I won't guess. Let's carry on with the lesson — that's a good one to ask your teacher, or we can come back to it at the end.";
