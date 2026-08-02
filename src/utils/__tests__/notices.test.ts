import { describe, it, expect } from "vitest";
import { countdownFor } from "../notices";

// The two-clock countdown is the one piece of notices logic with no UI to
// check it by eye: it flips clocks mid-life and buckets days in the SCHOOL's
// timezone, both of which are silently wrong-by-one until someone reads a
// notice from abroad. Fixed clocks throughout.
const cd = (starts: string | null, action: string | null, now: string) =>
  countdownFor({ starts_at: starts, action_by: action }, Date.parse(now))!;

describe("countdownFor", () => {
  it("buckets days in Kuala Lumpur, not UTC", () => {
    // 16:30Z is already 00:30 on the NEXT civil day in KL, so an event at
    // 17:00Z is "today" — a UTC bucket would say tomorrow.
    const c = cd("2026-08-02T17:00:00Z", null, "2026-08-02T16:30:00Z");
    expect([c.days, c.label]).toEqual([0, "today"]);
  });

  it("counts the deadline first, then flips to the event", () => {
    const before = cd("2026-08-20T01:00:00Z", "2026-08-05T09:00:00Z", "2026-08-02T02:00:00Z");
    expect(before.clock).toBe("action");
    expect(before.targetIso).toBe("2026-08-05T09:00:00.000Z");
    const after = cd("2026-08-20T01:00:00Z", "2026-08-05T09:00:00Z", "2026-08-06T02:00:00Z");
    expect(after.clock).toBe("start");
    expect(after.targetIso).toBe("2026-08-20T01:00:00.000Z");
  });

  it("keeps a pure deadline on its own clock once it has passed", () => {
    const c = cd(null, "2026-08-01T09:00:00Z", "2026-08-02T02:00:00Z");
    expect([c.clock, c.label, c.past]).toEqual(["action", "yesterday", true]);
  });

  it("names a weekday only inside this week", () => {
    // 2026-08-02 is a Sunday in KL: Tuesday is next week, so it counts.
    expect(cd("2026-08-04T02:00:00Z", null, "2026-08-02T02:00:00Z").label).toBe("in 2 days");
    // From Monday, Saturday is the same Monday-start week.
    expect(cd("2026-08-08T02:00:00Z", null, "2026-08-03T02:00:00Z").label).toBe("this Saturday");
    expect(cd("2026-08-04T02:00:00Z", null, "2026-08-03T02:00:00Z").label).toBe("tomorrow");
    expect(cd("2026-08-20T02:00:00Z", null, "2026-08-03T02:00:00Z").label).toBe("in 2 weeks");
  });

  it("marks two days out or less as urgent", () => {
    expect(cd("2026-08-05T02:00:00Z", null, "2026-08-03T02:00:00Z").urgent).toBe(true);
    expect(cd("2026-08-06T02:00:00Z", null, "2026-08-03T02:00:00Z").urgent).toBe(false);
  });

  it("has no clock only for a dateless row (0068 forbids one)", () => {
    expect(countdownFor({ starts_at: null, action_by: null })).toBeNull();
  });
});
