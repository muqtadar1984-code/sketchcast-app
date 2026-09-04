import { describe, it, expect } from "vitest";
import { stepsReached, cohortWeek, buildFunnel, pct, STEPS, type FunnelSchool } from "../school-funnel";

const DAY = 86400000;
const base = (over: Partial<FunnelSchool> = {}): FunnelSchool => ({
  id: "s",
  created_at: "2026-09-02T10:00:00Z", // a Wednesday
  confirmed_at: null,
  last_sign_in_at: null,
  first_generation_at: null,
  lessons_done: 0,
  docs_done: 0,
  activation_requested_at: null,
  invoice_sent: false,
  paid: false,
  ...over,
});

describe("stepsReached", () => {
  it("a bare registration reaches only 'registered'", () => {
    expect([...stepsReached(base())]).toEqual(["registered"]);
  });
  it("the trial KPI needs BOTH a lesson and a document", () => {
    expect(stepsReached(base({ lessons_done: 3 })).has("lesson_and_document")).toBe(false);
    expect(stepsReached(base({ docs_done: 2 })).has("lesson_and_document")).toBe(false);
    expect(stepsReached(base({ lessons_done: 1, docs_done: 1 })).has("lesson_and_document")).toBe(true);
  });
  it("'returned' means a sign-in at least a day after creation — same-day activity does not count", () => {
    const created = new Date(base().created_at).getTime();
    expect(stepsReached(base({ last_sign_in_at: new Date(created + 20 * 3600000).toISOString() })).has("returned")).toBe(false);
    expect(stepsReached(base({ last_sign_in_at: new Date(created + DAY).toISOString() })).has("returned")).toBe(true);
  });
  it("paid implies invoice_sent (bank-transfer activation never issued one)", () => {
    const r = stepsReached(base({ paid: true }));
    expect(r.has("invoice_sent")).toBe(true);
    expect(r.has("paid")).toBe(true);
  });
  it("steps are judged on their own facts, not as a strict pipeline", () => {
    // Invoiced without ever generating: a school bought on a demo call.
    const r = stepsReached(base({ invoice_sent: true }));
    expect(r.has("first_generation")).toBe(false);
    expect(r.has("invoice_sent")).toBe(true);
  });
});

describe("cohortWeek", () => {
  it("snaps any day to that ISO week's Monday, in UTC", () => {
    expect(cohortWeek("2026-09-02T10:00:00Z")).toBe("2026-08-31"); // Wed → Mon
    expect(cohortWeek("2026-08-31T00:00:00Z")).toBe("2026-08-31"); // Mon → itself
    expect(cohortWeek("2026-09-06T23:59:59Z")).toBe("2026-08-31"); // Sun → previous Mon
    expect(cohortWeek("2026-09-07T00:00:00Z")).toBe("2026-09-07"); // next Mon
  });
});

describe("buildFunnel", () => {
  it("counts every step overall and per week, newest week first", () => {
    const f = buildFunnel([
      base({ id: "a", created_at: "2026-08-25T09:00:00Z", confirmed_at: "x", lessons_done: 1, docs_done: 1, paid: true }),
      base({ id: "b", created_at: "2026-09-02T09:00:00Z", confirmed_at: "x" }),
      base({ id: "c", created_at: "2026-09-03T09:00:00Z" }),
    ]);
    expect(f.total.registered).toBe(3);
    expect(f.total.confirmed).toBe(2);
    expect(f.total.lesson_and_document).toBe(1);
    expect(f.total.paid).toBe(1);
    expect(f.cohorts.map((c) => c.week)).toEqual(["2026-08-31", "2026-08-24"]);
    expect(f.cohorts[0].size).toBe(2);
    expect(f.cohorts[0].counts.confirmed).toBe(1);
    expect(f.cohorts[1].counts.paid).toBe(1);
  });
  it("is empty, not broken, with no schools", () => {
    const f = buildFunnel([]);
    for (const s of STEPS) expect(f.total[s]).toBe(0);
    expect(f.cohorts).toEqual([]);
  });
});

describe("pct", () => {
  it("rounds to a whole percent and is null when nothing registered", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(2, 3)).toBe(67);
    expect(pct(0, 0)).toBeNull();
  });
});
