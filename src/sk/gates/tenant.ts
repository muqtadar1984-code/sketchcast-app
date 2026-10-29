// SK S5 slice E — the §8.4 leader gates' seeded TWO-TENANT fake (Final Plan
// 2026-10-28 §8.4: "60 questions per role over a seeded tenant with known
// answers"; "permission matrix … two tenants"). Not a test file.
//
// Two schools. School A: a principal, a grade-5 coordinator who ALSO teaches
// a grade-6 class (the union leak S5 slice A closes), two more teachers, four
// classes (grades 4, 5, 5, 6), learners in every state the school-health rules
// read, shares, progress, submissions, a costed kit per class, a shelf with
// gaps, a timetable, a licence. School B: the same shapes with its own names,
// figures and licence — every one of them a leak if it ever reaches an
// answer of school A's leaders.
//
// The session fake is a FILTER-HONOURING Supabase stand-in (eq / neq / in /
// is / gte / gt / lte / lt / ilike / not-is-null, count+head, range, limit,
// maybeSingle) over an RLS VIEW of the tables:
//   "rls"   — what the database's row rules hand each user (a principal: their
//             school; the coordinator: the grade-5 rows PLUS their own grade-6
//             class — the real union); the §8.4 gate runs on this view.
//   "leaky" — BOTH schools to everyone (a broken RLS); the app-side cut must
//             still hold. Run as a second, defence-in-depth isolation pass.
// Rows carry their embeds inline (enrollments.profiles, shares.generations,
// generations.books), as the slice A/C fixtures do.

export const GATE_NOW = new Date("2026-10-28T04:00:00Z"); // a Wednesday
/** Wednesday 08:40 — inside P2 of the default timetable shape. */
export const GATE_CLOCK = { day: 3, minutes: 8 * 60 + 40, iso: GATE_NOW.toISOString() };
const DAY = 86_400_000;
export const ago = (d: number) => new Date(GATE_NOW.getTime() - d * DAY).toISOString();

export const SCH_A = "sch-a";
export const SCH_B = "sch-b";

/** The leaders the gates sign in as. */
export const GATE_USERS = {
  principalA: { id: "pa", role: "school_admin", schoolId: SCH_A, hat: "principal", email: "principal.a@gates.example", name: "Puan Rohana" },
  principalB: { id: "pb", role: "school_admin", schoolId: SCH_B, hat: "principal", email: "principal.b@gates.example", name: "Puan Zaleha" },
  coordinator: { id: "coord", role: "teacher", schoolId: SCH_A, hat: "coordinator", email: "coordinator@gates.example", name: "Cikgu Kamal" },
} as const;
export type GateUserKey = keyof typeof GATE_USERS;
export type GateUser = (typeof GATE_USERS)[GateUserKey];

type Row = Record<string, unknown>;
type Kind = "done" | "pending" | "never";

/** [id, name, grade, teacher, school, subject of its quiz, book id] */
const CLASSES: Array<[string, string, string, string, string, string, string]> = [
  ["c5a", "5 Amanah", "5", "ta1", SCH_A, "Science", "bk-sci5"],
  ["c5b", "5 Bestari", "5", "ta2", SCH_A, "Mathematics", "bk-math5"],
  ["c6c", "6 Cemerlang", "6", "coord", SCH_A, "Science", "bk-sci6"],
  ["c4d", "4 Dedikasi", "4", "ta1", SCH_A, "English", "bk-eng4"],
  ["c5z", "5 Zamrud", "5", "tb1", SCH_B, "Science", "bk-b-sci5"],
  ["c6y", "6 Yakin", "6", "tb2", SCH_B, "Mathematics", "bk-b-math6"],
];

/** [id, class, full name, username, kind] — "done" completed its class's quiz,
 *  "pending" submitted it (awaiting marking), "never" did nothing. One learner's
 *  username IS an email address (the email boundary must hide it). */
