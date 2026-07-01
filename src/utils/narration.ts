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

export type VoiceOpt = { value: string; label: string; tier: "free" | "premium" };

export const VOICES: VoiceOpt[] = [
  { value: "edge-aria", label: "Aria — neutral", tier: "free" },
  { value: "edge-guy", label: "Guy — warm", tier: "free" },
  { value: "edge-neerja", label: "Neerja — Indian English", tier: "free" },
  { value: "edge-sonia", label: "Sonia — British", tier: "free" },
  { value: "el-rachel", label: "Rachel — natural", tier: "premium" },
  { value: "el-adam", label: "Adam — deep", tier: "premium" },
];
export const DEFAULT_VOICE = "edge-aria"; // free — reproduces today's behaviour

// Premium (ElevenLabs) voices are offered ONLY when explicitly enabled; the free
// tier never sees them. The worker enforces the same gate server-side regardless.
export function elevenLabsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ELEVENLABS_ENABLED === "true";
}

export function availableVoices(): VoiceOpt[] {
  return elevenLabsEnabled() ? VOICES : VOICES.filter((v) => v.tier === "free");
}
