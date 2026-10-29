// S5 slice A fixtures: two schools, a principal each, and a grade-5
// coordinator who ALSO teaches a grade-6 class (the union leak). Not a test
// file. The fake session honours eq / in filters and ignores embeds (rows carry
// their embedded objects inline), so each "RLS view" below is exactly the set
// of rows handed to it — including deliberately wider views than RLS would
// give, to prove the app-side cut on its own.

import type { SkCapabilityDeps, SkContext, SkHat, SkRole } from "@/sk/shell/types";
import { buildContext } from "@/sk/shell/context";

type Row = Record<string, unknown>;

export class FakeDb {
  log: string[] = [];
  constructor(public tables: Record<string, Row[]>) {}
  from(table: string) {
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
  select(cols?: string) {
    this.db.log.push(`${this.table}.select(${cols ?? ""})`);
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
  maybeSingle() {
    this.single = true;
    return this;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: null }) => A) | null, no?: ((e: unknown) => B) | null) {
    const rows = (this.db.tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    return Promise.resolve({ data: this.single ? (rows[0] ?? null) : rows, error: null }).then(ok, no);
  }
}

export const NOW = new Date("2026-10-28T04:00:00Z");
const DAY = 86400000;
export const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

export const SCH_A = "sch-a";
export const SCH_B = "sch-b";
export const COORD = "coord";
export const PA = "pa";
export const PB = "pb";

/** Class id → [name, grade, teacher, school, book subject of its one share]. */
const CLASSES: Array<[string, string, string, string, string, string]> = [
  ["c5a", "5 Amanah", "5", "ta1", SCH_A, "Science"],
  ["c5b", "5 Bestari", "5", "ta2", SCH_A, "Mathematics"],
  ["c6c", "6 Cemerlang", "6", COORD, SCH_A, "Science"],
  ["c4d", "4 Dedikasi", "4", "ta1", SCH_A, "English"],
  ["c5z", "5 Zamrud", "5", "tb1", SCH_B, "Science"],
];

/** Learners: [id, class, full name, username, kind] — "done" completed the
 *  class's share, "pending" submitted it (awaiting marking), "never" did nothing. */
const LEARNERS: Array<[string, string, string | null, string | null, "done" | "pending" | "never"]> = [
  ["s-aina", "c5a", "Aina", null, "done"],
  ["s-amir", "c5a", "Amir", null, "never"],
  ["s-mail", "c5a", null, "kid@mail.example", "never"],
  ["s-badrul", "c5b", "Badrul", null, "pending"],
  ["s-bunga", "c5b", "Bunga", null, "pending"],
  ["s-bayu", "c5b", "Bayu", null, "pending"],
  ["s-balqis", "c5b", "Balqis", null, "never"],
  ["s-chandra", "c6c", "Chandra", null, "pending"],
  ["s-cahya", "c6c", "Cahya", null, "pending"],
  ["s-cik", "c6c", "Cik", null, "pending"],
  ["s-citra", "c6c", "Citra", null, "never"],
  ["s-danial", "c4d", "Danial", null, "done"],
  ["s-dewi", "c4d", "Dewi", null, "never"],
  ["s-zara", "c5z", "Zara", null, "done"],
  ["s-zul", "c5z", "Zul", null, "never"],
];

const TEACHERS: Record<string, string> = { ta1: "Cikgu Aminah", ta2: "Cikgu Bakar", [COORD]: "Cikgu Koordinator", tb1: "Cikgu Zainal", [PA]: "Puan Pengetua", [PB]: "Encik Besar" };