const LEARNERS: Array<[string, string, string | null, string | null, Kind]> = [
  ["s-aina", "c5a", "Aina", null, "done"],
  ["s-arif", "c5a", "Arif", null, "done"],
  ["s-amir", "c5a", "Amir", null, "never"],
  ["s-mail", "c5a", null, "kid@mail.example", "never"],
  ["s-badrul", "c5b", "Badrul", null, "pending"],
  ["s-bunga", "c5b", "Bunga", null, "pending"],
  ["s-bayu", "c5b", "Bayu", null, "pending"],
  ["s-balqis", "c5b", "Balqis", null, "never"],
  ["s-chandra", "c6c", "Chandra", null, "pending"],
  ["s-cahya", "c6c", "Cahya", null, "pending"],
  ["s-citra", "c6c", "Citra", null, "never"],
  ["s-danial", "c4d", "Danial", null, "done"],
  ["s-dewi", "c4d", "Dewi", null, "never"],
  ["s-zara", "c5z", "Zara", null, "done"],
  ["s-zul", "c5z", "Zul", null, "never"],
  ["s-zaki", "c5z", "Zaki", null, "never"],
  ["s-yasmin", "c6y", "Yasmin", null, "pending"],
  ["s-yusuf", "c6y", "Yusuf", null, "never"],
];

/** Staff: id → [name, role, school]. */
const STAFF: Record<string, [string, string, string]> = {
  pa: ["Puan Rohana", "school_admin", SCH_A],
  coord: ["Cikgu Kamal", "teacher", SCH_A],
  ta1: ["Cikgu Aminah", "teacher", SCH_A],
  ta2: ["Cikgu Bakar", "teacher", SCH_A],
  pb: ["Puan Zaleha", "school_admin", SCH_B],
  tb1: ["Cikgu Zainal", "teacher", SCH_B],
  tb2: ["Cikgu Zubir", "teacher", SCH_B],
};

/** Kit cost per class's generation (USD, recorded after tracking began). */
const COST: Record<string, number> = { c5a: 0.5, c5b: 0.3, c6c: 0.8, c4d: 0.2, c5z: 5, c6y: 2.5 };

