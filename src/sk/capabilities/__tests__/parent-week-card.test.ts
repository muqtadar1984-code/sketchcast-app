/**
 * S4 slice E — the "This week" card on /dashboard/children. Its data function
 * (parent-digest.ts weekCardsFor, and week-data.ts loadWeekCards on the page's
 * session) as a pure function on the two-family fixture — one child, two
 * children, an empty week — and the parity rule: SK's child.week answer and the
 * card give the SAME numbers and steps for the same rows. The fixture rows are
 * every family's (leaky), so each card's own cut to its child is under test.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/parent-week-card.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { weekBlock, weekCardsFor, type WeekCard } from "@/sk/parent-digest";
import { __setParentMasteryForTests, linkedChildMastery, type ChildMasteryRow } from "@/sk/parent-mastery";
import { childrenFromLinks } from "@/sk/shell/context";
import { lineFor } from "@/sk/shell/lines";
import { P_STEP_FINISH } from "@/sk/shell/parent-lines";
import { fakeSession } from "@/sk/shell/__tests__/fixtures";
import type { SkChild } from "@/sk/shell/types";
import type { ChildWorkRows } from "@/utils/child-work";
import { loadWeekCards } from "@/app/dashboard/children/week-data";
import { childWeek } from "../parent";
import { A1, A2, B1, LINKS, MASTERY, NOW, PA, PB, TABLES, X, leakySession, parentCtx } from "./parent-fixtures";

const reader = vi.fn(async (_admin: unknown, childId: string): Promise<ChildMasteryRow[]> => MASTERY[childId] ?? []);
beforeEach(() => {
  reader.mockClear();
  __setParentMasteryForTests({ admin: () => ({ from: () => ({}) }), reader });
});
afterEach(() => __setParentMasteryForTests(null));

/** The rows as the page reads them (RLS-scoped there; here every family's). */
const ROWS = TABLES as unknown as {
  enrollments: ChildWorkRows["enrollments"];
  generation_shares: ChildWorkRows["shares"];
  generations: ChildWorkRows["generations"];
  student_progress: ChildWorkRows["progress"];
  submissions: ChildWorkRows["submissions"];
  diary_notes: Array<Record<string, unknown>>;
};
const rows: ChildWorkRows = { enrollments: ROWS.enrollments, shares: ROWS.generation_shares, generations: ROWS.generations, progress: ROWS.student_progress, submissions: ROWS.submissions };
const now = NOW.getTime();

const cardsOf = (parent: string, locale = "en"): WeekCard[] =>
  weekCardsFor({ children: childrenFromLinks(parent, LINKS), rows, noteRows: ROWS.diary_notes, mastery: Object.fromEntries(Object.entries(MASTERY)), locale, now });

/** SK's child.week facts for the same parent, one per child. */
async function skWeek(parent: string, locale = "en") {
  const r = await childWeek.handler(parentCtx(parent, locale), {}, { session: leakySession(), now: NOW });
  return r.facts ?? [];
}
const asFacts = (c: WeekCard) => ({ child: c.name, doneThisWeek: c.done, overdue: c.overdue, awaitingMarking: c.awaiting, masteredThisWeek: c.mastered, newDiaryNotes: c.notes, nextSteps: c.steps.join("; ") || null });

