// The diary's note-type vocabulary + chip tones — a PLAIN module (no
// "use client") so both server pages (metrics, labels) and client components
// (chips, cards) can read the values. Mirrors migration 0066's CHECK list.

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

// Display casing + a glanceable icon for every chip that names a type.
export const TYPE_LABEL: Record<string, string> = {
  homework: "Homework",
  reminder: "Reminder",
  praise: "Praise",
  concern: "Concern",
  health: "Health",
  general: "General",
};
export const TYPE_ICON: Record<string, string> = {
  homework: "📚",
  reminder: "🔔",
  praise: "⭐",
  concern: "⚠️",
  health: "🤒",
  general: "📝",
};
