// Worksheet practice — the help LADDER and where each rung's words come from
// (SK student Board plan 2026-10-31, phase 2). PURE except `generateHelp`,
// whose model call is injected.
//
// THE LADDER, PER QUESTION, PER PRACTICE SESSION. Every wrong answer and every
// "help" tap climbs one rung:
//   1st → HINT        a nudge; never the answer
//   2nd → STEP        one worked step; never the answer
//   3rd → ANSWER      the key, with a short explanation
// and stays on ANSWER after that. A right answer ends the question.
//
// WHERE THE WORDS COME FROM, in order:
//   1. the paper's own help — a `hint` for rung 1, a `step` / `steps[0]` /
//      `working` for rung 2, an `explanation` / `marking_scheme` (or a
//      subjective question's `answer_outline`) for rung 3 — when it is there
//      and, for rungs 1–2, does not give the answer away;
//   2. the cache (sk_practice_help) — model-written help another student's
//      wrong answer already paid for;
//   3. Haiku 5.5, grounded on the question and its key, told never to state
//      the answer before rung 3 — and CHECKED: a hint or step that contains
//      the key is thrown away, never shown and never cached;
//   4. nothing — the client then shows its own generic line for the rung
//      ("Read the question again…"), which knows nothing about the answer.
// The key itself is only ever sent at rung 3.

import { createHash } from "node:crypto";
import { norm, type RawQuestion } from "@/app/api/quiz/logic";
import { keyText } from "./check";

export type Rung = "hint" | "step" | "answer";
export const RUNGS: readonly Rung[] = ["hint", "step", "answer"];

/** The rung served after `misses` wrong answers / help taps on this question (1-based). */
export function rungFor(misses: number): Rung {
  return misses <= 1 ? "hint" : misses === 2 ? "step" : "answer";
}

/** The model SK's practice help is written with. */
export const PRACTICE_MODEL = "claude-haiku-5-5";
/** Haiku 5.5, USD per token (worker shared/claude_client.py MODEL_PRICING; as manifest/service.ts). */
export const PRICE_IN = 0.1 / 1e6;
export const PRICE_OUT = 0.5 / 1e6;
export const HELP_MAX_TOKENS = 220;
const MAX_BODY = 2000;

const field = (q: RawQuestion, names: string[]): string | null => {
  const r = q as unknown as Record<string, unknown>;
  for (const n of names) {
    const v = r[n];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0].trim();
  }
  return null;
};

/** The question + its key, hashed: the cache key's guard against a re-generated paper. */
export function questionHash(q: RawQuestion): string {
  const r = q as unknown as Record<string, unknown>;
  const shape = JSON.stringify([q.type, String(q.prompt ?? ""), r.options ?? null, keyText(q), r.accept ?? null]);
  return createHash("sha256").update(shape).digest("hex");
}

/**
 * Does this help text give the answer away? For rungs 1–2 only. The key (and
 * every accepted alternative) of ≥ 2 characters, or any number the key
 * reads as, must not appear in it; a match question's right-hand items must
 * not be paired with their prompts; "the answer is" is refused outright.
 */
export function leaksKey(q: RawQuestion, text: string): boolean {
  const t = norm(text);
  if (/\b(the )?(correct )?answer is\b/.test(t)) return true;
  if (q.type === "true_false") return /\b(it is|it's|this is|that is) (true|false)\b|\b(true|false)\.?$/.test(t);
  if (q.type === "subjective") return false; // an outline is long prose; the prompt forbids restating it
  if (q.type === "match") {
    return (q.pairs ?? []).some((p) => {
      const l = norm(p?.left);
      const r = norm(p?.right);
      return !!l && !!r && (t.includes(`${l} → ${r}`) || t.includes(`${l} - ${r}`) || t.includes(`${l} matches ${r}`) || t.includes(`${l}: ${r}`));
    });
  }
  const keys = [q.answer, ...((q as { accept?: unknown[] }).accept ?? [])].map((k) => norm(k)).filter((k) => k.length >= 2);
  for (const k of keys) {
    if (/^[\p{L}\p{N} ]+$/u.test(k)) {
      // matched from a word start, so a plural or an inflection ("cells" for "cell") gives it away too
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(t)) return true;
    } else if (t.includes(k)) return true;
  }
  // a one-character key (a digit, a letter answer) is checked as a whole token
  const short = [q.answer].map((k) => norm(k)).filter((k) => k.length === 1);
  return short.some((k) => new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "u").test(t));
}

