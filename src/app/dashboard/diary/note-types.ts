// The diary's note-type vocabulary + chip tones — a PLAIN module (no
// "use client") so both server pages (metrics, labels) and client components
// (chips, cards) can read the values. Mirrors migration 0066's CHECK list.

import type { Dictionary } from "@/i18n/dictionaries";

export const NOTE_TYPES = ["homework", "reminder", "praise", "concern", "health", "general"] as const;

// House tones: praise gets the teal mist, concern the amber warning, health
// the red — everything else stays muted mist/graphite.
export const TYPE_STYLE: Record<string, string> = {
  homework: "bg-[#EEF0EC] text-[#5B6470]",
  reminder: "bg-[#EEF0EC] text-[#5B6470]",
  praise: "bg-[#E2F4F1] text-[#0C8175]",
  concern: "bg-[#FFF1D6] text-[#9A6400]",
  health: "bg-[#FCEBEA] text-[#B42318]",
  general: "bg-[#EEF0EC] text-[#5B6470]",
};

// The reader's WORDS for those values live in the dictionary
// (comms.diary.noteTypes), never here: "concern" is what the database stores in
// every language, and this is only how it reads on screen. Components are
// handed that slice and look a value up through the helper below, which falls
// back to the raw value for a type this build doesn't know about.
export type NoteTypeLabels = Dictionary["comms"]["diary"]["noteTypes"];

export function noteTypeLabel(labels: NoteTypeLabels, type: string): string {
  return (labels as Record<string, string>)[type] ?? type;
}

// A glanceable icon for every chip that names a type.
export const TYPE_ICON: Record<string, string> = {
  homework: "📚",
  reminder: "🔔",
  praise: "⭐",
  concern: "⚠️",
  health: "🤒",
  general: "📝",
};
