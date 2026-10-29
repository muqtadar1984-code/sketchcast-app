/**
 * The shared school-notice builder (utils/notice-row.ts): the composer's shape
 * rules, moved out of POST /api/notices verbatim, and the row both notice
 * writers insert (the route; SK's click-only notice.school).
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/notice-row.test.ts
 */
import { describe, expect, it } from "vitest";
import { buildNoticeRow, schoolDayInstant, schoolDayStart, validateNotice, type NoticeInput } from "../notice-row";

const NOW = Date.parse("2026-10-28T08:30:00.000Z"); // 16:30 in the school's zone (UTC+8)
const ok = (input: NoticeInput) => {
  const v = validateNotice(input, NOW);
  if (!v.ok) throw new Error(v.error);
  return v.fields;
};

describe("validateNotice", () => {
  it("shapes a minimal notice: kind other, importance normal, empty body → null description", () => {
    expect(ok({ title: " Sports day ", audience: "school", startsAt: "2026-10-30T01:00:00.000Z" })).toEqual({
      title: "Sports day",
      description: null,
      kind: "other",
      audience: "school",
      starts_at: "2026-10-30T01:00:00.000Z",
      link_url: null,
      link_label: null,
      action_by: null,
      action_label: null,
      featured_until: null,
      importance: "normal",
    });
  });
  const CASES: Array<[NoticeInput, string]> = [
    [{ audience: "school", startsAt: "2026-10-30" }, "title_required"],
    [{ title: "x".repeat(121), audience: "school", startsAt: "2026-10-30" }, "title_too_long"],
    [{ title: "t", body: "x".repeat(4001), audience: "school", startsAt: "2026-10-30" }, "body_too_long"],
    [{ title: "t", audience: "leadership", startsAt: "2026-10-30" }, "audience"],
    [{ title: "t", audience: "school", startsAt: "2026-10-30", link_url: "http://x.example" }, "link_not_https"],
    [{ title: "t", audience: "school", startsAt: "not a date" }, "bad_date"],
    [{ title: "t", audience: "school" }, "no_date"],
    [{ title: "t", audience: "school", startsAt: "2026-10-30", actionBy: "2026-10-31" }, "deadline_after_event"],
    [{ title: "t", audience: "school", startsAt: "2026-10-27T10:00:00Z" }, "dates_passed"],
    [{ title: "t", audience: "school", startsAt: "2026-10-30", featuredUntil: "2026-10-27" }, "pin_past"],
    [{ title: "t", audience: "school", startsAt: "2026-10-30", featuredUntil: "2027-03-01" }, "pin_too_long"],
  ];
  it.each(CASES)("%j → %s", (input, code) => {
    const v = validateNotice(input, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(code);
  });
  it("keeps the composer's messages", () => {
    expect(validateNotice({ audience: "school" }, NOW)).toMatchObject({ error: "A notice needs a title." });
    expect(validateNotice({ title: "t", audience: "x" }, NOW)).toMatchObject({ error: "A notice goes to Everyone or to staff." });
  });
  it("a notice dated earlier TODAY (school day) is still live; midnight of today counts", () => {
    expect(validateNotice({ title: "t", audience: "staff", startsAt: "2026-10-28T01:00:00Z" }, NOW).ok).toBe(true);
    expect(validateNotice({ title: "t", audience: "staff", startsAt: schoolDayInstant("2026-10-28") }, NOW).ok).toBe(true);
    expect(schoolDayInstant("2026-10-28")).toBe(new Date(schoolDayStart(NOW)).toISOString());
    expect(schoolDayInstant("28/10/2026")).toBeNull();
  });
  it("a label with no link is dropped; an action label with no deadline is dropped", () => {
    const f = ok({ title: "t", audience: "school", startsAt: "2026-10-30", link_label: "More", actionLabel: "Pay" });
    expect(f.link_label).toBeNull();
    expect(f.action_label).toBeNull();
  });
});

describe("buildNoticeRow", () => {
  const fields = ok({ title: "t", body: "b", audience: "staff", startsAt: "2026-10-30T01:00:00.000Z" });
  it("the route's row: is_notice true, published, class null, created_by the caller, no action id, not all-day", () => {
    const row = buildNoticeRow(fields, { schoolId: "s", createdBy: "u" });
    expect(row).toMatchObject({ school_id: "s", class_id: null, created_by: "u", is_notice: true, status: "published", all_day: false, audience: "staff", title: "t", description: "b" });
    expect(row).not.toHaveProperty("sk_action_id");
  });
  it("SK's row: the same plus sk_action_id and the whole day", () => {
    const base = buildNoticeRow(fields, { schoolId: "s", createdBy: "u" });
    expect(buildNoticeRow(fields, { schoolId: "s", createdBy: "u", skActionId: "a", allDay: true })).toEqual({ ...base, all_day: true, sk_action_id: "a" });
  });
});
