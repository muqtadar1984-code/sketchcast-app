/**
 * timetable.now_next — the Present resolver as a tool, over a fake session
 * client seeded with TWO teachers' slots; the collector's clock, the KL
 * fallback, now / next / none, last-taught, today's remaining periods.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/timetable.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkCapabilityDeps, SkContext } from "../../shell/types";
import { DEFAULT_SHAPE } from "@/utils/timetable";
import { clockAt, nowNext, timetableNowNext } from "../timetable";

type Row = Record<string, unknown>;

class FakeDb {
  constructor(
    public tables: Record<string, Row[]>,
    public errors: Record<string, string> = {},
    public throwing: Set<string> = new Set(),
  ) {}
  from(table: string) {
    if (this.throwing.has(table)) throw new Error(`boom ${table}`);
    return new Query(this, table);
  }
  rpc() {
    return Promise.resolve({ data: null, error: null });
  }
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private single = false;
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  select() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (v === null ? r[c] == null : r[c] === v));
    return this;
  }
  in(c: string, list: unknown[]) {
    this.filters.push((r) => list.includes(r[c]));
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: { message: string } | null }) => A) | null, no?: ((e: unknown) => B) | null) {
    const err = this.db.errors[this.table];
    const rows = (this.db.tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    const res = err ? { data: null, error: { message: err } } : { data: this.single ? (rows[0] ?? null) : rows, error: null };
    return Promise.resolve(res).then(ok, no);
  }
}

const T1 = "t1";
const T2 = "t2";
const S = "school-s";
// Tue 2026-10-27 08:40 KL = 00:40Z
const NOW = new Date("2026-10-27T00:40:00Z");
const at = (h: number, m: number) => h * 60 + m;

const ctx = (id = T1, schoolId: string | null = S): SkContext => ({
  user: { id, email: null, role: "teacher", hat: "teacher", schoolId, coordinatorScope: [], plan: "school", locale: "en", staff: false },
  place: { path: "/present", page: "board", params: {} },
  selection: {},
  recent: { entities: [], lastToolResults: [] },
  flags: {},
  issuedAt: NOW.toISOString(),
  ttlSeconds: 60,
  contextHash: "h",
});
const deps = (db: FakeDb, clock?: SkCapabilityDeps["clock"]): SkCapabilityDeps => ({ session: db, now: NOW, clock });

function seed(over: Partial<Record<string, Row[]>> = {}) {
  return new FakeDb({
    // Custom shape: 4 periods, 45 min, P3 after a break.
    schools: [{ id: S, config: { timetable: { days: 5, periodMinutes: 45, periods: [{ label: "P1", time: "07:45" }, { label: "P2", time: "08:30" }, { label: "P3", time: "10:40" }, { label: "P4", time: "11:25" }] } } }],
    timetable_slots: [
      { school_id: S, class_id: "7b", day: 2, period: 2, subject: "Science", teacher_id: T1, room: "Lab 1", kind: "lesson" },
      { school_id: S, class_id: "7c", day: 2, period: 3, subject: "Science", teacher_id: T1, room: null, kind: "lesson" },
      { school_id: S, class_id: "7b", day: 2, period: 4, subject: "Maths", teacher_id: T1, room: null, kind: null },
      { school_id: S, class_id: "7c", day: 2, period: 1, subject: "Assembly", teacher_id: T1, room: null, kind: "nonteaching" },
      { school_id: S, class_id: "7b", day: 3, period: 1, subject: "Science", teacher_id: T1, room: null, kind: "lesson" },
      // t2's slot in the same cell as t1's P2 — the whole school can read it.
      { school_id: S, class_id: "8a", day: 2, period: 2, subject: "History", teacher_id: T2, room: null, kind: "lesson" },
    ],
    present_last_taught: [
      { teacher_id: T1, class_id: "7b", subject: "Science", book_id: "b1", chapter_num: 3, part: 2 },
      { teacher_id: T2, class_id: "8a", subject: "History", book_id: "b9", chapter_num: 1, part: 1 },
    ],
    classes: [
      { id: "7b", name: "7B", teacher_id: T1 },
      { id: "7c", name: "7C", teacher_id: T1 },
      { id: "8a", name: "8A", teacher_id: T2 },
    ],
    books: [
      { id: "b1", title: "Cambridge Biology", chapters: [{ num: 2, title: "Cells" }, { num: 3, title: "Specialised Cells" }] },
      { id: "b9", title: "History of Malaysia" },
    ],
    ...over,
  });
}

describe("clockAt", () => {
  it("reads the server instant in UTC+8: Tue 23:30Z Mon → 07:30 Tue", () => {
    expect(clockAt(new Date("2026-10-26T23:30:00Z"))).toEqual({ day: 2, minutes: at(7, 30) });
    expect(clockAt(NOW)).toEqual({ day: 2, minutes: at(8, 40) });
    // Sunday 20:00Z = Monday 04:00 KL
    expect(clockAt(new Date("2026-10-25T20:00:00Z"))).toEqual({ day: 1, minutes: at(4, 0) });
    // Saturday
    expect(clockAt(new Date("2026-10-31T03:00:00Z"))).toEqual({ day: 6, minutes: at(11, 0) });
  });
});

describe("timetable.now_next", () => {
  it("in a lesson: class, subject, period, times, room, last-taught, then today's remaining periods", async () => {
    const r = await timetableNowNext.handler(ctx(), {}, deps(seed(), { day: 2, minutes: at(8, 40), iso: NOW.toISOString() }));
    expect(r.ok).toBe(true);
    expect(r.facts![0]).toEqual({
      row: "now",
      state: "in",
      confidence: "slot",
      className: "7B",
      classId: "7b",
      subject: "Science",
      period: 2,
      periodLabel: "P2",
      startsAt: "08:30",
      endsAt: "10:40",
      room: "Lab 1",
      lastTaughtBook: "Cambridge Biology",
      lastTaughtBookId: "b1",
      lastTaughtChapter: 3,
      lastTaughtChapterTitle: "Specialised Cells",
      lastTaughtPart: 2,
    });
    expect(r.facts!.slice(1).map((f) => [f.row, f.periodLabel, f.subject, f.className, f.startsAt, f.endsAt])).toEqual([
      ["remaining", "P3", "Science", "7C", "10:40", "11:25"],
      ["remaining", "P4", "Maths", "7B", "11:25", "12:10"],
    ]);
    expect(r.facts![2].lastTaughtBook).toBeNull(); // Maths with 7B has no pointer
    expect(r.summary).toBe("Now: Science with 7B, P2 (08:30–10:40). Last time: Cambridge Biology, chapter 3 part 2. 2 more today: P3 Science 7C, P4 Maths 7B.");
    expect(r.entities).toEqual([{ kind: "class", id: "7b", label: "7B", via: "timetable.now_next" }]);
  });

  it("never reads the other teacher's slot in the same cell", async () => {
    const r = await timetableNowNext.handler(ctx(T2), {}, deps(seed(), { day: 2, minutes: at(8, 40), iso: NOW.toISOString() }));
    expect(r.facts![0]).toMatchObject({ className: "8A", subject: "History", lastTaughtBook: "History of Malaysia" });
    expect(r.facts).toHaveLength(1);
    const t1 = await timetableNowNext.handler(ctx(), {}, deps(seed(), { day: 2, minutes: at(8, 40), iso: NOW.toISOString() }));
    for (const f of t1.facts!) expect(f.className).not.toBe("8A");
  });

  it("before a lesson: 'next' with the run-up; a free period reports period confidence; the assembly never fills the bar", async () => {
    // 07:50 Tue: P1 running, but t1's P1 cell is nonteaching → period confidence, next lesson P2.
    const free = await timetableNowNext.handler(ctx(), {}, deps(seed(), { day: 2, minutes: at(7, 50), iso: NOW.toISOString() }));
    expect(free.facts![0]).toMatchObject({ row: "now", state: "in", confidence: "period", className: null, period: 1 });
    expect(free.summary).toBe("It is P1 (07:45–08:30); you have no lesson in it. 3 more today: P2 Science 7B, P3 Science 7C, P4 Maths 7B.");
    // 07:30 Tue: before P1.
    const early = await timetableNowNext.handler(ctx(), {}, deps(seed(), { day: 2, minutes: at(7, 30), iso: NOW.toISOString() }));
    expect(early.facts![0]).toMatchObject({ state: "next", confidence: "period", period: 1 });
    expect(early.summary).toMatch(/^Next is P1 \(07:45–08:30\); you have no lesson in it\./);
  });

  it("after the last period, and on a weekend: state none, no remaining", async () => {
    const late = await timetableNowNext.handler(ctx(), {}, deps(seed(), { day: 2, minutes: at(13, 0), iso: NOW.toISOString() }));
    expect(late.facts).toEqual([expect.objectContaining({ row: "now", state: "none", confidence: "none", className: null })]);
    expect(late.summary).toBe("The school day is over.");
    const sat = await timetableNowNext.handler(ctx(), {}, deps(seed(), { day: 6, minutes: at(9, 0), iso: NOW.toISOString() }));
    expect(sat.facts![0].state).toBe("none");
    expect(sat.summary).toBe("No school periods today.");
  });

  it("without a collector clock it uses the server time in Kuala Lumpur", async () => {
    const r = await timetableNowNext.handler(ctx(), {}, deps(seed())); // NOW = Tue 08:40 KL
    expect(r.facts![0]).toMatchObject({ state: "in", className: "7B", subject: "Science" });
  });

  it("no school → the default shape; no slots at all → ok with no facts", async () => {
    const noSchool = await timetableNowNext.handler(ctx(T1, null), {}, deps(seed(), { day: 2, minutes: at(8, 40), iso: NOW.toISOString() }));
    // DEFAULT_SHAPE P2 is 08:30–09:15
    expect(noSchool.facts![0]).toMatchObject({ className: "7B", startsAt: "08:30", endsAt: "09:15" });
    const none = await timetableNowNext.handler(ctx("t9"), {}, deps(seed()));
    expect(none).toMatchObject({ ok: true, facts: [], entities: [] });
    expect(none.summary).toBe("You have no timetable.");
  });

  it("a thrown or failed query → ok:false", async () => {
    const db = seed();
    db.throwing.add("timetable_slots");
    const thrown = await timetableNowNext.handler(ctx(), {}, deps(db));
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toMatch(/boom timetable_slots/);
    const failing = new FakeDb(seed().tables, { schools: "permission denied" });
    const e = await timetableNowNext.handler(ctx(), {}, deps(failing));
    expect(e.ok).toBe(false);
    expect(e.error).toMatch(/schools: permission denied/);
  });

  it("facts are flat rows, the summary ≤ 400 chars, remaining capped at 8", () => {
    const slots = Array.from({ length: 12 }, (_, i) => ({ class_id: `c${i}`, day: 1, period: i + 1, subject: "Maths", teacher_id: T1 }));
    const shape = { ...DEFAULT_SHAPE, periods: Array.from({ length: 12 }, (_, i) => ({ label: `P${i + 1}`, time: `${String(7 + i).padStart(2, "0")}:00` })), periodMinutes: 60 };
    const { facts, summary } = nowNext({ teacherId: T1, shape, slots, lastTaught: [], classNames: {}, bookTitles: {}, day: 1, minutes: at(6, 0) });
    expect(facts[0]).toMatchObject({ state: "next", className: "Class", period: 1 });
    expect(facts.filter((f) => f.row === "remaining")).toHaveLength(8);
    expect(summary.length).toBeLessThanOrEqual(400);
    for (const f of facts) for (const v of Object.values(f)) expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
  });
});
