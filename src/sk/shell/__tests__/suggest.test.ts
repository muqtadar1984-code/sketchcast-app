/**
 * SK S6 slice C — the greeting's ONE suggestion (suggest.ts): one per visit,
 * priority order, the preference off → none, kit notices present → none, no
 * school-wide read for leaders, never repeated, the time box, errors skipped,
 * the "tomorrow" filter in Kuala Lumpur time, and the lines ⇄ dictionary.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/suggest.test.ts
 */
import { describe, expect, it, vi } from "vitest";
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
import { filterByDue, type ShareStatus } from "@/utils/assignment-status";
import type { WorkflowFact } from "@/sk/facts";
import type { ChildWorkItem } from "@/utils/child-work";
import type { SkCapabilityDeps, SkCapabilityResult, SkContext } from "../types";
import { SUGGEST_LINE_TABLES } from "../suggest-lines";
import { DEFAULT_READS, dueTomorrowKl, greetingSuggestion, klDate, suggestionId, workflowSuggestion, type SuggestReads } from "../suggest";
import { makeCtx, NOW, TEACHER_ID } from "./fixtures";

type Shell = { sk: { shell: { suggest: Record<string, string> } } };
const FILES: Record<string, Shell> = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, Shell>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const CLASS_5B = "c5b00000-0000-4000-8000-000000000001";
const SHARE_1 = "5a000000-0000-4000-8000-000000000001";
const SHARE_2 = "5a000000-0000-4000-8000-000000000002";
const SUB_1 = "50b00000-0000-4000-8000-000000000001";
const SUB_2 = "50b00000-0000-4000-8000-000000000002";
const CHILD_ID = "c4000000-0000-4000-8000-000000000001";

// NOW = 2026-10-28T08:30Z = 16:30 Wednesday in Kuala Lumpur.
const deps = (over: Partial<SkCapabilityDeps> = {}): SkCapabilityDeps => ({ session: { from: () => ({}) } as never, now: NOW, clock: { day: 3, minutes: 16 * 60 + 30, iso: NOW.toISOString() }, ...over });

const nowNextResult = (startsAt: string, state = "next"): SkCapabilityResult => ({
  ok: true,
  summary: "…",
  facts: [{ row: "now", state, confidence: "slot", classId: CLASS_5B, className: "5B", subject: "Science", period: 3, periodLabel: "Period 3", startsAt, endsAt: "17:20" }],
});
const dueResult = (rows: Array<{ shareId: string; title: string; className: string; notDone: number }>): SkCapabilityResult => ({ ok: true, summary: "…", facts: rows });

const TOOL_OF: Record<keyof SuggestReads, string> = { nowNext: "timetable.now_next", markingQueue: "marking.next", dueTomorrow: "assignments.status", tutorWhere: "tutor.where", work: "work" };

/** Fake reads (empty by default) that record which tool each read stands for. */
function reads(over: Partial<SuggestReads> = {}) {
  const calls: string[] = [];
  const base: SuggestReads = {
    nowNext: async () => ({ ok: true, summary: "", facts: [] }),
    markingQueue: async () => [],
    dueTomorrow: async () => ({ ok: true, summary: "", facts: [] }),
    tutorWhere: async () => ({ ok: true, summary: "", facts: [] }),
    work: async () => new Map(),
  };
  const all = { ...base, ...over } as Record<keyof SuggestReads, (...a: unknown[]) => unknown>;
  const wrapped = Object.fromEntries(
    (Object.keys(all) as Array<keyof SuggestReads>).map((k) => [
      k,
      (...a: unknown[]) => {
        calls.push(TOOL_OF[k]);
        return all[k](...a);
      },
    ]),
  ) as unknown as SuggestReads;
  return { reads: wrapped, calls };
}

const run = (ctx: SkContext, r: SuggestReads, o: Partial<Parameters<typeof greetingSuggestion>[0]> = {}) =>
  greetingSuggestion({ ctx, deps: deps(), announced: [], enabled: true, filled: false, reads: r, log: () => undefined, ...o });

