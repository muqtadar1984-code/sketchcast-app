import type { Dictionary } from "@/i18n/dictionaries";

// Lesson narration options for the generate form. These MUST mirror the worker's
// authoritative registry (sketchcast-ai `agent3_scripts/prompts.py` STYLE_META and
// `shared/tts/registry.py`) — the stable ids (style keys + voice_ids) are the
// contract posted in `generations.params`. The worker resolves voice → provider
// and enforces the free/premium gate server-side; this list only drives the UI.

// WORDS vs IDS. Which is exactly why the words moved OUT of this file: a style's
// name and its one-line description, and a voice's name and character, all live
// in the dictionary under `utils.narration`, so the generation options read in
// the reader's language like the rest of the modal — while the ids below, the
// half the worker actually reads, never move. Translating "Socratic" must not
// change what lands in `params`. The type-only Dictionary import is erased at
// build time, so the server-only module never reaches the browser bundle.
export type NarrationMessages = Dictionary["utils"]["narration"];

export type NarrationStyle = { value: string; label: string; desc: string };

/** The style ids, in the order the picker offers them. */
export const NARRATION_STYLES = [
  "socratic",
  "direct_explainer",
  "storytelling",
  "exam_focused",
  "conversational",
] as const satisfies readonly (keyof NarrationMessages["styles"])[];

export type NarrationStyleId = (typeof NARRATION_STYLES)[number];
export const DEFAULT_STYLE: NarrationStyleId = "socratic";

/** The style picker's options, worded for the reader. */
export const narrationStyles = (t: NarrationMessages): NarrationStyle[] =>
  NARRATION_STYLES.map((value) => ({ value, label: t.styles[value], desc: t.styleHints[value] }));

/** The line under the picker describing the chosen style; "" for an unknown id
 * (a style retired from the registry but still stored on an old generation). */
export const narrationStyleHint = (t: NarrationMessages, value: string): string =>
  (t.styleHints as Record<string, string>)[value] ?? "";

// Approximate school level (1..12+) from a book's free-text grade label, so the
// narration style can default to something age-appropriate. Secondary systems
// (Form / Tingkatan / Secondary) sit ABOVE primary — Form 1 ≈ grade 7 — so they
// never read as early primary. Returns null when nothing numeric is found; the
// caller then keeps the global default.
export function gradeLevel(grade: string | null | undefined): number | null {
  if (!grade) return null;
  const g = grade.toLowerCase();
  if (/\b(kindergarten|kg|pre-?k|pre-?school|nursery|reception|tadika|prasekolah)\b/.test(g)) return 0;
  const m = g.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (!Number.isFinite(n)) return null;
  if (/\b(form|tingkatan|secondary|sec|senior)\b/.test(g)) return n + 6; // secondary
  return n;
}

// The narration style a book should default to, from its grade — three tiers:
//   • grades 1–4 (young children) → Storytelling — they learn through narrative,
//     not Socratic questioning;
//   • grades 5–9 → Socratic (the default);
//   • grade 10 onwards (older students) → Conversational — a mature, casual tone.
// Unknown grades keep Socratic. The teacher can always override in the picker.
export function defaultNarrationForGrade(grade: string | null | undefined): string {
  const lvl = gradeLevel(grade);
  if (lvl === null) return DEFAULT_STYLE;
  if (lvl <= 4) return "storytelling";
  if (lvl >= 10) return "conversational";
  return DEFAULT_STYLE;
}

export type VoiceOpt = { value: string; label: string; tier: "free" | "premium"; lang: string };

/** A voice's stable id — `keyof` the dictionary's voice map, so the registry
 * below and the ten message files are proven not to drift apart at compile
 * time (a voice added here without its label fails the type check). */
export type VoiceId = keyof NarrationMessages["voices"];