/** The paper's own words for this rung, or null. Rungs 1–2 are refused when they leak the key. */
export function paperHelp(q: RawQuestion, rung: Rung): string | null {
  const text =
    rung === "hint"
      ? field(q, ["hint"])
      : rung === "step"
        ? field(q, ["step", "steps", "working", "worked_step"])
        : field(q, ["explanation", "marking_scheme", "solution", "rationale"]);
  if (!text) return null;
  if (rung !== "answer" && leaksKey(q, text)) return null;
  return text.slice(0, MAX_BODY);
}

/** The model prompt for one rung. The key is GROUNDING, and the system prompt forbids repeating it before rung 3. */
export function helpPrompt(q: RawQuestion, rung: Rung): { system: string; user: string } {
  const r = q as unknown as Record<string, unknown>;
  const options = Array.isArray(r.options) ? (r.options as unknown[]).map(String) : [];
  const lines = [
    `Question type: ${q.type}`,
    `Question: ${String(q.prompt ?? "")}`,
    ...(options.length ? [`Options: ${options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(" | ")}`] : []),
    ...(q.type === "match" ? [`Left items: ${(q.pairs ?? []).map((p) => p.left).join(" | ")}`] : []),
    `Correct answer (for your eyes only): ${keyText(q) || "(not given)"}`,
  ];
  const task =
    rung === "hint"
      ? "Write ONE short hint (at most 2 sentences) that points the student toward the idea they need. Do NOT state, spell, quote or give away the correct answer, any part of it, or any option letter."
      : rung === "step"
        ? "The student has been wrong twice. Write ONE worked step (at most 3 sentences) that shows how to start solving it — the method, not the result. Do NOT state, spell, quote or give away the correct answer, any part of it, or any option letter."
        : "The student has been wrong three times and will now be shown the correct answer. Explain in at most 2 short sentences WHY it is correct.";
  const system = [
    "You are SK, a patient, encouraging tutor helping a school student practise a worksheet question.",
    task,
    "Write in the same language as the question. Plain text only — no markdown, no lists, no headings. Speak to the student directly and kindly.",
  ].join(" ");
  return { system, user: lines.join("\n") };
}

export type HelpUsage = { input_tokens: number; output_tokens: number };
/** One model round trip. Injected in tests; the route's default goes through claudeClient()/claudeModel(). */
export type HelpModelCall = (req: { model: string; system: string; user: string; maxTokens: number }) => Promise<{ text: string; usage: HelpUsage }>;

export const helpCost = (u: HelpUsage): number => Math.round((u.input_tokens * PRICE_IN + u.output_tokens * PRICE_OUT) * 1e6) / 1e6;

/**
 * Ask the model for one rung. Null when the call fails, the reply is empty,
 * or (rungs 1–2) it gives the answer away — the caller then falls back.
 */
export async function generateHelp(call: HelpModelCall, q: RawQuestion, rung: Rung): Promise<{ text: string; cost: number } | null> {
  try {
    const p = helpPrompt(q, rung);
    const res = await call({ model: PRACTICE_MODEL, system: p.system, user: p.user, maxTokens: HELP_MAX_TOKENS });
    const text = String(res.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_BODY);
    if (!text) return null;
    if (rung !== "answer" && leaksKey(q, text)) return null;
    return { text, cost: helpCost(res.usage) };
  } catch {
    return null;
  }
}
