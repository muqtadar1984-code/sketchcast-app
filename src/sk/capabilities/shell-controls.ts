// SK — the model's safety net for the no-model commands (founder 2026-10-30:
// "we need to make sure SK understands what we mean when we ask a particular
// action in different ways").
//
// The rules (rules.ts, language.ts, walkthrough.ts) take the common phrasings
// with no model at all. Anything they miss reaches the model; these four
// tools let it ACT instead of answering in prose:
//
//   start_tour           → the `walkthrough` event (start from stop 1)
//   tour_control         → the `walkthrough` event with resume|next|back|pause|skip
//   set_answer_language  → the same as "speak in X" / "back to English"
//   repeat_in_language   → the same as "say that in X"
//
// Each handler only DESCRIBES the control (SkCapabilityResult.walkthrough /
// .langCommand); the turn route stops the model there and performs it
// exactly as the rule would — the same events, the same memory override,
// no second model round. Every role, no flag: the tour and the language
// commands are every role's (rules.ts routes them for every role).

import type { SkCapability, SkCapabilityResult, SkRole, SkWalkAction } from "@/sk/shell/types";
import { normalizeLanguage, resolveLanguagePhrase, type LangCommand, type LangTarget } from "@/sk/shell/language";

const EVERY_ROLE: SkRole[] = ["teacher", "student", "parent", "school_admin", "coordinator"];
const TOUR_CONTROLS: ReadonlySet<SkWalkAction> = new Set(["resume", "next", "back", "pause", "skip"]);
const LANGUAGES = "English, Malay (Bahasa Melayu), Jawi, Arabic, French, Spanish, Portuguese, Hindi, Telugu, Marathi or Chinese";

/** A language as the model passes it ("Arabic", "ar", "Bahasa Melayu", "my
 *  language") → the command's target. A real language SK cannot answer in
 *  stays `{unsupported}` so the route says "I can speak …". */
export function languageTarget(raw: unknown): LangTarget | null {
  const s = typeof raw === "string" ? raw.trim().slice(0, 40) : "";
  if (!s) return null;
  const named = resolveLanguagePhrase(s);
  if (named) return named;
  const n = normalizeLanguage(s);
  if (typeof n === "string") return { code: n };
  if (n) return { unsupported: n.unsupported };
  return /^[\p{L}\p{M}][\p{L}\p{M} -]{1,30}$/u.test(s) ? { unsupported: s.toLowerCase() } : null;
}

function langResult(kind: LangCommand["kind"], raw: unknown): SkCapabilityResult {
  const target = languageTarget(raw);
  if (!target) return { ok: false, summary: "Which language? Pass its name, e.g. 'Arabic'.", error: "language required", facts: [] };
  const summary = kind === "back" ? "Switching the conversation's language." : "Saying the last explanation again in that language.";
  return { ok: true, summary, facts: [], langCommand: { kind, target } };
}

export const startTour: SkCapability = {
  meta: {
    name: "start_tour",
    description:
      "Start the step-by-step walkthrough of the SketchCast app from its first stop: SK moves the user around the pages and explains each one. Use whenever the user asks to be shown around, for a tour, a demo, a walkthrough, onboarding, how the app works, or what SK can do — in any wording or language, typed or spoken, e.g. 'show me around', 'can you show me around the app', 'give me a tour', 'what can you do', 'what can I do here', 'walk me through the app', 'how does this work', 'tunjukkan saya sekeliling', 'خذني في جولة'. Do not describe the app or list features instead — call this. Not for a question about one feature.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    tier: "immediate",
    kind: "nav",
    roles: EVERY_ROLE,
  },
  async handler() {
    return { ok: true, summary: "Starting the app walkthrough.", facts: [], walkthrough: "start" };
  },
};

export const tourControl: SkCapability = {
  meta: {
    name: "tour_control",
    description:
      "Move the app walkthrough that is already running: resume (continue / keep going), next (the next stop), back (the previous stop), pause (hold on / wait), skip (stop / end / exit the walkthrough). Use for any wording of these while the walkthrough is on.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["resume", "next", "back", "pause", "skip"], description: "What to do with the running walkthrough." } },
      required: ["action"],
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "nav",
    roles: EVERY_ROLE,
  },
  async handler(_ctx, args) {
    const action = String(args.action ?? "") as SkWalkAction;
    if (!TOUR_CONTROLS.has(action)) return { ok: false, summary: "action must be resume, next, back, pause or skip.", error: "bad action", facts: [] };
    return { ok: true, summary: `Walkthrough: ${action}.`, facts: [], walkthrough: action };
  },
};

export const setAnswerLanguage: SkCapability = {
  meta: {
    name: "set_answer_language",
    description: `Switch the language SK answers in from now on (the user says: speak / talk / reply / switch to / use / back to <language>, or "my language"). Languages: ${LANGUAGES}. Do not translate anything yourself; this switches the conversation.`,
    parameters: {
      type: "object",
      properties: { language: { type: "string", description: "The language's name or code, e.g. 'Arabic', 'ms', or 'my language' for the page's own." } },
      required: ["language"],
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "nav",
    roles: EVERY_ROLE,
  },
  async handler(_ctx, args) {
    return langResult("back", args.language);
  },
};

export const repeatInLanguage: SkCapability = {
  meta: {
    name: "repeat_in_language",
    description: `Say SK's LAST explanation again in another language (the user says: say that / repeat it / explain that again / translate that in <language>). Languages: ${LANGUAGES}. Do not translate it yourself; this re-says it faithfully and keeps answering in that language.`,
    parameters: {
      type: "object",
      properties: { language: { type: "string", description: "The language's name or code, e.g. 'Malay', 'hi'." } },
      required: ["language"],
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "nav",
    roles: EVERY_ROLE,
  },
  async handler(_ctx, args) {
    return langResult("repeat", args.language);
  },
};

export const SHELL_CONTROL_CAPABILITIES: SkCapability[] = [startTour, tourControl, setAnswerLanguage, repeatInLanguage];
