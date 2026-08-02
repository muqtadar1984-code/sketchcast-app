import Link from "next/link";
import type { Dictionary } from "@/i18n/dictionaries";

// The diary's day picker + the civil-day helpers every diary surface shares.
// Days follow the calendar page's convention: Malaysia is fixed UTC+8 (no
// DST), so a constant offset buckets timestamps into civil days; make this
// per-school config when a school outside MY signs up.

export const DAY_MS = 86400000;
export const TZ_OFFSET_MS = 8 * 3600000;

export function isDayKey(s: string | null | undefined): s is string {
  return /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");
}

/** Today's civil (UTC+8) day key: "2026-07-30". (Server components call this
 * once per request — the Date.now() is fine there.) */
export function todayKey(): string {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant range covering one civil day — for created_at/completed_at
 * joins (diary_notes.entry_date compares by the key directly). */
export function dayWindowUtc(day: string): { startUtc: string; endUtc: string } {
  const start = Date.parse(`${day}T00:00:00Z`) - TZ_OFFSET_MS;
  return { startUtc: new Date(start).toISOString(), endUtc: new Date(start + DAY_MS).toISOString() };
}

export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Prev / label / next — pure links, so the whole page stays a server render.
 * `lang` is passed explicitly rather than left to the runtime default, which is
 * the SERVER's locale here — the reader would get the day name in a language
 * they never chose. */
export default function DateNav({
  day,
  href,
  t,
  lang,
}: {
  day: string;
  href: (d: string) => string;
  t: Dictionary["comms"]["diary"]["nav"];
  lang: string;
}) {
  const today = todayKey();
  const label = new Date(`${day}T00:00:00Z`).toLocaleDateString(lang, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC", // the key IS the civil day — don't re-shift it
  });
  return (
    <div className="flex items-center gap-2 mb-6">
      <Link href={href(shiftDay(day, -1))} aria-label={t.previousDay} className="btn-ghost h-9 px-3 text-sm">
        <span className="rtl-flip">←</span>
      </Link>
      <span className="font-display text-lg whitespace-nowrap">{label}</span>
      <Link href={href(shiftDay(day, 1))} aria-label={t.nextDay} className="btn-ghost h-9 px-3 text-sm">
        <span className="rtl-flip">→</span>
      </Link>
      {day !== today && (
        <Link href={href(today)} className="text-sm font-medium text-[#0C8175] hover:underline ms-1">
          {t.today}
        </Link>
      )}
    </div>
  );
}
