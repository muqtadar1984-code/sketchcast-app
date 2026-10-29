/**
 * S5 slice C — the leader figures (school.seats, school.cost, school.gaps,
 * school.trend): who may run them, the scope cut (a grade-5 coordinator who
 * TEACHES a grade-6 class sees no grade-6 figure), the principal's school
 * boundary, the cost fold = utils/kit-cost.ts on the same rows, gap matching
 * across grade spellings, the trend's ISO-week bucketing, and no email in
 * any result.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/school-figures.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  computeGaps,
  computeTrend,
  fmtDate,
  isoWeekLabel,
  isoWeekStart,
  pickEntitlement,
  schoolCost,
  schoolCostFold,
  schoolGaps,
  schoolSeats,
  schoolTrend,
  SCHOOL_FIGURE_CAPABILITIES,
  SCHOOL_FIGURE_CAPABILITY_NAMES,
  type GapBook,
  type GapClass,
  type GapSlot,
} from "../school-figures";
import { kitCostReport, USAGE_TRACKED_FROM, type CostGen, type CostJob } from "@/utils/kit-cost";
import { allowedFor, metaAllows } from "@/sk/shell/registry";
import { runCapability } from "@/sk/shell/runner";
import { MemoryAuditSink } from "@/sk/shell/audit";
import type { HealthRows } from "@/utils/school-health";
import type { SkCapabilityDeps } from "@/sk/shell/types";
import { allRows, ago, COORD, coordinatorCtx, coordinatorRlsRows, ctxFor, NOW, PA, PB, principalCtx, SCH_A, SCH_B, text } from "./leader-fixtures";

type Row = Record<string, unknown>;

// ── A fake session that also honours gte / is / range / count:head ──────────

class FigDb {
  constructor(public tables: Record<string, Row[]>) {}
  from(table: string) {
    return new FigQuery(this.tables[table] ?? []);
  }
  rpc() {
    return Promise.resolve({ data: null, error: null });
  }
}

class FigQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private head = false;
  private window: [number, number] | null = null;
  private single = false;
  constructor(private rows: Row[]) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    this.head = !!opts?.head;
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
  in(c: string, list: unknown[]) {
    this.filters.push((r) => list.includes(r[c]));
    return this;
  }
  gte(c: string, v: string) {
    this.filters.push((r) => typeof r[c] === "string" && (r[c] as string) >= v);
    return this;
  }
  is(c: string, v: null) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  range(from: number, to: number) {
    this.window = [from, to];
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: null; count?: number }) => A) | null, no?: ((e: unknown) => B) | null) {
    let rows = this.rows.filter((r) => this.filters.every((f) => f(r)));
    const count = rows.length;
    if (this.window) rows = rows.slice(this.window[0], this.window[1] + 1);
    const v = this.head ? { data: null, error: null, count } : { data: this.single ? (rows[0] ?? null) : rows, error: null };
    return Promise.resolve(v).then(ok, no);
  }
}

const depsFor = (db: FigDb): SkCapabilityDeps => ({ session: db, now: NOW, cache: new Map() });

// ── Fixture: the slice-A schools, plus books, cost rows, profiles, timetable ─

const TRACKED = Date.parse(USAGE_TRACKED_FROM);
const gen = (id: string, owner: string, school: string, book: string | null, created: string, extra: Partial<CostGen> = {}): Row => ({
  id,
  owner_id: owner,
  school_id: school,
  kind: "presentation",
  book_id: book,
  chapter_ref: "1",
  created_at: created,
  part: null,
  language: "en",
  catalogue: null,
  catalogue_ref: null,
  coverage_model: null,
  books: { subject: null },
  ...extra,
});
const job = (id: string, g: string, created: string, total: number, status = "done"): Row => ({ id, generation_id: g, type: "presentation", status, usage: { cost_usd: total, total_usd: total }, created_at: created });

/** The four generations of school A's shares (g-c5a … g-c4d) + one before
 *  tracking + a catalogue copy (never costed) + school B's. */