// The registry: ids, tier and language only. The name a teacher reads
// ("Aria — neutral") is `utils.narration.voices[id]` in the dictionary.
export const VOICES: { value: VoiceId; tier: "free" | "premium"; lang: string }[] = [
  { value: "edge-aria", tier: "free", lang: "en" },
  { value: "edge-guy", tier: "free", lang: "en" },
  { value: "edge-neerja", tier: "free", lang: "en" },
  { value: "edge-sonia", tier: "free", lang: "en" },
  { value: "edge-yasmin", tier: "free", lang: "ms" },
  { value: "edge-osman", tier: "free", lang: "ms" },
  { value: "edge-zariyah", tier: "free", lang: "ar" },
  { value: "edge-hamed", tier: "free", lang: "ar" },
  { value: "edge-denise", tier: "free", lang: "fr" },
  { value: "edge-henri", tier: "free", lang: "fr" },
  { value: "edge-elvira", tier: "free", lang: "es" },
  { value: "edge-alvaro", tier: "free", lang: "es" },
  { value: "edge-francisca", tier: "free", lang: "pt" },
  { value: "edge-antonio", tier: "free", lang: "pt" },
  { value: "edge-shruti", tier: "free", lang: "te" },
  { value: "edge-mohan", tier: "free", lang: "te" },
  { value: "edge-aarohi", tier: "free", lang: "mr" },
  { value: "edge-manohar", tier: "free", lang: "mr" },
  { value: "edge-swara", tier: "free", lang: "hi" },
  { value: "edge-madhur", tier: "free", lang: "hi" },
  // Premium ElevenLabs voices are multilingual — offered for every language.
  { value: "el-rachel", tier: "premium", lang: "*" },
  { value: "el-adam", tier: "premium", lang: "*" },
];
export const DEFAULT_VOICE = "edge-aria"; // free — reproduces today's behaviour

/** A voice's display name; an id no longer in the dictionary shows as itself
 * rather than blank (same rule as statusLabel/kindLabel on the Library). */
export const voiceLabel = (t: NarrationMessages, value: string): string =>
  (t.voices as Record<string, string>)[value] ?? value;

// Lesson languages — MUST mirror the worker's shared/languages.py registry.
export type LanguageOpt = { value: string; label: string };
export const LANGUAGES: LanguageOpt[] = [
  { value: "en", label: "English" },
  { value: "ms", label: "Bahasa Melayu" },
  { value: "ar", label: "العربية (Arabic)" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "pt", label: "Português" },
  { value: "te", label: "తెలుగు (Telugu)" },
  { value: "mr", label: "मराठी (Marathi)" },
  { value: "hi", label: "हिन्दी (Hindi)" },
  // Jawi — Malay in the Arabic script (RTL). Documents only for now; a video
  // lesson generated in Jawi narrates in Malay with Rumi slides (worker
  // downgrades the presentation kind until the Jawi video phase).
  { value: "ms-arab", label: "بهاس ملايو — Jawi (Malay)" },
];
export const languageLabel = (code: string | null | undefined): string | null =>
  LANGUAGES.find((l) => l.value === code)?.label ?? null;

/** The free voice that matches a lesson language (English → Aria). Jawi is
 * spoken Malay, so it borrows the Malay voice. */
export function defaultVoiceFor(lang: string | null | undefined): string {
  const l = lang === "ms-arab" ? "ms" : lang || "en";
  return VOICES.find((v) => v.tier === "free" && v.lang === l)?.value ?? DEFAULT_VOICE;
}

// Premium (ElevenLabs) voices are offered ONLY when explicitly enabled; the free
// tier never sees them. The worker enforces the same gate server-side regardless.
export function elevenLabsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ELEVENLABS_ENABLED === "true";
}

export function availableVoices(t: NarrationMessages, lang?: string | null): VoiceOpt[] {
  const pool = elevenLabsEnabled() ? VOICES : VOICES.filter((v) => v.tier === "free");
  const l = lang === "ms-arab" ? "ms" : lang; // Jawi is spoken Malay
  // The chosen language's voices lead; premium multilingual voices follow.
  const chosen = l ? pool.filter((v) => v.lang === l || v.lang === "*") : pool;
  return chosen.map((v) => ({ ...v, label: voiceLabel(t, v.value) }));
}

// The params every presentation generation should carry when the user hasn't
// picked options (batch/full-book buttons). One source of truth — matches what
// the chapter row's pickers default to. Language-aware (Malay book → Malay
// voice) and grade-aware (grades 1–4 → Storytelling, see defaultNarrationForGrade).
export function defaultPresentationParams(
  language?: string | null,
  grade?: string | null,
): Record<string, unknown> {
  return {
    narration_style: defaultNarrationForGrade(grade),
    tts_voice: defaultVoiceFor(language),
    ...(language ? { language } : {}),
  };
}