describe("weekCardsFor — the card's data (pure)", () => {
  it("two children: one card each, each with ITS numbers and up to two steps", () => {
    expect(cardsOf(PA)).toEqual([
      { childId: A1, name: "Aisyah", done: 2, overdue: 0, awaiting: 1, mastered: 1, notes: 1, steps: ['revisit "Explain diffusion" in Cells', "finish Quiz — Plants before Fri 30 Oct"] },
      { childId: A2, name: "Adam", done: 0, overdue: 1, awaiting: 0, mastered: 0, notes: 1, steps: ["finish Worksheet — Cells"] },
    ]);
  });

  it("one child: one card — never another family's or a classmate's rows", () => {
    const cards = cardsOf(PB);
    expect(cards).toEqual([{ childId: B1, name: "Zara", done: 0, overdue: 0, awaiting: 0, mastered: 1, notes: 1, steps: [] }]);
    const text = JSON.stringify(cards);
    for (const stranger of ["Aisyah", "Adam", "Xavier", A1, A2, X]) expect(text).not.toContain(stranger);
  });

  it("an empty week: zeros and no steps (the card says 'Nothing urgent'), the same as SK's sentence", () => {
    const child: SkChild = { id: "e0000000-0000-4000-8000-0000000000e0", firstName: "Ema", name: "Ema Tan", source: "self", verified: true, schoolId: null };
    const empty: ChildWorkRows = { enrollments: [], shares: [], generations: [], progress: [], submissions: [] };
    const [card] = weekCardsFor({ children: [child], rows: empty, noteRows: [], mastery: {}, locale: "en", now });
    expect(card).toEqual({ childId: child.id, name: "Ema", done: 0, overdue: 0, awaiting: 0, mastered: 0, notes: 0, steps: [] });
    expect(weekBlock(child, { items: [], notes: [], mastery: null }, "en", now).summary).toBe(
      "Ema — this week: done 0, overdue 0, awaiting marking 0; ideas mastered 0; new diary notes 0. What to do about it: nothing urgent — keep going.",
    );
  });

  it("an unverified link gets no card", () => {
    const children = childrenFromLinks(PA, LINKS).map((c) => (c.id === A2 ? { ...c, verified: false } : c));
    expect(weekCardsFor({ children, rows, noteRows: ROWS.diary_notes, mastery: {}, locale: "en", now }).map((c) => c.childId)).toEqual([A1]);
  });

  it("the steps are in the parent's language", () => {
    expect(cardsOf(PA, "ms")[1].steps).toEqual([lineFor(P_STEP_FINISH, "ms", { title: "Worksheet — Cells" })]);
    expect(cardsOf(PA, "ms")[1].steps[0]).not.toBe("finish Worksheet — Cells");
  });
});

describe("parity: SK's child.week and the card give the same numbers", () => {
  it.each([
    ["two children (parent A)", PA],
    ["one child (parent B)", PB],
  ])("%s", async (_label, parent) => {
    expect((await skWeek(parent)).map((f) => ({ ...f }))).toEqual(cardsOf(parent).map(asFacts));
  });
  it("and in Malay", async () => {
    expect(await skWeek(PA, "ms")).toEqual(cardsOf(PA, "ms").map(asFacts));
  });
});

describe("loadWeekCards — the page's assembly on its session", () => {
  it("reads diary notes through the SESSION, mastery only behind the verified-link gate, and gives the same cards", async () => {
    const log: string[] = [];
    const session = fakeSession(TABLES, { log });
    const cards = await loadWeekCards(session as never, PA, LINKS, rows, "en", now);
    expect(Object.values(cards)).toEqual(cardsOf(PA));
    expect(log.filter((l) => l.startsWith("diary_notes.select"))).toHaveLength(2);
    // The admin reader ran for the parent's two verified children only.
    expect(reader.mock.calls.map((c) => c[1]).sort()).toEqual([A1, A2].sort());
  });
  it("another parent's link rows are dropped (childrenFromLinks) — no card, no mastery read for them", async () => {
    const cards = await loadWeekCards(fakeSession(TABLES) as never, PB, LINKS, rows, "en", now);
    expect(Object.keys(cards)).toEqual([B1]);
    expect(reader.mock.calls.map((c) => c[1])).toEqual([B1]);
  });
  it("no verified child → no reads at all", async () => {
    const log: string[] = [];
    const unverified = LINKS.map((l) => ({ ...l, verified_at: null }));
    expect(await loadWeekCards(fakeSession(TABLES, { log }) as never, PA, unverified, rows, "en", now)).toEqual({});
    expect(log).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("linkedChildMastery — the gate in front of the admin read", () => {
  it("an unlinked, unverified or forged child never reaches the admin reader", async () => {
    const children = childrenFromLinks(PA, LINKS);
    for (const id of [B1, X, "deadbeef-0000-4000-8000-000000000000", ""]) expect(await linkedChildMastery(children, id)).toBeNull();
    expect(await linkedChildMastery(children.map((c) => ({ ...c, verified: false })), A1)).toBeNull();
    expect(await linkedChildMastery(undefined, A1)).toBeNull();
    expect(reader).not.toHaveBeenCalled();
    expect(await linkedChildMastery(children, A1)).toEqual(MASTERY[A1]);
    expect(reader).toHaveBeenCalledTimes(1);
  });
});

describe("the card's markup", () => {
  it("never hides a control or a number behind hover; wraps to two columns on a phone", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/dashboard/children/week-card.tsx"), "utf8");
    expect(src).not.toMatch(/group-hover|opacity-0|hover:/);
    expect(src).toContain("grid-cols-2 sm:grid-cols-5");
    expect(src).not.toMatch(/^["']use client["']/m);
  });
});
