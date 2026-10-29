/**
 * SK S5 slice B — the 60/day cap + audit of a leader school read
 * (school-meter.ts), the analytics gate, and the lines' parity with the ten
 * dictionaries. The audit table is a filter-honouring fake (audit-log-fake.ts):
 * the cap IS a filter (actor, scope, UTC day, turn id).
 */
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/locales";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import te from "@/i18n/messages/te.json";
import mr from "@/i18n/messages/mr.json";
import hi from "@/i18n/messages/hi.json";
import msArab from "@/i18n/messages/ms-arab.json";
import {
  SCHOOL_BRIEFING_SCOPE,
  SCHOOL_READ_DAILY_CAP,
  SK_SCHOOL_SCOPE,
  meterSchoolRead,
  schoolReadGate,
  schoolReadOf,
  utcDayStart,
} from "../school-meter";
import { SCHOOL_METER_LINES } from "../school-meter-lines";
import { runCapability, type RunnerDeps } from "../runner";
import { allowedFor } from "../registry";
import { MemoryAuditSink } from "../audit";
import { fakeAuditLog, withAuditLog } from "./audit-log-fake";
import { FakeDb, NOW, PA, COORD, SCH_A, allRows, coordinatorCtx, ctxFor, principalCtx } from "@/sk/capabilities/__tests__/leader-fixtures";
import type { SkContext } from "../types";

const CAP_LINE = "You've reached today's 60 school questions — it resets at midnight UTC.";
const AUDIT_LINE = "I can't open school figures right now — try again in a moment.";
const OFF_LINE = "School analytics aren't switched on for your school.";

const today = () => new Date(utcDayStart(new Date()).getTime() + 1);
const turn = (i: number) => `turn-${String(i).padStart(4, "0")}`;
const read = { capability: "school.health", mode: "school" as const };
const teacherCtx = (o: { analytics?: boolean } = {}) => {
  const c = ctxFor({ id: "ta1", role: "teacher", hat: "teacher", schoolId: SCH_A });
  if (o.analytics === false) c.flags = { ...c.flags, analytics: false };
  return c;
};
const analyticsOff = (c: SkContext): SkContext => ({ ...c, flags: { ...c.flags, analytics: false } });

const runnerDeps = (session: unknown, ctx: SkContext, turnId = "turn-x"): RunnerDeps => ({
  session: session as never,
  now: NOW,
  clock: { day: 3, minutes: 8 * 60 + 40, iso: NOW.toISOString() },
  sink: new MemoryAuditSink(),
  sessionId: null,
  turnId,
  cache: new Map(),
  schoolRead: schoolReadGate(ctx, session as never, turnId),
});

describe("schoolReadOf — which reads are metered", () => {
  it("school.* under a leader hat (or hatless leader); the S0 reads only in school / scope mode", () => {
    expect(schoolReadOf(principalCtx(), "school.health")).toEqual({ capability: "school.health", mode: "school" });
    expect(schoolReadOf(principalCtx(), "learners.risk")).toEqual({ capability: "learners.risk", mode: "school" });
    expect(schoolReadOf(principalCtx(), "assignments.status", { grade: "5" })).toEqual({ capability: "assignments.status", mode: "school", grades: ["5"] });
    expect(schoolReadOf(coordinatorCtx(), "timetable.now_next")).toEqual({ capability: "timetable.now_next", mode: "scope", grades: ["5"] });
    // slice C's school.* capabilities are covered by name.
    expect(schoolReadOf(principalCtx(), "school.cost")).toMatchObject({ mode: "school" });
    // hatless principal: the leader-only capability is still a school read; an S0 read is own.
    expect(schoolReadOf(principalCtx(PA, SCH_A, null), "school.health")).toMatchObject({ mode: "school" });
    expect(schoolReadOf(principalCtx(PA, SCH_A, null), "learners.risk")).toBeNull();
  });
  it("own-class teacher reads, the teacher hat of a leader, and everything else are NOT metered", () => {
    expect(schoolReadOf(teacherCtx(), "learners.risk")).toBeNull();
    expect(schoolReadOf(teacherCtx(), "assignments.status")).toBeNull();
    expect(schoolReadOf(principalCtx(PA, SCH_A, "teacher"), "learners.risk")).toBeNull();
    expect(schoolReadOf(coordinatorCtx("teacher"), "learners.risk")).toBeNull();
    expect(schoolReadOf(principalCtx(), "library.find")).toBeNull();
    expect(schoolReadOf(principalCtx(), "notice.school")).toBeNull();
  });
});

