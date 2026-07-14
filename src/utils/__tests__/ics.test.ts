import { describe, it, expect } from "vitest";
import { buildIcs, escapeIcsText, foldIcsLine, icsUtc, icsDate } from "../ics";

describe("escapeIcsText", () => {
  it("escapes the RFC 5545 specials, backslash first", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    expect(escapeIcsText("Sports Day — Field A, 9am")).toBe("Sports Day — Field A\\, 9am");
  });
});

describe("foldIcsLine", () => {
  it("leaves short lines alone and folds long ones at 75 chars with continuation spaces", () => {
    expect(foldIcsLine("SUMMARY:short")).toBe("SUMMARY:short");
    const long = "DESCRIPTION:" + "x".repeat(200);
    const folded = foldIcsLine(long);
    const lines = folded.split("\r\n");
    expect(lines[0].length).toBe(75);
    expect(lines.slice(1).every((l) => l.startsWith(" ") && l.length <= 75)).toBe(true);
    // Unfolding (strip CRLF + one space) restores the original line exactly.
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });
});

describe("date formats", () => {
  it("renders UTC basic format and DATE values", () => {
    expect(icsUtc("2026-07-15T01:30:00.000Z")).toBe("20260715T013000Z");
    expect(icsDate("2026-07-15T01:30:00.000Z")).toBe("20260715");
  });
});

describe("buildIcs", () => {
  const NOW = "2026-07-15T00:00:00.000Z";
  it("emits a valid VCALENDAR with timed and all-day events", () => {
    const ics = buildIcs({
      name: "Demo School",
      now: NOW,
      events: [
        {
          uid: "e1@sketchcast.app",
          title: "Staff meeting",
          startsAt: "2026-07-20T07:00:00.000Z",
          endsAt: "2026-07-20T08:00:00.000Z",
          location: "Staff room",
          category: "meeting",
        },
        {
          uid: "e2@sketchcast.app",
          title: "School holiday",
          startsAt: "2026-08-31T00:00:00.000Z",
          allDay: true,
        },
      ],
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("SUMMARY:Staff meeting");
    expect(ics).toContain("DTSTART:20260720T070000Z");
    expect(ics).toContain("DTEND:20260720T080000Z");
    expect(ics).toContain("LOCATION:Staff room");
    expect(ics).toContain("CATEGORIES:MEETING");
    // All-day: DATE values, exclusive DTEND (the next day).
    expect(ics).toContain("DTSTART;VALUE=DATE:20260831");
    expect(ics).toContain("DTEND;VALUE=DATE:20260901");
    // CRLF line endings throughout.
    expect(ics.includes("\n") && !ics.includes("\r\n")).toBe(false);
  });
  it("defaults DTEND to the start for point events", () => {
    const ics = buildIcs({
      name: "X",
      now: NOW,
      events: [{ uid: "e3", title: "Due", startsAt: "2026-07-21T04:00:00.000Z" }],
    });
    expect(ics).toContain("DTSTART:20260721T040000Z");
    expect(ics).toContain("DTEND:20260721T040000Z");
  });
});