/** Every table, both schools — what a broken RLS would hand anyone. */
export function gateTables(): Record<string, Row[]> {
  const classOf = new Map(CLASSES.map((c) => [c[0], c] as const));
  const schoolOfClass = (cls: string) => classOf.get(cls)?.[4] ?? null;
  const gen = (cls: string): Row => {
    const [, , , teacher, school, subject, book] = classOf.get(cls)!;
    return {
      id: `g-${cls}`,
      owner_id: teacher,
      school_id: school,
      kind: "quiz",
      book_id: book,
      chapter_ref: "1",
      created_at: ago(5),
      part: null,
      language: "en",
      catalogue: null,
      catalogue_ref: null,
      coverage_model: null,
      withdrawn_at: null,
      title: `${subject} quiz ${cls}`,
      books: { subject },
    };
  };
  const generations = CLASSES.map(([cls]) => gen(cls));
  return {
    schools: [
      { id: SCH_A, config: { school_analytics: true, timetable_enabled: true, calendar: true } },
      { id: SCH_B, config: { school_analytics: true, timetable_enabled: true, calendar: true } },
    ],
    profiles: [
      ...Object.entries(STAFF).map(([id, [full_name, role, school_id]]) => ({ id, full_name, username: null, role, school_id })),
      ...LEARNERS.map(([id, cls, full_name, username]) => ({ id, full_name, username, role: "student", school_id: schoolOfClass(cls) })),
    ],
    coordinator_scope: [{ coordinator_id: "coord", school_id: SCH_A, grade: "5", subject: null }],
    entitlements: [
      { school_id: SCH_A, plan_key: "school", status: "active", active: true, current_period_end: "2027-03-31T00:00:00Z", updated_at: ago(40) },
      { school_id: SCH_B, plan_key: "school_plus", status: "trialing", active: true, current_period_end: "2026-12-15T00:00:00Z", updated_at: ago(20) },
    ],
    classes: CLASSES.map(([id, name, grade, teacher_id, school_id]) => ({ id, name, grade, teacher_id, school_id, created_at: ago(30) })),
    enrollments: LEARNERS.map(([sid, cls, full_name, username]) => ({
      class_id: cls,
      student_id: sid,
      // Parents' emails are in the rows on purpose: no answer may ever carry one.
      profiles: { full_name, username, parent_email: `parent.${sid}@family.example` },
    })),
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
      id: `sub-${sid}`,
      generation_id: `g-${cls}`,
      student_id: sid,
      auto_score: 8,
      max_score: 10,
      teacher_score: null,
      submitted_at: ago(1),
      graded_at: null,
      grade_status: "pending",
    })),
    generations,
    jobs: CLASSES.map(([cls]) => ({ id: `j-${cls}`, generation_id: `g-${cls}`, type: "quiz", status: "done", usage: { cost_usd: COST[cls], total_usd: COST[cls] }, created_at: ago(5) })),
    books: [
      { id: "bk-sci5", title: "Science Year 5", grade: "5", subject: "Science", school_id: SCH_A, owner_id: "ta1", removed_at: null },
      { id: "bk-math5", title: "Mathematics Year 5", grade: "5", subject: "Mathematics", school_id: SCH_A, owner_id: "ta2", removed_at: null },
      { id: "bk-sci6", title: "Science Year 6", grade: "6", subject: "Science", school_id: SCH_A, owner_id: "coord", removed_at: null },
      { id: "bk-eng4", title: "English Year 4", grade: "4", subject: "English", school_id: SCH_A, owner_id: "ta1", removed_at: null },
      // On the shelf, no kit made from it yet.
      { id: "bk-pj5", title: "Physical Education Year 5", grade: "5", subject: "Physical Education", school_id: SCH_A, owner_id: "ta2", removed_at: null },
      { id: "bk-b-sci5", title: "Science Year 5 (B)", grade: "5", subject: "Science", school_id: SCH_B, owner_id: "tb1", removed_at: null },
      { id: "bk-b-math6", title: "Mathematics Year 6 (B)", grade: "6", subject: "Mathematics", school_id: SCH_B, owner_id: "tb2", removed_at: null },
    ],
    timetable_slots: [
      // Wednesday P2: every class is in a lesson (who is teaching now).
      ...CLASSES.map(([cls, , , teacher, school, subject]) => ({ school_id: school, class_id: cls, day: 3, period: 2, subject, teacher_id: teacher, room: null, kind: "lesson" })),
      // Wednesday P3 (next): two of school A's classes, one of B's.
      { school_id: SCH_A, class_id: "c5a", day: 3, period: 3, subject: "History", teacher_id: "ta1", room: null, kind: "lesson" },
      { school_id: SCH_A, class_id: "c6c", day: 3, period: 3, subject: "Mathematics", teacher_id: "coord", room: null, kind: "lesson" },
      { school_id: SCH_B, class_id: "c5z", day: 3, period: 3, subject: "History", teacher_id: "tb1", room: null, kind: "lesson" },
      // Other days: subjects with no book (History 5) / a book but no kits (Physical Education 5) / grade 6 Art (out of a grade-5 scope).
      { school_id: SCH_A, class_id: "c5b", day: 1, period: 1, subject: "History", teacher_id: "ta2", room: null, kind: "lesson" },
      { school_id: SCH_A, class_id: "c5a", day: 2, period: 4, subject: "Physical Education", teacher_id: "ta1", room: null, kind: "lesson" },
      { school_id: SCH_A, class_id: "c6c", day: 4, period: 1, subject: "Art", teacher_id: "coord", room: null, kind: "lesson" },
      { school_id: SCH_B, class_id: "c6y", day: 2, period: 2, subject: "Geography", teacher_id: "tb2", room: null, kind: "lesson" },
    ],
    present_last_taught: [],
    parent_links: [],
    school_events: [],
  };
}

// ── The RLS views ────────────────────────────────────────────────────────────

export type GateView = "rls" | "leaky";

