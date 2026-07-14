// Minimal RFC 5545 (iCalendar) writer for the school-calendar feed. Pure and
// dependency-free so it's unit-testable; covers exactly what subscribe-by-URL
// consumers (Google/Outlook/Apple) need: VEVENTs with UTC times or all-day
// dates, escaped text, and 75-octet line folding.

export type IcsEvent = {
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  /** ISO timestamp. */
  startsAt: string;
  /** ISO timestamp; defaults to start (Google renders a point event). */
  endsAt?: string | null;
  allDay?: boolean;
  /** e.g. "meeting" | "exam" — becomes CATEGORIES. */
  category?: string | null;
};

// TEXT escaping per RFC 5545 §3.3.11 (backslash first, then the specials).
export function escapeIcsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// Long content lines are folded at 75 octets with CRLF + one space (§3.1).
// Folding by chars (not bytes) is slightly conservative for multi-byte text —
// still spec-valid, consumers unfold identically.
export function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(" " + line.slice(i, i + 74));
  return parts.join("\r\n");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 20260714T093000Z — UTC basic format. */
export function icsUtc(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** 20260714 — the DATE value used for all-day events. */
export function icsDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function nextDay(iso: string): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export function buildIcs(opts: { name: string; events: IcsEvent[]; now?: string }): string {
  const stamp = icsUtc(opts.now ?? new Date().toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SketchCast//School Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(opts.name)}`,
  ];
  for (const ev of opts.events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcsText(ev.uid)}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.allDay) {
      // All-day: DATE values; DTEND is EXCLUSIVE → the day after the last day.
      lines.push(`DTSTART;VALUE=DATE:${icsDate(ev.startsAt)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDate(nextDay(ev.endsAt ?? ev.startsAt))}`);
    } else {
      lines.push(`DTSTART:${icsUtc(ev.startsAt)}`);
      lines.push(`DTEND:${icsUtc(ev.endsAt ?? ev.startsAt)}`);
    }
    lines.push(`SUMMARY:${escapeIcsText(ev.title)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
    if (ev.category) lines.push(`CATEGORIES:${escapeIcsText(ev.category.toUpperCase())}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
