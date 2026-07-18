// Lesson narration options for the generate form. These MUST mirror the worker's
// authoritative registry (sketchcast-ai `agent3_scripts/prompts.py` STYLE_META and
// `shared/tts/registry.py`) — the stable ids (style keys + voice_ids) are the
// contract posted in `generations.params`. The worker resolves voice → provider
// and enforces the free/premium gate server-side; this list only drives the UI.

export type NarrationStyle = { value: string; label: string; desc: string };

export const NARRATION_STYLES: NarrationStyle[] = [
  { value: "socratic", label: "Socratic", desc: "Guides students to discover ideas through questions." },
  { value: "direct_explainer", label: "Direct explainer", desc: "Clear, straightforward teaching with minimal questioning." },
  { value: "storytelling", label: "Storytelling", desc: "Wraps the concept in a narrative through-line." },
  { value: "exam_focused", label: "Exam focused", desc: "Revision framing — key points and common mistakes." },
  { value: "conversational", label: "Conversational", desc: "Casual, friendly, plain-language tone." },
];
export const DEFAULT_STYLE = "socratic";

export type VoiceOpt = { value: string; label: string; tier: "free" | "premium"; lang: string };

export const VOICES: VoiceOpt[] = [
  { value: "edge-aria", label: "Aria — neutral", tier: "free", lang: "en" },
  { value: "edge-guy", label: "Guy — warm", tier: "free", lang: "en" },
  { value: "edge-neerja", label: "Neerja — Indian English", tier: "free", lang: "en" },
  { value: "edge-sonia", label: "Sonia — British", tier: "free", lang: "en" },
  { value: "edge-yasmin", label: "Yasmin — Bahasa Melayu", tier: "free", lang: "ms" },
  { value: "edge-osman", label: "Osman — Bahasa Melayu", tier: "free", lang: "ms" },
  { value: "edge-zariyah", label: "Zariyah — العربية", tier: "free", lang: "ar" },
  { value: "edge-hamed", label: "Hamed — العربية", tier: "free", lang: "ar" },
  { value: "edge-denise", label: "Denise — Français", tier: "free", lang: "fr" },
  { value: "edge-henri", label: "Henri — Français", tier: "free", lang: "fr" },
  { value: "edge-elvira", label: "Elvira — Español", tier: "free", lang: "es" },
  { value: "edge-alvaro", label: "Álvaro — Español", tier: "free", lang: "es" },
  { value: "edge-francisca", label: "Francisca — Português", tier: "free", lang: "pt" },
  { value: "edge-antonio", label: "Antônio — Português", tier: "free", lang: "pt" },
  // Premium ElevenLabs voices are multilingual — offered for every language.
  { value: "el-rachel", label: "Rachel — natural", tier: "premium", lang: "*" },
  { value: "el-adam", label: "Adam — deep", tier: "premium", lang: "*" },
];
export const DEFAULT_VOICE = "edge-aria"; // free — reproduces today's behaviour

// Lesson languages — MUST mirror the worker's shared/languages.py registry.
export type LanguageOpt = { value: string; label: string };
export const LANGUAGES: LanguageOpt[] = [
  { value: "en", label: "English" },
  { value: "ms", label: "Bahasa Melayu" },
  { value: "ar", label: "العربية (Arabic)" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "pt", label: "Português" },
];
export const languageLabel = (code: string | null | undefined): string | null =>
  LANGUAGES.find((l) => l.value === code)?.label ?? null;

/** The free voice that matches a lesson language (English → Aria). */
export function defaultVoiceFor(lang: string | null | undefined): string {
  return VOICES.find((v) => v.tier === "free" && v.lang === (lang || "en"))?.value ?? DEFAULT_VOICE;
}

// Premium (ElevenLabs) voices are offered ONLY when explicitly enabled; the free
// tier never sees them. The worker enforces the same gate server-side regardless.
export function elevenLabsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ELEVENLABS_ENABLED === "true";
}

export function availableVoices(lang?: string | null): VoiceOpt[] {
  const pool = elevenLabsEnabled() ? VOICES : VOICES.filter((v) => v.tier === "free");
  if (!lang) return pool;
  // The chosen language's voices lead; premium multilingual voices follow.
  return pool.filter((v) => v.lang === lang || v.lang === "*");
}

// The params every presentation generation should carry when the user hasn't
// picked options (batch/full-book buttons). One source of truth — matches what
// the chapter row's pickers default to. Language-aware: a Bahasa Melayu book
// defaults to a Malay voice and carries its language explicitly.
export function defaultPresentationParams(language?: string | null): Record<string, unknown> {
  return {
    narration_style: DEFAULT_STYLE,
    tts_voice: defaultVoiceFor(language),
    ...(language ? { language } : {}),
  };
}