/** The rows the database's row rules would hand `who` (or everything, leaky). */
export function viewFor(who: GateUser, view: GateView, all: Record<string, Row[]> = gateTables()): Record<string, Row[]> {
  if (view === "leaky") return all;
  const s = who.schoolId;
  const principal = who.role === "school_admin";
  const scopeGrades = new Set(all.coordinator_scope.filter((r) => r.coordinator_id === who.id && r.school_id === s).map((r) => String(r.grade)));
  const classes = all.classes.filter((c) => c.school_id === s && (principal || scopeGrades.has(String(c.grade)) || c.teacher_id === who.id));
  const classIds = new Set(classes.map((c) => c.id));
  const enrollments = all.enrollments.filter((e) => classIds.has(e.class_id));
  const students = new Set(enrollments.map((e) => e.student_id));
  const shares = all.generation_shares.filter((x) => classIds.has(x.class_id));
  const gens = new Set<unknown>([...shares.map((x) => x.generation_id), ...all.generations.filter((g) => g.owner_id === who.id).map((g) => g.id)]);
  const generations = all.generations.filter((g) => (principal ? g.school_id === s : gens.has(g.id)));
  const genIds = new Set(generations.map((g) => g.id));
  const staffIds = new Set(all.profiles.filter((p) => p.school_id === s && p.role !== "student").map((p) => p.id));
  return {
    ...all,
    schools: all.schools.filter((x) => x.id === s),
    profiles: all.profiles.filter((p) => p.id === who.id || (principal ? p.school_id === s : staffIds.has(p.id) || students.has(p.id))),
    coordinator_scope: all.coordinator_scope.filter((r) => r.school_id === s && (principal || r.coordinator_id === who.id)),
    entitlements: principal ? all.entitlements.filter((e) => e.school_id === s) : [],
    classes,
    enrollments,
    generation_shares: shares,
    student_progress: all.student_progress.filter((p) => students.has(p.student_id)),
    submissions: all.submissions.filter((p) => students.has(p.student_id)),
    generations,
    jobs: all.jobs.filter((j) => genIds.has(j.generation_id)),
    books: all.books.filter((b) => b.school_id === s),
    timetable_slots: all.timetable_slots.filter((t) => t.school_id === s),
  };
}

// ── What would be a LEAK in each leader's answer ────────────────────────────

const SCHOOL_B_TOKENS = ["sch-b", "c5z", "c6y", "5 Zamrud", "6 Yakin", "Zara", "Zul", "Zaki", "Yasmin", "Yusuf", "Puan Zaleha", "Cikgu Zainal", "Cikgu Zubir", "g-c5z", "g-c6y", "sh-c5z", "sh-c6y", "bk-b-sci5", "bk-b-math6", "Geography", "school_plus", "trialing", "2026-12-15", "$5.00", "$7.50", "$2.50"];
const GRADE6_A_TOKENS = ["c6c", "6 Cemerlang", "Chandra", "Cahya", "Citra", "g-c6c", "sh-c6c", "bk-sci6", "Science Year 6", "Art"];
const GRADE4_A_TOKENS = ["c4d", "4 Dedikasi", "Danial", "Dewi", "g-c4d", "sh-c4d", "bk-eng4", "English Year 4"];
const LICENCE_A_TOKENS = ["2027-03-31", "31 Mar 2027"];
/** Never in any answer: parents' emails, an email username, any address. */
export const EMAIL_LEAK_RE = /[A-Za-z0-9._%+-]+@(?:family|mail)\.example/;

/** The strings that must never appear anywhere in this leader's turn (events
 *  and the capability results the model would read). */
export function forbiddenFor(who: GateUser): string[] {
  if (who.schoolId === SCH_B) return ["sch-a", "c5a", "c5b", "5 Amanah", "5 Bestari", "Amir", "Balqis", "Puan Rohana", "Cikgu Aminah", "Cikgu Bakar", "Cikgu Kamal", ...GRADE6_A_TOKENS, ...GRADE4_A_TOKENS, ...LICENCE_A_TOKENS];
  if (who.role === "school_admin") return SCHOOL_B_TOKENS;
  // The grade-5 coordinator: school B, school A's grade 4 and 6 (incl. their OWN grade-6 class), the licence.
  return [...SCHOOL_B_TOKENS, ...GRADE6_A_TOKENS, ...GRADE4_A_TOKENS, ...LICENCE_A_TOKENS];
}

// ── The session fake ─────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type Res = { data: unknown; error: null | { message: string }; count?: number | null };

/** A filter-honouring Supabase session over `tables`, signed in as `who`.
 *  Writes are recorded in `writes` and never change the tables. */
