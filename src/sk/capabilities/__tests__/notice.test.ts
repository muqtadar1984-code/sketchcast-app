/**
 * S5 slice D: `notice.school` RESOLVES a leader's school / all-staff notice
 * into a click-only confirm card — audience, title, exact body, start day, who
 * will see it — and refuses anyone without standing (a teacher with no scope,
 * a parent, the teacher hat). The phrasings route to it (EN / MS / AR), ahead
 * of the diary's "post a notice to …".
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/notice.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveNoticeTitle, noticeAudience, noticeSchoolAction, noticeStanding, resolveNoticeSchool, tidyNoticeText } from "../notice";
import { NOW, SCHOOL_ID, fakeSession, makeCtx } from "@/sk/shell/__tests__/fixtures";
import { allowedFor } from "@/sk/shell/registry";
import { actPhraseOf, routeByRules } from "@/sk/shell/rules";
import type { SkCapabilityDeps } from "@/sk/shell/types";

const saved: { v?: string } = {};
beforeEach(() => {
  saved.v = process.env.FEATURE_NOTICES;
  process.env.FEATURE_NOTICES = "true";
});
afterEach(() => {
  if (saved.v === undefined) delete process.env.FEATURE_NOTICES;
  else process.env.FEATURE_NOTICES = saved.v;
});

const principal = (o: { locale?: string } = {}) => makeCtx({ role: "school_admin", hat: "principal", locale: o.locale });
const coordinator = () => makeCtx({ role: "teacher", hat: "coordinator", scope: [{ grade: "5", subject: null }] });
const deps = (schools = [{ id: SCHOOL_ID, name: "Demo School" }]): SkCapabilityDeps => ({ session: fakeSession({ schools }) as never, now: NOW });
const run = (args: Record<string, unknown>, ctx = principal(), d = deps()) => resolveNoticeSchool(ctx, args, d);

describe("standing", () => {
  it("principal and coordinator (leader hats) may; a teacher without scope, a parent, a student, the teacher hat may not", () => {
    expect(noticeStanding(principal())).toBe(true);
    expect(noticeStanding(coordinator())).toBe(true);
    expect(noticeStanding(makeCtx({ role: "school_admin", hat: null }))).toBe(true);
    expect(noticeStanding(makeCtx())).toBe(false); // teacher, no scope
    expect(noticeStanding(makeCtx({ role: "teacher", hat: "teacher", scope: [{ grade: "5", subject: null }] }))).toBe(false);
    expect(noticeStanding(makeCtx({ role: "parent", hat: "parent" }))).toBe(false);
    expect(noticeStanding(makeCtx({ role: "student", hat: null }))).toBe(false);
    expect(noticeStanding(makeCtx({ role: "school_admin", hat: "principal", schoolId: null }))).toBe(false);
  });
  it("the registry shows it to the principal and the coordinator hat only", () => {
    const names = (c: ReturnType<typeof makeCtx>) => allowedFor(c).map((x) => x.meta.name);
    expect(names(principal())).toContain("notice.school");
    expect(names(coordinator())).toContain("notice.school");
    expect(names(makeCtx())).not.toContain("notice.school");
    expect(names(makeCtx({ role: "parent", hat: "parent" }))).not.toContain("notice.school");
    expect(names(makeCtx({ role: "school_admin", hat: "principal", flags: { calendar: false } }))).not.toContain("notice.school");
    expect(noticeSchoolAction.meta).toMatchObject({ tier: "confirm", kind: "act", roles: ["school_admin", "coordinator"], hats: ["principal", "coordinator"] });
  });
  it("refuses a teacher without scope before reading anything", async () => {
    const session = fakeSession({ schools: [{ id: SCHOOL_ID, name: "Demo School" }] });
    const r = await resolveNoticeSchool(makeCtx(), { body: "No school on Friday." }, { session: session as never, now: NOW });
    expect(r).toMatchObject({ ok: false, error: "not_permitted", summary: "Only the principal and coordinators post school notices." });
    expect(r.confirm).toBeUndefined();
    expect(session.log).toEqual([]);
  });
  it("refuses when FEATURE_NOTICES is off", async () => {
    process.env.FEATURE_NOTICES = "false";
    expect(await run({ body: "x" })).toMatchObject({ ok: false, error: "notices_off" });
  });
});

describe("the card", () => {
  it("school (default): title from the body, exact body, today, who sees it, click-only", async () => {
    const r = await run({ body: "No school on Friday. Classes resume on Monday." });
    expect(r.ok).toBe(true);
    expect(r.confirm).toEqual({
      action: "notice.school",
      title: "Post a notice to the whole school",
      params: {
        audience: "school",
        title: "No school on Friday",
        body: "No school on Friday. Classes resume on Monday.",
        starts_at: "2026-10-28",
        school_label: "Demo School",
        seen_by: "Every parent, student and teacher at Demo School",
        click_only: true,
      },
    });
  });
  it("staff when she says staff / teachers / guru; school when parents or everyone are named too", async () => {
    for (const a of ["staff", "all staff", "the teachers", "semua guru", "المعلمين"]) {
      const r = await run({ body: "Staff meeting at 2pm.", audience: a });
      expect(r.confirm?.params.audience, a).toBe("staff");
      expect(r.confirm?.title).toBe("Post a notice to all staff");
      expect(r.confirm?.params.seen_by).toBe("All staff at Demo School");
    }
    expect(noticeAudience("teachers and parents")).toBe("school");
    expect(noticeAudience("everyone")).toBe("school");
    expect(noticeAudience(undefined)).toBe("school");
    expect(noticeAudience("school")).toBe("school");
  });
  it("keeps her title; derives a short one from a long first line", async () => {
    expect((await run({ body: "Sports day is moved.", title: "Sports day" })).confirm?.params.title).toBe("Sports day");
    const long = "The annual sports day that was planned for next week has been moved because of the expected heavy rain";
    const t = deriveNoticeTitle(long);
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith("…")).toBe(true);
    expect(long.startsWith(t.slice(0, -1))).toBe(true);
    expect(deriveNoticeTitle("Line one\nLine two")).toBe("Line one");
  });
  it("tidies spacing only — no words change", () => {
    expect(tidyNoticeText("  No   school\r\n\r\n\r\n on  Friday.  ")).toBe("No school\n\non Friday.");
  });
  it("dates: tomorrow, a weekday, an ISO day; a past day and an unknown word are refused", async () => {
    expect((await run({ body: "x y", startsAt: "tomorrow" })).confirm?.params.starts_at).toBe("2026-10-29");
    expect((await run({ body: "x y", startsAt: "esok" })).confirm?.params.starts_at).toBe("2026-10-29");
    expect((await run({ body: "x y", startsAt: "Friday" })).confirm?.params.starts_at).toBe("2026-10-30");
    expect((await run({ body: "x y", startsAt: "2026-11-03" })).confirm?.params.starts_at).toBe("2026-11-03");
    expect(await run({ body: "x y", startsAt: "2026-10-27" })).toMatchObject({ ok: false, error: "dates_passed" });
    expect(await run({ body: "x y", startsAt: "someday" })).toMatchObject({ ok: false, error: "date_unparsed" });
  });
  it("no body asks; a body over 4000 characters is refused", async () => {
    expect(await run({})).toMatchObject({ ok: false, summary: "What should the notice say?" });
    expect(await run({ body: "a".repeat(4001) })).toMatchObject({ ok: false, error: "body_too_long" });
  });
  it("the school name falls back when it can't be read; lines follow the locale", async () => {
    expect((await run({ body: "x y" }, principal(), deps([]))).confirm?.params.seen_by).toBe("Every parent, student and teacher at your school");
    const ms = await run({ body: "Tiada sekolah pada hari Jumaat.", audience: "guru" }, principal({ locale: "ms" }));
    expect(ms.confirm?.title).toBe("Hantar notis kepada semua staf");
    expect(ms.confirm?.params.seen_by).toBe("Semua staf di Demo School");
  });
  it("a coordinator gets the same card", async () => {
    expect((await run({ body: "x y" }, coordinator())).confirm?.action).toBe("notice.school");
  });
});

describe("phrasings → act notice.school (EN / MS / AR), ahead of the diary", () => {
  const route = (text: string) => routeByRules(text, principal(), NOW);
  it.each([
    "post a notice to the whole school: no school on Friday",
    "Post a notice to the whole school: sports day is on Saturday",
    "tell all staff the meeting moved to 3pm",
    "tell the whole school that exams start Monday",
    "send a school notice: the canteen is closed tomorrow",
    "please send an announcement to all parents about the trip",
    "hantar notis kepada semua guru: mesyuarat jam 2",
    "hantar notis kepada semua ibu bapa tentang lawatan",
    "maklumkan kepada semua guru bahawa mesyuarat ditunda",
    "أرسل إشعارًا للمدرسة: لا دراسة يوم الجمعة",
    "انشر إعلانا لجميع المعلمين",
    "أخبر جميع المعلمين أن الاجتماع تأجل",
  ])("%s", (text) => {
    expect(route(text)).toEqual({ intent: "act", action: "notice.school" });
  });
  it("a class notice stays the diary's; a question is never an action", () => {
    expect(route("post a notice to 7B: no school on Friday")).toEqual({ intent: "act", action: "diary.note" });
    expect(route("hantar notis kepada 7B: tiada kelas")).toEqual({ intent: "act", action: "diary.note" });
    expect(route("tell 7B to bring their atlas")).toEqual({ intent: "act", action: "diary.note" });
    expect(route("remind the parents about the worksheet")).toEqual({ intent: "act", action: "parents.remind" });
    expect(actPhraseOf("post a notice to the whole school", "post a notice to the whole school?")).toBeNull();
  });
});