/** Everything, both schools — what a broken RLS would hand anyone. */
export function allRows(): Record<string, Row[]> {
  return {
    classes: CLASSES.map(([id, name, grade, teacher_id, school_id]) => ({ id, name, grade, teacher_id, school_id, created_at: ago(30) })),
    enrollments: LEARNERS.map(([sid, cls, full_name, username]) => ({ class_id: cls, student_id: sid, profiles: { full_name, username, parent_email: `parent.${sid}@mail.example` } })),
    generation_shares: CLASSES.map(([cls, , , teacher, , subject]) => ({
      id: `sh-${cls}`,
      generation_id: `g-${cls}`,
      class_id: cls,
      student_id: null,
      shared_by: teacher,
      due_at: ago(2),
      created_at: ago(5),
      generations: { kind: "quiz", chapter_ref: "1", title: `${subject} quiz ${cls}` },
    })),
    student_progress: LEARNERS.filter((l) => l[4] === "done").map(([sid, cls]) => ({ generation_id: `g-${cls}`, student_id: sid, status: "completed", updated_at: ago(1) })),
    submissions: LEARNERS.filter((l) => l[4] === "pending").map(([sid, cls]) => ({
      generation_id: `g-${cls}`,
      student_id: sid,
      auto_score: 8,
      max_score: 10,
      teacher_score: null,
      submitted_at: ago(1),
      graded_at: null,
      grade_status: "pending",
    })),
    generations: CLASSES.map(([cls, , , teacher, , subject]) => ({ id: `g-${cls}`, owner_id: teacher, books: { subject } })),
    profiles: Object.entries(TEACHERS).map(([id, full_name]) => ({ id, full_name, username: null })),
    timetable_slots: CLASSES.map(([cls, , , teacher, school, subject]) => ({ school_id: school, class_id: cls, day: 3, period: 2, subject, teacher_id: teacher, room: null, kind: "lesson" })),
    schools: [
      { id: SCH_A, config: null },
      { id: SCH_B, config: null },
    ],
  };
}

/** The coordinator's real RLS union: grade-5 rows of school A (coordinates_*)
 *  PLUS their own grade-6 class (owns_class / teacher reads) and its rows. */
export function coordinatorRlsRows(): Record<string, Row[]> {
  const all = allRows();
  const visible = new Set(["c5a", "c5b", "c6c"]);
  const students = new Set(all.enrollments.filter((e) => visible.has(e.class_id as string)).map((e) => e.student_id));
  const gens = new Set([...visible].map((c) => `g-${c}`));
  return {
    ...all,
    classes: all.classes.filter((c) => visible.has(c.id as string)),
    enrollments: all.enrollments.filter((e) => visible.has(e.class_id as string)),
    generation_shares: all.generation_shares.filter((s) => visible.has(s.class_id as string)),
    student_progress: all.student_progress.filter((p) => students.has(p.student_id)),
    submissions: all.submissions.filter((p) => students.has(p.student_id)),
    generations: all.generations.filter((g) => gens.has(g.id as string)),
    timetable_slots: all.timetable_slots.filter((s) => s.school_id === SCH_A),
  };
}

/** Strings that belong to each slice of the fixture: a leak shows as one of them. */
export const GRADE6 = ["c6c", "6 Cemerlang", "Chandra", "Cahya", "Cik ", "Citra", "g-c6c", "sh-c6c", "Cikgu Koordinator"];
export const GRADE4 = ["c4d", "4 Dedikasi", "Danial", "Dewi", "g-c4d"];
export const GRADE5_A = ["5 Amanah", "5 Bestari", "Amir", "Balqis"];
export const SCHOOL_B = ["c5z", "5 Zamrud", "Zara", "Zul", "g-c5z", "Cikgu Zainal"];

export function ctxFor(o: { id: string; role: SkRole; hat: SkHat; schoolId: string | null; scope?: Array<{ grade: string | null; subject: string | null }>; locale?: string }): SkContext {
  return buildContext({
    user: { id: o.id, email: null },
    role: o.role,
    schoolId: o.schoolId,
    hat: o.hat,
    coordinatorScope: o.scope ?? [],
    plan: "school",
    staff: false,
    flags: { analytics: true, timetable: true, diary: true, hats: true, sk: true },
    collector: { path: "/dashboard/school", locale: o.locale ?? "en" },
    locale: o.locale ?? "en",
    now: NOW,
  });
}

export const coordinatorCtx = (hat: SkHat = "coordinator", scope = [{ grade: "5", subject: null as string | null }], locale = "en") =>
  ctxFor({ id: COORD, role: "teacher", hat, schoolId: SCH_A, scope, locale });
export const principalCtx = (id = PA, schoolId = SCH_A, hat: SkHat = "principal", locale = "en") => ctxFor({ id, role: "school_admin", hat, schoolId, locale });

/** Wednesday, 08:40 — inside P2 of the default shape. */
export const depsFor = (db: FakeDb): SkCapabilityDeps => ({ session: db, now: NOW, clock: { day: 3, minutes: 8 * 60 + 40, iso: NOW.toISOString() }, cache: new Map() });

export const text = (r: unknown) => JSON.stringify(r);