export function gateSession(who: GateUser, tables: Record<string, Row[]>) {
  const writes: Array<{ table: string; op: string; row: unknown }> = [];
  const log: string[] = [];
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let single = false;
    let head = false;
    let counting = false;
    let window: [number, number] | null = null;
    let cap = Infinity;
    let write: { op: string; row: unknown } | null = null;
    const b: any = {};
    const val = (r: Row, c: string) => r[c];
    b.select = (cols?: string, opts?: { count?: string; head?: boolean }) => {
      log.push(`${table}.select(${cols ?? ""})`);
      if (opts?.count) counting = true;
      if (opts?.head) head = true;
      return b;
    };
    b.eq = (c: string, v: unknown) => (filters.push((r) => val(r, c) === v), b);
    b.neq = (c: string, v: unknown) => (filters.push((r) => val(r, c) !== v), b);
    b.in = (c: string, list: unknown[]) => (filters.push((r) => list.includes(val(r, c))), b);
    b.is = (c: string, v: unknown) => (filters.push((r) => (v === null ? val(r, c) == null : val(r, c) === v)), b);
    b.gte = (c: string, v: unknown) => (filters.push((r) => val(r, c) != null && String(val(r, c)) >= String(v)), b);
    b.gt = (c: string, v: unknown) => (filters.push((r) => val(r, c) != null && String(val(r, c)) > String(v)), b);
    b.lte = (c: string, v: unknown) => (filters.push((r) => val(r, c) != null && String(val(r, c)) <= String(v)), b);
    b.lt = (c: string, v: unknown) => (filters.push((r) => val(r, c) != null && String(val(r, c)) < String(v)), b);
    b.ilike = (c: string, pattern: string) => {
      const rx = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "i");
      filters.push((r) => typeof val(r, c) === "string" && rx.test(val(r, c) as string));
      return b;
    };
    b.not = (c: string, op: string, v: unknown) => {
      if (op === "is" && v === null) filters.push((r) => val(r, c) != null);
      else if (op === "eq") filters.push((r) => val(r, c) !== v);
      return b;
    };
    // `.or()` is not modelled: no filter (a WIDER answer — the app must still cut).
    b.or = () => b;
    b.order = () => b;
    b.limit = (n: number) => ((cap = n), b);
    b.range = (a: number, z: number) => ((window = [a, z]), b);
    b.maybeSingle = () => ((single = true), b);
    b.single = b.maybeSingle;
    for (const op of ["insert", "update", "upsert", "delete"]) {
      b[op] = (row?: unknown) => {
        write = { op, row };
        return b;
      };
    }
    const run = (): Res => {
      if (write) {
        writes.push({ table, ...write });
        return { data: single ? { id: `gate-${writes.length}` } : null, error: null };
      }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const count = rows.length;
      if (window) rows = rows.slice(window[0], window[1] + 1);
      if (Number.isFinite(cap)) rows = rows.slice(0, cap);
      if (head) return { data: null, error: null, count };
      return { data: single ? (rows[0] ?? null) : rows, error: null, count: counting ? count : null };
    };
    b.then = (res: (v: Res) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej);
    return b;
  };
  return {
    log,
    writes,
    from,
    rpc: (fn: string, args?: Record<string, unknown>) => {
      log.push(`rpc.${fn}(${JSON.stringify(args ?? {})})`);
      return Promise.resolve({ data: null, error: null });
    },
    auth: { getUser: async () => ({ data: { user: { id: who.id, email: who.email, email_confirmed_at: "2026-01-01T00:00:00Z" } } }) },
  };
}

/** The admin client the turn route uses for the plan read, the audit sink and
 *  action tokens: plan "school", inserts recorded, token ids issued. */
export function gateAdmin() {
  const inserts: Array<{ table: string; row: unknown }> = [];
  let seq = 0;
  return {
    inserts,
    from: (table: string) => {
      const b: any = {
        insert: (row: unknown) => {
          inserts.push({ table, row });
          const id = `44444444-4444-4444-8444-${String(++seq).padStart(12, "0")}`;
          const p: any = Promise.resolve({ data: null, error: null });
          p.select = () => ({ single: async () => ({ data: { id }, error: null }) });
          return p;
        },
        select: () => b,
        is: () => Promise.resolve({ data: [], error: null }),
        eq: () => b,
        in: () => b,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return b;
    },
    rpc: async (fn: string) => (fn === "plan_tier" ? { data: "school", error: null } : { data: null, error: null }),
    auth: { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