function costRows(): { generations: Row[]; jobs: Row[] } {
  const generations = [
    gen("g-c5a", "ta1", SCH_A, "bk-sci5", ago(5)),
    gen("g-c5b", "ta2", SCH_A, "bk-math5", ago(4)),
    gen("g-c6c", COORD, SCH_A, "bk-sci6", ago(3)),
    gen("g-c4d", "ta1", SCH_A, "bk-eng4", ago(6)),
    gen("g-old", "ta2", SCH_A, "bk-math5", "2026-10-01T09:00:00Z", { chapter_ref: "2" }),
    gen("g-cat", "ta1", SCH_A, null, ago(2), { catalogue_ref: "topic-x" }),
    gen("g-c5z", "tb1", SCH_B, "bk-b", ago(2)),
  ];
  const jobs = [
    job("j1", "g-c5a", ago(5), 0.5),
    job("j2", "g-c5b", ago(4), 0.3),
    job("j3", "g-c6c", ago(3), 0.8),
    job("j4", "g-c4d", ago(6), 0.2),
    job("j5", "g-old", "2026-10-01T09:05:00Z", 0.1),
    job("j6", "g-cat", ago(2), 9),
    job("j7", "g-c5z", ago(2), 5),
  ];
  return { generations, jobs };
}

const BOOKS: Row[] = [
  { id: "bk-sci5", title: "Science Grade 5", grade: "Grade 5", subject: "Science", school_id: SCH_A, removed_at: null },
  { id: "bk-math5", title: "Matematik Tahun 5", grade: "Year 5", subject: "Matematik", school_id: SCH_A, removed_at: null },
  { id: "bk-sci6", title: "Sains Tahun 6", grade: "6", subject: "Sains", school_id: SCH_A, removed_at: null },
  { id: "bk-eng4", title: "English Standard 4", grade: "Standard 4", subject: "English", school_id: SCH_A, removed_at: null },
  { id: "bk-hist5", title: "History 5 (withdrawn)", grade: "5", subject: "History", school_id: SCH_A, removed_at: ago(10) },
  { id: "bk-art5", title: "Art 5", grade: "5", subject: "Art", school_id: SCH_A, removed_at: null },
  { id: "bk-b", title: "History 5 (school B)", grade: "5", subject: "History", school_id: SCH_B, removed_at: null },
];

function slots(): Row[] {
  const out: Row[] = [];
  const add = (school: string, cls: string, subject: string, n: number, kind = "lesson") => {
    for (let i = 0; i < n; i++) out.push({ school_id: school, class_id: cls, day: 1 + (i % 5), period: 1 + i, subject, teacher_id: null, kind });
  };
  add(SCH_A, "c5a", "Science", 3);
  add(SCH_A, "c5a", "Mathematics", 4);
  add(SCH_A, "c5a", "History", 5);
  add(SCH_A, "c5a", "Art", 2);
  add(SCH_A, "c5a", "Pendidikan Moral", 1);
  add(SCH_A, "c5a", "Assembly", 2, "nonteaching");
  add(SCH_A, "c5b", "Matematik", 4);
  add(SCH_A, "c5b", "History", 1);
  add(SCH_A, "c6c", "Sains", 3);
  add(SCH_A, "c6c", "Geography", 6);
  add(SCH_A, "c4d", "English", 2);
  add(SCH_B, "c5z", "History", 7);
  return out;
}

/** profiles with role + school (seats) — names as slice A's fixture. */
function profiles(): Row[] {
  const p = (id: string, role: string, school: string, full_name: string | null, username: string | null = null): Row => ({ id, role, school_id: school, full_name, username });
  return [
    p("ta1", "teacher", SCH_A, "Cikgu Aminah"),
    p("ta2", "teacher", SCH_A, null, "bakar@school.example"),
    p(COORD, "teacher", SCH_A, "Cikgu Koordinator"),
    p(PA, "school_admin", SCH_A, "Puan Pengetua"),
    ...["s-aina", "s-amir", "s-mail", "s-badrul", "s-bunga", "s-bayu", "s-balqis", "s-chandra", "s-cahya", "s-cik", "s-citra", "s-danial", "s-dewi"].map((id) => p(id, "student", SCH_A, id)),
    p("tb1", "teacher", SCH_B, "Cikgu Zainal"),
    p(PB, "school_admin", SCH_B, "Encik Besar"),
    p("s-zara", "student", SCH_B, "Zara"),
    p("s-zul", "student", SCH_B, "Zul"),
  ];
}