describe("suggest-lines.ts ⇄ messages/*.json (sk.shell.suggest)", () => {
  it("every table has every locale, equal to the dictionary, placeholders as in English", () => {
    const locales = LOCALES.map((l) => l.value).sort();
    for (const [key, table] of Object.entries(SUGGEST_LINE_TABLES)) {
      expect(Object.keys(table).sort(), key).toEqual(locales);
      for (const loc of locales) {
        expect(table[loc], `${key}/${loc}`).toBe(FILES[loc].sk.shell.suggest[key]);
        expect(placeholders(table[loc]), `${key}/${loc}`).toEqual(placeholders(table.en));
      }
    }
    expect(Object.keys(FILES.en.sk.shell.suggest).sort()).toEqual(Object.keys(SUGGEST_LINE_TABLES).sort());
  });
});

describe("teacher: priority order, one line", () => {
  it("a period starting within 15 min wins — and no later candidate is even read", async () => {
    const { reads: r, calls } = reads({ nowNext: async () => nowNextResult("16:40"), markingQueue: async () => [{ id: SUB_1 }] });
    const s = await run(makeCtx(), r);
    expect(s?.line).toBe("Period 3 starts in 10 min — 5B Science. Open the Board?");
    expect(s?.offer).toEqual({ target: "board", classId: CLASS_5B, label: "5B Science" });
    expect(s?.source).toBe("timetable.now_next");
    expect(calls).toEqual(["timetable.now_next"]);
  });

  it("a period more than 15 min away (or already started) is no suggestion → marking", async () => {
    for (const startsAt of ["16:50", "16:30", "16:00"]) {
      const { reads: r } = reads({ nowNext: async () => nowNextResult(startsAt), markingQueue: async () => [{ id: SUB_1 }, { id: SUB_2 }, { id: "x" }, { id: "y" }] });
      const s = await run(makeCtx(), r);
      expect(s?.line, startsAt).toBe("4 submissions to mark — want the first?");
      expect(s?.offer).toEqual({ target: "read", capability: "marking.next", args: {}, label: "marking" });
    }
  });

  it("one submission reads in the singular", async () => {
    const { reads: r } = reads({ markingQueue: async () => [{ id: SUB_1 }] });
    expect((await run(makeCtx(), r))?.line).toBe("1 submission to mark — want to see it?");
  });

  it("then work due tomorrow (one, and several)", async () => {
    const one = reads({ dueTomorrow: async () => dueResult([{ shareId: SHARE_1, title: "Cells worksheet", className: "5B", notDone: 7 }]) });
    const s1 = await run(makeCtx(), one.reads);
    expect(s1?.line).toBe("Cells worksheet is due tomorrow for 5B — 7 not done yet. Want the list?");
    expect(s1?.offer).toEqual({ target: "read", capability: "assignments.status", args: { due: "tomorrow" }, label: "due tomorrow" });
    expect(one.calls).toEqual(["timetable.now_next", "marking.next", "assignments.status"]);
    const many = reads({
      dueTomorrow: async () =>
        dueResult([
          { shareId: SHARE_1, title: "A", className: "5B", notDone: 1 },
          { shareId: SHARE_2, title: "B", className: "5C", notDone: 2 },
        ]),
    });
    expect((await run(makeCtx(), many.reads))?.line).toBe("2 pieces of work are due tomorrow in your classes — want the list?");
  });

  it("the line is localised (ms)", async () => {
    const { reads: r } = reads({ nowNext: async () => nowNextResult("16:40") });
    expect((await run(makeCtx({ locale: "ms" }), r))?.line).toBe("Period 3 bermula dalam 10 minit — 5B Science. Buka Papan Kelas?");
  });

  it("nothing to say → null", async () => {
    const { reads: r, calls } = reads();
    expect(await run(makeCtx(), r)).toBeNull();
    expect(calls).toEqual(["timetable.now_next", "marking.next", "assignments.status"]);
  });
});