describe("meterSchoolRead — insert first, then count (shared 60/day)", () => {
  it("59 → 60 → 61: the 60th is allowed, the 61st refused — and its row stays as the audit", async () => {
    const aal = fakeAuditLog({ user: PA });
    aal.seed(58, { actor: PA, scope: SK_SCHOOL_SCOPE, at: today() });
    const s = aal as never;
    expect(await meterSchoolRead(principalCtx(), s, { ...read, turnId: turn(59) })).toEqual({ ok: true, count: 59, inserted: true });
    expect(await meterSchoolRead(principalCtx(), s, { ...read, turnId: turn(60) })).toEqual({ ok: true, count: 60, inserted: true });
    const r61 = await meterSchoolRead(principalCtx(), s, { ...read, turnId: turn(61) });
    expect(r61).toEqual({ ok: false, reason: "cap", count: 61, inserted: true, summary: CAP_LINE });
    expect(aal.rows.length).toBe(61);
    expect(SCHOOL_READ_DAILY_CAP).toBe(60);
  });
  it("the School Briefing panel's rows count toward the same 60", async () => {
    const aal = fakeAuditLog({ user: PA });
    aal.seed(40, { actor: PA, scope: SCHOOL_BRIEFING_SCOPE, at: today() });
    aal.seed(19, { actor: PA, scope: SK_SCHOOL_SCOPE, at: new Date(today().getTime() + 100) });
    expect(await meterSchoolRead(principalCtx(), aal as never, { ...read, turnId: turn(1) })).toMatchObject({ ok: true, count: 60 });
    expect(await meterSchoolRead(principalCtx(), aal as never, { ...read, turnId: turn(2) })).toMatchObject({ ok: false, reason: "cap", count: 61 });
  });
  it("yesterday's rows, another actor's rows and other scopes do not count", async () => {
    const aal = fakeAuditLog({ user: PA });
    aal.seed(100, { actor: PA, scope: SK_SCHOOL_SCOPE, at: new Date(utcDayStart(new Date()).getTime() - 3_600_000) });
    aal.seed(100, { actor: "someone-else", scope: SK_SCHOOL_SCOPE, at: today() });
    aal.seed(100, { actor: PA, scope: "at_risk", at: today() });
    expect(await meterSchoolRead(principalCtx(), aal as never, { ...read, turnId: turn(1) })).toEqual({ ok: true, count: 1, inserted: true });
  });
  it("the row: actor, role, school, scope sk_school, target_kind sk_capability, detail {capability, mode, grades?, turnId} — no names", async () => {
    const aal = fakeAuditLog({ user: COORD });
    await meterSchoolRead(coordinatorCtx(), aal as never, { capability: "learners.risk", mode: "scope", grades: ["5"], turnId: "t-1" });
    expect(aal.inserted).toHaveLength(1);
    const row = aal.inserted[0];
    expect(row).toMatchObject({ actor_id: COORD, actor_role: "teacher", school_id: SCH_A, scope: "sk_school", target_kind: "sk_capability", target_id: null });
    expect(row.detail).toEqual({ capability: "learners.risk", mode: "scope", grades: ["5"], turnId: "t-1" });
  });
  it("FAIL CLOSED: a failed insert, count or replay lookup refuses the read", async () => {
    for (const fail of [{ failInsert: true }, { failCount: true }, { failLookup: true }]) {
      const aal = fakeAuditLog({ user: PA, ...fail });
      const r = await meterSchoolRead(principalCtx(), aal as never, { ...read, turnId: turn(1) });
      expect(r, JSON.stringify(fail)).toMatchObject({ ok: false, reason: "audit_failed", summary: AUDIT_LINE });
    }
    // An insert as someone else is refused by aal_insert_self (42501) → refused.
    const other = fakeAuditLog({ user: "someone-else" });
    expect(await meterSchoolRead(principalCtx(), other as never, { ...read, turnId: turn(1) })).toMatchObject({ ok: false, reason: "audit_failed" });
    expect(other.rows).toHaveLength(0);
    // No turn id: nothing to key the row on → refused.
    expect(await meterSchoolRead(principalCtx(), fakeAuditLog({ user: PA }) as never, { ...read, turnId: "" })).toMatchObject({ ok: false, reason: "audit_failed" });
  });
  it("a replayed turn id writes no second row and keeps its verdict", async () => {
    const aal = fakeAuditLog({ user: PA });
    expect(await meterSchoolRead(principalCtx(), aal as never, { ...read, turnId: "same" })).toEqual({ ok: true, count: 1, inserted: true });
    expect(await meterSchoolRead(principalCtx(), aal as never, { ...read, turnId: "same" })).toEqual({ ok: true, count: 1, inserted: false });
    expect(aal.rows).toHaveLength(1);
    // A refused attempt replayed later is still refused (its rank is fixed), with no new row.
    const full = fakeAuditLog({ user: PA });
    full.seed(60, { actor: PA, scope: SK_SCHOOL_SCOPE, at: today() });
    expect(await meterSchoolRead(principalCtx(), full as never, { ...read, turnId: "late" })).toMatchObject({ ok: false, reason: "cap", count: 61, inserted: true });
    expect(await meterSchoolRead(principalCtx(), full as never, { ...read, turnId: "late" })).toMatchObject({ ok: false, reason: "cap", count: 61, inserted: false });
    expect(full.rows).toHaveLength(61);
  });
});