/** Every row of both schools (what a broken RLS would hand anyone). */
function everything(): Record<string, Row[]> {
  const base = allRows();
  const { generations, jobs } = costRows();
  return { ...base, generations, jobs, books: BOOKS, timetable_slots: slots(), profiles: profiles(), entitlements: [] };
}

/** The coordinator's RLS union: scope grade 5 + their own grade-6 class. */
function coordinatorView(): Record<string, Row[]> {
  const base = coordinatorRlsRows();
  const { generations, jobs } = costRows();
  const visibleGens = new Set(["g-c5a", "g-c5b", "g-c6c"]);
  return {
    ...base,
    generations: generations.filter((g) => visibleGens.has(g.id as string)),
    jobs: jobs.filter((j) => visibleGens.has(j.generation_id as string)),
    books: BOOKS.filter((b) => b.school_id === SCH_A),
    timetable_slots: slots().filter((s) => s.school_id === SCH_A),
    profiles: profiles().filter((p) => p.id === COORD),
    entitlements: [],
  };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const GRADE6_FIGURES = ["c6c", "6 Cemerlang", "Geography", "Sains", "bk-sci6", "Cikgu Koordinator", "Chandra", "Cahya", "Citra"];
const SCHOOL_B_FIGURES = ["c5z", "Zainal", "bk-b", "school B", "5.00", "Zara"];
const none = (out: string, tokens: string[]) => {
  for (const t of tokens) expect(out, `leaked "${t}"`).not.toContain(t);
};

// ═══ Registry ════════════════════════════════════════════════════════════════

describe("registry: who sees the figures", () => {
  const names = (ctx: ReturnType<typeof principalCtx>) => allowedFor(ctx).map((c) => c.meta.name);

  it("all four are named school.* (slice B's meter keys on the prefix) and listed", () => {
    expect(SCHOOL_FIGURE_CAPABILITIES.map((c) => c.meta.name)).toEqual([...SCHOOL_FIGURE_CAPABILITY_NAMES]);
    for (const c of SCHOOL_FIGURE_CAPABILITIES) {
      expect(c.meta.name.startsWith("school.")).toBe(true);
      expect(c.meta.tier).toBe("immediate");
      expect(c.meta.kind).toBe("read");
    }
  });

  it("principal hat: all four; coordinator hat: cost, gaps, trend — NEVER seats", () => {
    expect(names(principalCtx())).toEqual(expect.arrayContaining(["school.seats", "school.cost", "school.gaps", "school.trend"]));
    const coord = names(coordinatorCtx());
    expect(coord).toEqual(expect.arrayContaining(["school.cost", "school.gaps", "school.trend"]));
    expect(coord).not.toContain("school.seats");
  });

  it("school.seats: no coordinator in any shape (hat on, hats off, a school_admin wearing the coordinator hat)", () => {
    expect(metaAllows(schoolSeats.meta, coordinatorCtx())).toBe(false);
    expect(metaAllows(schoolSeats.meta, coordinatorCtx(null))).toBe(false);
    expect(metaAllows(schoolSeats.meta, ctxFor({ id: PA, role: "school_admin", hat: "coordinator", schoolId: SCH_A, scope: [{ grade: "5", subject: null }] }))).toBe(false);
    expect(metaAllows(schoolSeats.meta, principalCtx(PA, SCH_A, "teacher"))).toBe(false);
    expect(metaAllows(schoolSeats.meta, principalCtx(PA, SCH_A, null))).toBe(true);
  });

  it("teacher hat / plain teacher / parent / student: none of the four", () => {
    for (const ctx of [coordinatorCtx("teacher"), ctxFor({ id: "ta1", role: "teacher", hat: "teacher", schoolId: SCH_A }), ctxFor({ id: "x", role: "parent", hat: "parent", schoolId: null }), ctxFor({ id: "s", role: "student", hat: null, schoolId: SCH_A })]) {
      for (const c of SCHOOL_FIGURE_CAPABILITIES) expect(metaAllows(c.meta, ctx), c.meta.name).toBe(false);
    }
  });
});

// ═══ school.seats ════════════════════════════════════════════════════════════

describe("school.seats (principal only)", () => {
  it("the coordinator is refused by EXECUTION too: the runner says not_allowed, and the handler called directly gives no number", async () => {
    const deps = { session: new FigDb(everything()), now: NOW, sink: new MemoryAuditSink(), sessionId: null, turnId: null };
    const r = await runCapability(coordinatorCtx(), "school.seats", {}, deps);
    expect(r.error).toBe("not_allowed");
    const direct = await schoolSeats.handler(coordinatorCtx(), {}, depsFor(new FigDb(everything())));
    expect(direct.summary).toBe("School licence and seat figures are for the principal only.");
    expect(direct.facts).toEqual([]);
    expect(text(direct)).not.toMatch(/\d/);
  });

  it("counts teachers, students and admins of the principal's school only; no licence → no seat limit line", async () => {
    const r = await schoolSeats.handler(principalCtx(), {}, depsFor(new FigDb(everything())));
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("Your school: teachers 3, students 13, school admins 1. No seat limit is recorded for your school yet.");
    expect(r.facts?.[0]).toMatchObject({ row: "seats", teachers: 3, students: 13, admins: 1, seatLimit: null });
    const b = await schoolSeats.handler(principalCtx(PB, SCH_B), {}, depsFor(new FigDb(everything())));
    expect(b.summary).toContain("teachers 1, students 2, school admins 1");
  });

  it("a licence row: plan, status, period end — still no seat limit claimed; another school's row is never read", async () => {
    const tables = everything();
    tables.entitlements = [
      { school_id: SCH_A, plan_key: "school_annual", status: "active", active: true, current_period_end: "2027-01-31T00:00:00Z", updated_at: ago(3) },
      { school_id: SCH_A, plan_key: "school_trial", status: "expired", active: false, current_period_end: "2026-09-30T00:00:00Z", updated_at: ago(40) },
      { school_id: SCH_B, plan_key: "school_b_plan", status: "active", active: true, current_period_end: "2027-06-30T00:00:00Z", updated_at: ago(1) },
    ];
    const r = await schoolSeats.handler(principalCtx(), {}, depsFor(new FigDb(tables)));
    expect(r.summary).toContain("Licence: school_annual, status active, current period ends 31 Jan 2027.");
    expect(r.summary).toContain("No seat limit is recorded for your school yet.");
    expect(text(r)).not.toContain("school_b_plan");
  });

  it("pickEntitlement: active first, then the latest period end", () => {
    expect(pickEntitlement([])).toBeNull();
    expect(pickEntitlement([
      { plan_key: "a", status: "canceled", active: false, current_period_end: "2027-12-01T00:00:00Z" },
      { plan_key: "b", status: "active", active: true, current_period_end: "2027-01-01T00:00:00Z" },
    ])?.plan_key).toBe("b");
  });

  it("Malay and Arabic answers", async () => {
    const ms = await schoolSeats.handler(principalCtx(PA, SCH_A, "principal", "ms"), {}, depsFor(new FigDb(everything())));
    expect(ms.summary).toBe("Sekolah anda: guru 3, murid 13, pentadbir sekolah 1. Belum ada had bilangan pengguna yang direkodkan untuk sekolah anda.");
    const ar = await schoolSeats.handler(principalCtx(PA, SCH_A, "principal", "ar"), {}, depsFor(new FigDb(everything())));
    expect(ar.summary).toContain("المعلمون 3");
  });
});

// ═══ school.cost ═════════════════════════════════════════════════════════════

describe("school.cost", () => {
  it("the fold IS kit-cost.ts kitCostReport: same rows, same window → same client totals", () => {
    const { generations, jobs } = costRows();
    const gens = generations.filter((g) => g.school_id === SCH_A) as unknown as CostGen[];
    const js = jobs as unknown as CostJob[];
    const nowMs = NOW.getTime();
    const fold = schoolCostFold({ gens, jobs: js, nowMs });
    const console30 = kitCostReport({ gens, jobs: js, topicKits: [], excludedOwners: new Set(), windowStartMs: nowMs - 30 * 86400000 }).client;
    const consoleSince = kitCostReport({ gens, jobs: js, topicKits: [], excludedOwners: new Set(), windowStartMs: TRACKED }).client;
    expect(fold.last30).toEqual({ kits: console30.kits, costed: console30.costed, usd: console30.totalUsd, excluded: console30.excluded });
    expect(fold.since).toEqual({ kits: consoleSince.kits, costed: consoleSince.costed, usd: consoleSince.totalUsd, excluded: consoleSince.excluded });
    // …and the numbers themselves: g-old (1 Oct) is before tracking, the catalogue copy is never a client kit.
    expect(fold.last30.kits).toBe(5);
    expect(fold.last30.costed).toBe(4);
    expect(fold.last30.usd).toBeCloseTo(1.8, 10);
    expect(fold.last30.excluded).toEqual([{ reason: "before usage tracking (15 Oct)", n: 1 }]);
    expect(fold.since).toMatchObject({ kits: 4, costed: 4 });
    expect(fold.startsBeforeTracking).toBe(true);
    expect(fold.top.map((t) => [t.ownerId, Math.round(t.usd * 100)])).toEqual([[COORD, 80], ["ta1", 70], ["ta2", 30]]);
  });

  it("principal: the school's kits, the top 3 teachers, 'cost tracking began on 15 Oct 2026'; no other school, no email", async () => {
    // The worst case: the session hands over BOTH schools' rows.
    const r = await schoolCost.handler(principalCtx(), {}, depsFor(new FigDb(everything())));
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("Generation cost for the school, last 30 days: kits 5 (with cost recorded 4), $1.80.");
    expect(r.summary).toContain("Since cost tracking began on 15 Oct 2026: kits 4 (with cost recorded 4), $1.80.");
    expect(r.summary).toContain("Cost tracking began on 15 Oct 2026");
    // ta2's username is an email address: the name falls back to "Teacher".
    expect(r.summary).toContain("Top teachers by cost (last 30 days): Cikgu Koordinator $0.80 (1); Cikgu Aminah $0.70 (2); Teacher $0.30 (1).");
    const out = text(r);
    none(out, SCHOOL_B_FIGURES);
    expect(out).not.toMatch(EMAIL);
    expect(out).not.toContain("9.00");
  });

  it("coordinator (grade 5): ONLY the kits shared to grade-5 classes — their own grade-6 kit is not counted; totals only, no teacher names", async () => {
    for (const view of [coordinatorView, everything]) {
      const r = await schoolCost.handler(coordinatorCtx(), {}, depsFor(new FigDb(view())));
      expect(r.ok).toBe(true);
      expect(r.summary).toContain("Generation cost for grade 5, last 30 days: kits 2 (with cost recorded 2), $0.80.");
      expect(r.summary).not.toContain("Top teachers");
      expect((r.facts ?? []).some((f) => f.row === "teacher")).toBe(false);
      const out = text(r);
      expect(out).not.toContain("1.60");
      expect(out).not.toContain("1.80");
      none(out, ["Cikgu Koordinator", "Cikgu Aminah", "Cikgu Bakar", ...SCHOOL_B_FIGURES]);
    }
  });

  it("principal of school B sees school B only", async () => {
    const r = await schoolCost.handler(principalCtx(PB, SCH_B), {}, depsFor(new FigDb(everything())));
    expect(r.summary).toContain("kits 1 (with cost recorded 1), $5.00.");
    none(text(r), ["1.80", "Cikgu Aminah", "Koordinator"]);
  });

  it("fmtDate: '15 Oct 2026' in English, Western digits in Arabic", () => {
    expect(fmtDate(TRACKED, "en")).toBe("15 Oct 2026");
    expect(fmtDate(TRACKED, "ar")).toMatch(/15/);
    expect(fmtDate(TRACKED, "ms-arab")).toMatch(/15/);
  });
});

// ═══ school.gaps ═════════════════════════════════════════════════════════════

describe("school.gaps", () => {
  it("principal: timetable pairs with no book / no kits, most-taught first; withdrawn books are not on the shelf; offers the school shelf", async () => {
    const r = await schoolGaps.handler(principalCtx(), {}, depsFor(new FigDb(everything())));
    expect(r.ok).toBe(true);
    const gaps = (r.facts ?? []).filter((f) => f.row === "gap");
    expect(gaps.map((g) => [g.subject, g.grade, g.kind, g.periodsPerWeek])).toEqual([
      ["Geography", "6", "no_book", 6],
      ["History", "5", "no_book", 6],
      ["Art", "5", "no_kits", 2],
      ["Pendidikan Moral", "5", "no_book", 1],
    ]);
    expect(r.summary).toContain("Shelf gaps in the school: 4. Geography, grade 6 — no book on the shelf (periods a week: 6)");
    expect(r.summary).toContain("Art, grade 5 — book on shelf, no kits yet (periods a week: 2)");
    expect(r.summary).toContain("To add a book, open the school shelf.");
    expect((r.facts ?? []).find((f) => f.row === "offer")).toEqual({ row: "offer", target: "school_books", path: "/dashboard/school/books", label: "Open the school shelf" });
    expect(r.entities).toEqual([{ kind: "book", id: "bk-art5", label: "Art 5", via: "school.gaps" }]);
    // Assembly is not a lesson; Science/Maths/English are covered ("5" = "Grade 5" = "Year 5", Matematik = Mathematics).
    none(text(r), ["Assembly", "Science", "Mathematics", "English", ...SCHOOL_B_FIGURES]);
  });

  it("coordinator (grade 5): no grade-6 pair even though they teach one (over the real union and over everything)", async () => {
    for (const view of [coordinatorView, everything]) {
      const r = await schoolGaps.handler(coordinatorCtx(), {}, depsFor(new FigDb(view())));
      const gaps = (r.facts ?? []).filter((f) => f.row === "gap");
      expect(gaps.map((g) => [g.subject, g.grade])).toEqual([
        ["History", "5"],
        ["Art", "5"],
        ["Pendidikan Moral", "5"],
      ]);
      expect(r.summary).toContain("Shelf gaps in grade 5: 3.");
      none(text(r), [...GRADE6_FIGURES, ...SCHOOL_B_FIGURES]);
    }
  });

  it("coordinator asking about grade 6 is told it is outside their scope", async () => {
    const r = await schoolGaps.handler(coordinatorCtx(), { grade: "grade 6" }, depsFor(new FigDb(everything())));
    expect(r.summary).toBe("grade 6 is outside your scope (grade 5), so I can't show it.");
    expect(r.facts).toEqual([]);
  });

  it("a subject-scoped coordinator (grade 5, History) sees only History", async () => {
    const ctx = coordinatorCtx("coordinator", [{ grade: "5", subject: "History" }]);
    const r = await schoolGaps.handler(ctx, {}, depsFor(new FigDb(everything())));
    expect((r.facts ?? []).filter((f) => f.row === "gap").map((g) => g.subject)).toEqual(["History"]);
  });

  it("computeGaps: grade formats differ between the timetable's classes and the books", () => {
    const ls = { mode: "school" as const, schoolId: "s" };
    const classes: GapClass[] = [
      { id: "k1", grade: "Tingkatan 1", school_id: "s" },
      { id: "k5", grade: "5", school_id: "s" },
      { id: "k7", grade: "Grade 7", school_id: "s" },
    ];
    const slotsIn: GapSlot[] = [
      { class_id: "k1", subject: "Sains" },
      { class_id: "k5", subject: "Mathematics" },
      { class_id: "k7", subject: "History" },
    ];
    const books: GapBook[] = [
      { id: "b1", grade: "Form 1", subject: "Science" },
      { id: "b5", grade: "Grade 5", subject: "Matematik" },
      // "Form 1" is level 7 — it must NOT cover Grade 7 History, nor does Year 7 Geography.
      { id: "b7", grade: "Year 7", subject: "Geography" },
    ];
    const r = computeGaps({ slots: slotsIn, classes, books, kitBooks: new Set(["b1"]), ls });
    expect(r.gaps.map((g) => [g.subject, g.grade, g.kind])).toEqual([
      ["History", "Grade 7", "no_book"],
      ["Mathematics", "5", "no_kits"],
    ]);
    // "5" vs "Year 5" spelled on the class side too.
    const r2 = computeGaps({ slots: [{ class_id: "y5", subject: "Maths" }], classes: [{ id: "y5", grade: "Year 5", school_id: "s" }], books, kitBooks: new Set(["b5"]), ls });
    expect(r2.gaps).toEqual([]);
    expect(r2.pairs).toBe(1);
  });

  it("computeGaps: at most 8, ties broken deterministically", () => {
    const ls = { mode: "school" as const, schoolId: "s" };
    const classes: GapClass[] = [{ id: "k", grade: "5", school_id: "s" }];
    const subjects = ["Zeta", "Alpha", "Mu", "Beta", "Gamma", "Delta", "Eta", "Theta", "Iota", "Kappa"];
    const s: GapSlot[] = subjects.flatMap((sub, i) => Array.from({ length: i === 0 ? 3 : 1 }, () => ({ class_id: "k", subject: sub })));
    const r = computeGaps({ slots: s, classes, books: [], kitBooks: new Set(), ls });
    expect(r.gaps).toHaveLength(8);
    expect(r.gaps[0].subject).toBe("Zeta");
    expect(r.gaps.slice(1, 4).map((g) => g.subject)).toEqual(["Alpha", "Beta", "Delta"]);
  });

  it("no timetable → says so", async () => {
    const tables = everything();
    tables.timetable_slots = [];
    const r = await schoolGaps.handler(principalCtx(), {}, depsFor(new FigDb(tables)));
    expect(r.summary).toBe("There is no timetable for the school yet, so I can't compare it with the shelf.");
  });
});

// ═══ school.trend ════════════════════════════════════════════════════════════

describe("school.trend", () => {
  it("ISO week helpers (UTC Monday)", () => {
    // 2026-10-28 is a Wednesday: its week starts Monday 26 Oct, ISO week 44.
    expect(new Date(isoWeekStart(NOW.getTime())).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(isoWeekLabel(isoWeekStart(NOW.getTime()))).toBe("2026-W44");
    expect(isoWeekLabel(Date.UTC(2026, 0, 1))).toBe("2026-W01"); // Thu 1 Jan 2026
    expect(new Date(isoWeekStart(Date.UTC(2026, 10, 1, 23))).toISOString()).toBe("2026-10-26T00:00:00.000Z"); // Sunday → previous Monday
  });

  it("computeTrend: buckets due, submitted, on time and awaiting marking per week", () => {
    const at = (iso: string) => `${iso}:00Z`;
    const rows: HealthRows = {
      classes: [{ id: "c", name: "5A", grade: "5", teacher_id: "t" }],
      enrollments: ["a", "b"].map((s) => ({ class_id: "c", student_id: s, full_name: s, username: null, parent_email: null })),
      shares: [
        { generation_id: "g1", class_id: "c", shared_by: "t", due_at: at("2026-10-07T23:00") }, // W41
        { generation_id: "g2", class_id: "c", shared_by: "t", due_at: at("2026-10-16T12:00") }, // W42
        { generation_id: "g3", class_id: "c", shared_by: "t", due_at: at("2026-10-30T12:00") }, // W44, not yet due
        { generation_id: "g4", class_id: null, student_id: "a", shared_by: "t", due_at: at("2026-10-16T12:00") }, // direct share: not counted
      ],
      progress: [],
      submissions: [
        // g1: a on time (W41), b late in W42; a graded in W42, b still pending.
        { generation_id: "g1", student_id: "a", auto_score: null, max_score: 10, teacher_score: 8, submitted_at: at("2026-10-07T10:00"), graded_at: at("2026-10-13T10:00"), grade_status: "graded" },
        { generation_id: "g1", student_id: "b", auto_score: null, max_score: 10, teacher_score: null, submitted_at: at("2026-10-12T10:00"), graded_at: null, grade_status: "pending" },
        // g2: both on time in W42, auto-marked: never awaiting.
        { generation_id: "g2", student_id: "a", auto_score: 9, max_score: 10, teacher_score: null, submitted_at: at("2026-10-15T10:00"), graded_at: null, grade_status: "auto" },
        { generation_id: "g2", student_id: "b", auto_score: 9, max_score: 10, teacher_score: null, submitted_at: at("2026-10-16T11:59"), graded_at: null, grade_status: "auto" },
      ],
      generations: [],
      teacherNames: {},
    };
    const now = Date.parse("2026-10-28T04:00:00Z");
    const w = computeTrend(rows, now);
    expect(w.map((x) => x.week)).toEqual(["2026-W41", "2026-W42", "2026-W43", "2026-W44"]);
    expect(w[0]).toMatchObject({ due: 2, submitted: 1, onTimePct: 50, pending: 1, partial: false }); // a waits until 13 Oct
    expect(w[1]).toMatchObject({ due: 2, submitted: 3, onTimePct: 100, pending: 1 }); // a graded 13 Oct; b pending
    expect(w[2]).toMatchObject({ due: 0, submitted: 0, onTimePct: null, pending: 1 });
    expect(w[3]).toMatchObject({ due: 2, submitted: 0, onTimePct: null, pending: 1, partial: true }); // g3 due Friday: not yet due
  });

  it("principal vs coordinator: the coordinator's numbers carry no grade-6 learner; labelled approximate", async () => {
    const p = await schoolTrend.handler(principalCtx(), {}, depsFor(new FigDb(everything())));
    const pw = (p.facts ?? []).at(-1)!;
    // This week: shares due Mon 26 Oct to c5a(3) c5b(4) c6c(4) c4d(2) = 13; submitted c5b 3 + c6c 3 = 6.
    expect(pw).toMatchObject({ week: "2026-W44", due: 13, submitted: 6, awaitingMarking: 6, onTimePct: 0, approximate: true });
    expect(p.summary).toContain("approximate (from submission and due dates)");
    for (const view of [coordinatorView, everything]) {
      const c = await schoolTrend.handler(coordinatorCtx(), {}, depsFor(new FigDb(view())));
      const cw = (c.facts ?? []).at(-1)!;
      expect(cw).toMatchObject({ week: "2026-W44", due: 7, submitted: 3, awaitingMarking: 3 });
      expect(c.summary).toContain("Trend for grade 5, last 4 weeks — approximate (from submission and due dates):");
      none(text(c), [...GRADE6_FIGURES, ...SCHOOL_B_FIGURES]);
    }
  });

  it("Malay and Arabic labels", async () => {
    const ms = await schoolTrend.handler(principalCtx(PA, SCH_A, "principal", "ms"), {}, depsFor(new FigDb(everything())));
    expect(ms.summary).toContain("anggaran (daripada tarikh hantar dan tarikh akhir)");
    expect(ms.summary).toContain("minggu ini (setakat ini)");
    const ar = await schoolTrend.handler(principalCtx(PA, SCH_A, "principal", "ar"), {}, depsFor(new FigDb(everything())));
    expect(ar.summary).toContain("تقريبي");
  });
});

// ═══ The email boundary, every figure ════════════════════════════════════════

describe("no email in any result", () => {
  it("principal and coordinator, all four, worst-case rows", async () => {
    const tables = everything();
    // Make every name an address and every parent row carry one.
    tables.profiles = (tables.profiles as Row[]).map((p) => ({ ...p, full_name: `${p.id}@mail.example`, username: `${p.id}@mail.example` }));
    tables.books = (tables.books as Row[]).map((b) => ({ ...b, title: `${b.title} owner@mail.example` }));
    for (const ctx of [principalCtx(), coordinatorCtx()]) {
      for (const cap of SCHOOL_FIGURE_CAPABILITIES) {
        if (!metaAllows(cap.meta, ctx)) continue;
        const r = await cap.handler(ctx, {}, depsFor(new FigDb(tables)));
        expect(text(r), `${cap.meta.name}`).not.toMatch(EMAIL);
      }
    }
  });
});