describe("the gates", () => {
  it("the suggestions preference OFF → none, and no read at all", async () => {
    const { reads: r, calls } = reads({ markingQueue: async () => [{ id: SUB_1 }] });
    expect(await run(makeCtx(), r, { enabled: false })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("kit notices already in the greeting → none, and no read at all", async () => {
    const { reads: r, calls } = reads({ markingQueue: async () => [{ id: SUB_1 }] });
    expect(await run(makeCtx(), r, { filled: true, workflow: [kitFact()] })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("never repeated: an announced item is skipped and the next candidate speaks", async () => {
    const { reads: r } = reads({ nowNext: async () => nowNextResult("16:40"), markingQueue: async () => [{ id: SUB_1 }] });
    const first = await run(makeCtx(), r);
    const second = await run(makeCtx(), r, { announced: [first!.id] });
    expect(second?.source).toBe("marking.next");
    const third = await run(makeCtx(), r, { announced: [first!.id, second!.id] });
    expect(third).toBeNull();
  });

  it("the same marking head is the same id; a new head is a new suggestion", () => {
    expect(suggestionId("mk", SUB_1)).toBe(suggestionId("mk", SUB_1));
    expect(suggestionId("mk", SUB_1)).not.toBe(suggestionId("mk", SUB_2));
    expect(suggestionId("mk", SUB_1)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("a read that throws is skipped silently; the next candidate still speaks", async () => {
    const log = vi.fn();
    const { reads: r } = reads({
      nowNext: async () => {
        throw new Error("boom");
      },
      markingQueue: async () => [{ id: SUB_1 }],
    });
    const s = await greetingSuggestion({ ctx: makeCtx(), deps: deps(), announced: [], enabled: true, filled: false, reads: r, log });
    expect(s?.source).toBe("marking.next");
    expect(log).toHaveBeenCalledWith("sk-shell.greeting suggestion skipped: error", expect.stringContaining("boom"));
  });

  it("time-boxed: ALL candidates together stay inside the box, then nothing", async () => {
    const slow = () => new Promise<never>(() => undefined);
    const { reads: r } = reads({ nowNext: slow, markingQueue: async () => [{ id: SUB_1 }] });
    const t0 = Date.now();
    const s = await run(makeCtx(), r, { timeoutMs: 60 });
    expect(s).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("leaders with a leader hat: NO read is made (no school-wide or metered read)", async () => {
    for (const ctx of [makeCtx({ role: "school_admin", hat: "principal" }), makeCtx({ role: "teacher", hat: "coordinator", scope: [{ grade: "5", subject: null }] })]) {
      const { reads: r, calls } = reads({ markingQueue: async () => [{ id: SUB_1 }] });
      expect(await run(ctx, r, { workflow: [kitFact()] })).toBeNull();
      expect(calls).toEqual([]);
    }
  });

  it("a principal wearing the teacher hat gets their own teacher suggestion (own-class mode, registry-allowed tools only)", async () => {
    const { reads: r, calls } = reads({ nowNext: async () => nowNextResult("16:40"), markingQueue: async () => [{ id: SUB_1 }] });
    expect((await run(makeCtx({ role: "school_admin", hat: "teacher" }), r))?.source).toBe("timetable.now_next");
    expect(calls).toEqual(["timetable.now_next"]);
    // marking.next is a teacher-role tool: a school_admin's queue is never read.
    const q = reads({ markingQueue: async () => [{ id: SUB_1 }] });
    await run(makeCtx({ role: "school_admin", hat: "teacher" }), q.reads);
    expect(q.calls).not.toContain("marking.next");
  });

  it("the default reads are the tools' own code, and none is a school.* read", () => {
    expect(Object.keys(DEFAULT_READS).sort()).toEqual(["dueTomorrow", "markingQueue", "nowNext", "tutorWhere", "work"]);
  });
});

describe("student and parent", () => {
  const work = (o: Partial<ChildWorkItem>): ChildWorkItem => ({
    genId: "g1",
    kind: "worksheet",
    title: "Cells worksheet",
    direct: false,
    classId: CLASS_5B,
    sharedBy: null,
    due: null,
    overdue: false,
    status: "not started",
    awaitingMarking: false,
    score: null,
    feedback: null,
    doneAt: null,
    submittedAt: null,
    ...o,
  });
  // Tomorrow in KL (Thursday 29 Oct), 23:00 KL = 15:00Z.
  const TOMORROW_KL = "2026-10-29T15:00:00Z";

  it("a student: her own work due tomorrow, no offer", async () => {
    const ctx = makeCtx({ role: "student", hat: null, userId: CHILD_ID });
    const { reads: r } = reads({ work: async () => new Map([[CHILD_ID, [work({ due: TOMORROW_KL })]]]) });
    const s = await run(ctx, r);
    expect(s?.line).toBe("Reminder: Cells worksheet is due tomorrow.");
    expect(s?.offer).toBeNull();
  });

  it("a student: done work, or work due the day after, is no suggestion", async () => {
    const ctx = makeCtx({ role: "student", hat: null, userId: CHILD_ID });
    const { reads: r } = reads({ work: async () => new Map([[CHILD_ID, [work({ due: TOMORROW_KL, status: "completed" }), work({ genId: "g2", due: "2026-10-30T15:00:00Z" })]]]) });
    expect(await run(ctx, r)).toBeNull();
  });

  it("a student: the tutor's 'Carry on?' already filled the greeting → none", async () => {
    const ctx = makeCtx({ role: "student", hat: null, userId: CHILD_ID });
    const { reads: r, calls } = reads({ work: async () => new Map([[CHILD_ID, [work({ due: TOMORROW_KL })]]]) });
    expect(await run(ctx, r, { filled: true })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a parent: a verified child's overdue work first, with the child.status offer", async () => {
    const ctx: SkContext = { ...makeCtx({ role: "parent", hat: "parent", schoolId: null }), children: [{ id: CHILD_ID, firstName: "Adam", name: "Adam Lee", source: "self", verified: true, schoolId: null }] };
    const { reads: r } = reads({ work: async () => new Map([[CHILD_ID, [work({ genId: "g9", due: TOMORROW_KL }), work({ overdue: true, title: "Plant cells quiz" })]]]) });
    const s = await run(ctx, r);
    expect(s?.line).toBe("Adam has 1 overdue — Plant cells quiz. Want the details?");
    expect(s?.offer).toEqual({ target: "read", capability: "child.status", args: { child: CHILD_ID }, label: "Adam" });
    // Announced → the due-tomorrow item comes up next time.
    const next = await run(ctx, r, { announced: [s!.id] });
    expect(next?.line).toBe("Adam has Cells worksheet due tomorrow. Want the details?");
  });

  it("a parent's UNVERIFIED child is never read", async () => {
    const ctx: SkContext = { ...makeCtx({ role: "parent", hat: "parent", schoolId: null }), children: [{ id: CHILD_ID, firstName: "Adam", name: "Adam", source: "self", verified: false, schoolId: null }] };
    const { reads: r, calls } = reads({ work: async () => new Map([[CHILD_ID, [work({ overdue: true })]]]) });
    expect(await run(ctx, r)).toBeNull();
    expect(calls).toEqual([]);
  });
});

function kitFact(o: Partial<WorkflowFact> = {}): WorkflowFact {
  return {
    kind: "recent_kit",
    key: "kit:gen-1",
    value: { label: "Plant and Animal Cells", classId: CLASS_5B, classLabel: "5B", generationId: "gen-1" },
    updatedAt: "2026-10-27T03:00:00Z",
    expiresAt: "2027-10-27T03:00:00Z",
    ...o,
  };
}

describe("workflow memory: 'Last time …' only when nothing else spoke", () => {
  it("no tool line → 'Last time: 5B, Plant and Animal Cells — carry on?' with a Board offer", async () => {
    const { reads: r } = reads();
    const s = await run(makeCtx(), r, { workflow: [kitFact()] });
    expect(s?.line).toBe("Last time: 5B, Plant and Animal Cells — carry on?");
    expect(s?.offer).toEqual({ target: "board", label: "Plant and Animal Cells", classId: CLASS_5B, generationId: "gen-1" });
    expect(s?.source).toBe("workflow.recent_kit");
  });

  it("a tool line wins over the workflow line (still ONE line)", async () => {
    const { reads: r } = reads({ markingQueue: async () => [{ id: SUB_1 }] });
    expect((await run(makeCtx(), r, { workflow: [kitFact()] }))?.source).toBe("marking.next");
  });

  it("announced → not repeated; the same kit used again later is a new line", () => {
    const ctx = makeCtx();
    const s = workflowSuggestion(ctx, [kitFact()], new Set());
    expect(workflowSuggestion(ctx, [kitFact()], new Set([s!.id]))).toBeNull();
    expect(workflowSuggestion(ctx, [kitFact({ updatedAt: "2026-10-28T03:00:00Z" })], new Set([s!.id]))).not.toBeNull();
  });

  it("a pending task comes first and is restored into the conversation", () => {
    const s = workflowSuggestion(makeCtx(), [kitFact(), { kind: "pending_task", key: "notice.post", value: { task: "notice.post", needs: ["body"] }, updatedAt: "2026-10-28T01:00:00Z", expiresAt: null }], new Set());
    expect(s?.source).toBe("workflow.pending_task");
    expect(s?.pending).toEqual({ task: "notice.post", needs: ["body"] });
    expect(s?.line).toBe("Last time something was left unfinished — want to carry on where you left off?");
  });

  it("a book-code pending task is never carried over", () => {
    expect(workflowSuggestion(makeCtx(), [{ kind: "pending_task", key: "book.activate", value: { task: "book.activate", needs: ["order"] }, updatedAt: null, expiresAt: null }], new Set())).toBeNull();
  });

  it("students and parents get no workflow line", () => {
    expect(workflowSuggestion(makeCtx({ role: "student", hat: null }), [kitFact()], new Set())).toBeNull();
    expect(workflowSuggestion(makeCtx({ role: "parent", hat: "parent" }), [kitFact()], new Set())).toBeNull();
  });
});

describe("'tomorrow' in Kuala Lumpur time", () => {
  const row = (dueAt: string): ShareStatus => ({ dueAt, notDone: 1 }) as unknown as ShareStatus;

  it("filterByDue(…, 'tomorrow') keeps only the next KL civil day", () => {
    const now = new Date("2026-10-28T15:30:00Z"); // 23:30 Wed in KL (already Thu in UTC+9)
    const kept = filterByDue([row("2026-10-28T15:45:00Z"), row("2026-10-29T03:00:00Z"), row("2026-10-29T16:30:00Z"), row("2026-10-28T10:00:00Z")], "tomorrow", now);
    // 23:45 Wed KL = today; 11:00 Thu KL = tomorrow; 00:30 Fri KL = day after; 18:00 Wed KL = today.
    expect(kept.map((r) => r.dueAt)).toEqual(["2026-10-29T03:00:00Z"]);
  });

  it("dueTomorrowKl agrees, across the UTC midnight", () => {
    const now = new Date("2026-10-28T17:00:00Z"); // 01:00 Thu in KL, still Wed in UTC
    expect(klDate(now.getTime())).toBe("2026-10-29");
    expect(dueTomorrowKl("2026-10-29T16:30:00Z", now)).toBe(true); // 00:30 Fri KL
    expect(dueTomorrowKl("2026-10-29T03:00:00Z", now)).toBe(false); // Thu KL = today
    expect(dueTomorrowKl(null, now)).toBe(false);
  });

  it("assignments.status accepts due='tomorrow' (additive enum)", async () => {
    const { assignmentsStatus } = await import("@/sk/capabilities/assignments");
    const due = (assignmentsStatus.meta.parameters.properties as Record<string, { enum?: string[] }>).due;
    expect(due.enum).toEqual(["overdue", "today", "week", "tomorrow"]);
  });
});

describe("the teacher id in fixtures is a teacher", () => {
  it("sanity", () => expect(makeCtx().user.id).toBe(TEACHER_ID));
});