describe("schoolReadGate through runCapability — once per turn, before the read", () => {
  const db = () => new FakeDb(allRows());
  it("two leader reads in one turn write ONE row", async () => {
    const aal = fakeAuditLog({ user: PA });
    const session = withAuditLog(db(), aal);
    const ctx = principalCtx();
    const deps = runnerDeps(session, ctx);
    const a = await runCapability(ctx, "school.health", {}, deps);
    const b = await runCapability(ctx, "learners.risk", {}, deps);
    expect(a.ok && b.ok).toBe(true);
    expect(aal.inserted).toHaveLength(1);
    expect(aal.inserted[0].detail).toMatchObject({ capability: "school.health", mode: "school", turnId: "turn-x" });
  });
  it("the read does not run when the meter refuses (no school rows touched)", async () => {
    const aal = fakeAuditLog({ user: PA, failInsert: true });
    const inner = db();
    const ctx = principalCtx();
    const r = await runCapability(ctx, "school.health", {}, runnerDeps(withAuditLog(inner, aal), ctx));
    expect(r).toMatchObject({ ok: false, error: "school_audit_failed", summary: AUDIT_LINE });
    expect(inner.log).toEqual([]);
    const capped = fakeAuditLog({ user: PA });
    capped.seed(60, { actor: PA, scope: SCHOOL_BRIEFING_SCOPE, at: today() });
    const inner2 = db();
    const r2 = await runCapability(ctx, "learners.risk", {}, runnerDeps(withAuditLog(inner2, capped), ctx));
    expect(r2).toMatchObject({ ok: false, error: "school_cap", summary: CAP_LINE });
    expect(inner2.log).toEqual([]);
  });
  it("own-class teacher reads are not metered (no row, normal answer)", async () => {
    const aal = fakeAuditLog({ user: "ta1" });
    for (const ctx of [teacherCtx(), coordinatorCtx("teacher"), principalCtx(PA, SCH_A, "teacher")]) {
      const r = await runCapability(ctx, "learners.risk", {}, runnerDeps(withAuditLog(db(), aal), ctx));
      expect(r.error).toBeUndefined();
    }
    expect(aal.rows).toHaveLength(0);
  });
});

describe("the analytics gate, per role", () => {
  const db = () => new FakeDb(allRows());
  it("school.health is offered only with school analytics on (principal and coordinator)", () => {
    const names = (c: SkContext) => allowedFor(c).map((x) => x.meta.name);
    expect(names(principalCtx())).toContain("school.health");
    expect(names(coordinatorCtx())).toContain("school.health");
    expect(names(analyticsOff(principalCtx()))).not.toContain("school.health");
    expect(names(analyticsOff(coordinatorCtx()))).not.toContain("school.health");
  });
  it("principal / coordinator leader modes with analytics off → the fixed line, nothing metered, nothing read", async () => {
    for (const [ctx, user] of [
      [analyticsOff(principalCtx()), PA],
      [analyticsOff(coordinatorCtx()), COORD],
    ] as const) {
      for (const name of ["learners.risk", "assignments.status", "timetable.now_next"]) {
        const aal = fakeAuditLog({ user });
        const inner = db();
        const r = await runCapability(ctx, name, {}, runnerDeps(withAuditLog(inner, aal), ctx));
        expect(r, `${user} ${name}`).toMatchObject({ ok: false, error: "analytics_off", summary: OFF_LINE });
        expect(aal.rows).toHaveLength(0);
        expect(inner.log).toEqual([]);
        // The handler holds the same gate for a caller without the turn's gate.
        const direct = await runCapability(ctx, name, {}, { ...runnerDeps(inner, ctx), schoolRead: undefined });
        expect(direct).toMatchObject({ ok: false, error: "analytics_off", summary: OFF_LINE });
      }
    }
  });
  it("teacher own-class answers are unchanged with analytics off", async () => {
    const on = await runCapability(teacherCtx(), "learners.risk", {}, runnerDeps(db(), teacherCtx()));
    const off = await runCapability(teacherCtx({ analytics: false }), "learners.risk", {}, runnerDeps(db(), teacherCtx({ analytics: false })));
    expect(off.error).toBeUndefined();
    expect(off.summary).toBe(on.summary);
  });
});

type Shell = { sk: { shell: { schoolMeter: Record<string, string> } } };
const FILES: Record<string, Shell> = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, Shell>;

describe("school-meter-lines.ts ⇄ messages/*.json (sk.shell.schoolMeter.*)", () => {
  it("every key, every locale, equal; placeholders kept; Jawi is Jawi", () => {
    for (const { value } of LOCALES) {
      const dict = FILES[value].sk.shell.schoolMeter;
      expect(Object.keys(dict).sort(), value).toEqual(Object.keys(SCHOOL_METER_LINES).sort());
      for (const [key, line] of Object.entries(SCHOOL_METER_LINES)) {
        expect(line[value], `${value}.${key}`).toBe(dict[key]);
        expect((line[value].match(/\{\w+\}/g) ?? []).sort(), `${value}.${key}`).toEqual((line.en.match(/\{\w+\}/g) ?? []).sort());
      }
    }
    for (const line of Object.values(SCHOOL_METER_LINES)) {
      expect(Object.keys(line).sort()).toEqual(LOCALES.map((l) => l.value).sort());
      expect(line["ms-arab"]).toMatch(/[؀-ۿ]/);
    }
  });
});
