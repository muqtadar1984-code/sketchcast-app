// SK S5 slice C — the leader FIGURES: seats, cost, shelf gaps, trend (design
// 2026-10-29 decisions 5 and 6; Final Plan §4 principal / coordinator columns).
//
//   school.seats — principal hat + profiles.role school_admin ONLY (never a
//                  coordinator). Teacher / student / admin counts from
//                  profiles (profiles_read_self: a school_admin reads the
//                  whole school), and the licence row if one exists
//                  (entitlements_read_school is school_admin only). There is
//                  NO seat model: no limit is ever shown (decision 5).
//   school.cost  — principal (the school's generations) / coordinator (the
//                  generations SHARED to their scope classes, the same rule
//                  as RLS coordinates_generation, intersected in code). The
//                  money is jobs.usage folded by utils/kit-cost.ts
//                  kitCostReport — the console's fold, imported, not copied.
//                  Top 3 teachers by cost for the principal only.
//   school.gaps  — timetable subject × grade pairs (lesson slots of the
//                  school / the scope) with no relevant book on the school
//                  shelf (school-books.ts isRelevant, so "5" = "Grade 5" and
//                  "Sains" = "Science"), and pairs whose book has no kit yet.
//                  At most 8, most-taught first. Offers the school shelf.
//   school.trend — 4 ISO weeks (UTC) from generation_shares.due_at and
//                  submissions.submitted_at / graded_at, labelled
//                  "approximate". student_progress.updated_at is overwritten
//                  on every touch, so it is never used.
//
// Every one: tier immediate, kind read, the user-session client only (§2.3),
// cut through leaderScope (leader-scope.ts) and stripEmails at the boundary;
// deterministic text from school-figure-lines.ts (no model call).
//
// METERING (slice B): every entry here is named `school.*` exactly like
// school.health, and SCHOOL_FIGURE_CAPABILITY_NAMES lists them, so the shared
// 60/day leader counter recognises them by name.

import type { SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext, ResolvedEntity } from "../shell/types";
import { lineFor } from "../shell/lines";
import { S_EMPTY, S_NO_SCOPE, S_NOT_YET, S_OUT_OF_SCOPE, S_READ_FAILED } from "../shell/school-lines";
import {
  F_COST,
  F_COST_SINCE,
  F_COST_TOP,
  F_COST_TRACKING,
  F_GAP_NO_BOOK,
  F_GAP_NO_KITS,
  F_GAP_PERIODS,
  F_GAPS,
  F_GAPS_NO_TIMETABLE,
  F_GAPS_NONE,
  F_GAPS_OFFER,
  F_OPEN_SHELF,
  F_SEATS,
  F_SEATS_NO_LIMIT,
  F_SEATS_PLAN,
  F_SEATS_PRINCIPAL_ONLY,
  F_THIS_WEEK,
  F_TREND,
  F_TREND_NONE,
  F_TREND_WEEK,
  F_WEEK_OF,
} from "../shell/school-figure-lines";
import { cutLeaderRows, gradeLabel, gradeOutsideScope, leaderScope, needsSubjects, sameGrade, sameSubject, scopeLabel, stripEmails, whereLabel, type LeaderScope, type ScopeRow } from "./leader-scope";
import { generationSubjects, schoolHealthRows } from "./shared";
import { kitCostReport, USAGE_TRACKED_FROM, type CostGen, type CostJob, type GroupStats } from "@/utils/kit-cost";
import { canonicalSubjectWord, isRelevant } from "@/utils/school-books";
import { gradeLevel } from "@/utils/narration";
import { selectAll } from "@/utils/supabase/select-all";
import type { HealthRows } from "@/utils/school-health";

/** The slice-C leader reads, for slice B's school-read meter (all `school.*`). */
export const SCHOOL_FIGURE_CAPABILITY_NAMES = ["school.seats", "school.cost", "school.gaps", "school.trend"] as const;

const DAY = 86_400_000;
export const COST_DAYS = 30;
export const COST_TOP_TEACHERS = 3;
export const GAPS_MAX = 8;
export const TREND_WEEKS = 4;
/** Read caps (PostgREST pages of 1000): beyond these a figure says "partial". */
const GENS_MAX = 5000;
const JOBS_MAX = 10000;
const SLOTS_MAX = 5000;
const BOOK_IDS_CHUNK = 100;

type QueryResult = { data: unknown; error: { message?: string } | null; count?: number | null };

const str = (args: Record<string, unknown>, key: string, max = 40): string | undefined =>
  typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim().slice(0, max) : undefined;

const rows = <T>(res: QueryResult | null | undefined, what: string): T[] => {
  if (!res) return [];
  if (res.error) throw new Error(`${what}: ${res.error.message ?? "query failed"}`);
  return (res.data ?? []) as T[];
};

const usd = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const cents = (n: number) => Math.round(n * 100) / 100;

/** Intl tag for a SK locale (Jawi dates read as Malay; digits stay Western). */
function intlTag(locale: string): string {
  const l = (locale || "en").toLowerCase();
  if (l === "en") return "en-GB";
  if (l === "ms-arab") return "ms";
  return l;
}

/** "15 Oct 2026" (en), "15 Okt 2026" (ms) … always UTC, Western digits. */
export function fmtDate(ms: number, locale: string, withYear = true): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC", numberingSystem: "latn", ...(withYear ? { year: "numeric" } : {}) };
  try {
    return new Intl.DateTimeFormat(intlTag(locale), opts).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-GB", opts).format(new Date(ms));
  }
}

const notAnEmail = (s: string | null | undefined): string | null => (s && !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s) ? s : null);

// ── The shared leader gate ───────────────────────────────────────────────────

/** leaderScope for a slice-C read, or the early answer (no school / no scope /
 *  a grade outside the coordinator's scope). Pure. */
export function figureGate(ctx: SkContext, grade?: string): { ls: LeaderScope } | { early: SkCapabilityResult } {
  const locale = ctx.user.locale;
  const ls = leaderScope(ctx, { hatless: "leader" });
  if (ls.mode === "own" || !ls.schoolId) return { early: { ok: true, summary: lineFor(S_NO_SCOPE, locale), facts: [], entities: [] } };
  if (ls.mode === "scope" && !(ls.rows ?? []).length) return { early: { ok: true, summary: lineFor(S_NO_SCOPE, locale), facts: [], entities: [] } };
  if (gradeOutsideScope(ls, grade)) {
    return { early: { ok: true, summary: lineFor(S_OUT_OF_SCOPE, locale, { grade: whereLabel(ls, locale, grade), scope: scopeLabel(ls.rows ?? [], locale) }), facts: [], entities: [] } };
  }
  return { ls };
}

const failed = (ctx: SkContext, e: unknown): SkCapabilityResult => ({ ok: false, summary: lineFor(S_READ_FAILED, ctx.user.locale), error: e instanceof Error ? e.message : String(e) });

// ═══ school.seats ════════════════════════════════════════════════════════════

export type EntitlementRow = { plan_key: string; status: string | null; active: boolean | null; current_period_end: string | null; updated_at?: string | null };

/** The licence row to report: active first, then the latest period end. Pure. */
export function pickEntitlement(list: EntitlementRow[]): EntitlementRow | null {
  if (!list.length) return null;
  const t = (s: string | null | undefined) => (s ? Date.parse(s) || 0 : 0);
  return [...list].sort((a, b) => Number(!!b.active) - Number(!!a.active) || t(b.current_period_end) - t(a.current_period_end) || t(b.updated_at) - t(a.updated_at))[0];
}

export type SeatCounts = { teachers: number; students: number; admins: number };

/** The seats answer. Pure. */
export function seatsSummary(c: SeatCounts, ent: EntitlementRow | null, locale: string): string {
  const parts = [lineFor(F_SEATS, locale, { teachers: c.teachers, students: c.students, admins: c.admins })];
  if (ent) {
    parts.push(
      lineFor(F_SEATS_PLAN, locale, {
        plan: ent.plan_key,
        status: ent.status || (ent.active ? "active" : "inactive"),
        end: ent.current_period_end ? fmtDate(Date.parse(ent.current_period_end), locale) : lineFor(S_NOT_YET, locale),
      }),
    );
  }
  // Decision 5: there is no seat model, so no limit is ever claimed.
  parts.push(lineFor(F_SEATS_NO_LIMIT, locale));
  return parts.join(" ");
}

async function countRole(deps: SkCapabilityDeps, schoolId: string, role: string): Promise<number> {
  const res = (await deps.session.from("profiles").select("id", { count: "exact", head: true }).eq("school_id", schoolId).eq("role", role)) as QueryResult;
  if (res.error) throw new Error(`profiles: ${res.error.message ?? "query failed"}`);
  return typeof res.count === "number" ? res.count : 0;
}

export const schoolSeats: SkCapability = {
  meta: {
    name: "school.seats",
    description:
      "PRINCIPAL ONLY: how many teachers, students and school admins the school has (from profiles), and the school's licence (plan, status, period end) if one is recorded. No seat limit exists yet — never claim one.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    tier: "immediate",
    kind: "read",
    // Decision 5: the principal only — the school_admin ROLE and, with hats
    // on, the principal HAT. A coordinator never sees this entry.
    roles: ["school_admin"],
    hats: ["principal"],
    // S5 slice B: gated like school.health (ctx.flags.analytics); off → the
    // turn route's fixed analytics-off line, and the model is not offered it.
    flags: ["analytics"],
  },
  async handler(ctx, _args, deps) {
    const locale = ctx.user.locale;
    const ls = leaderScope(ctx, { hatless: "leader" });
    // Belt over the registry: only the school mode of a school_admin.
    if (ls.mode !== "school" || ctx.user.role !== "school_admin" || !ls.schoolId) {
      return { ok: true, summary: lineFor(F_SEATS_PRINCIPAL_ONLY, locale), facts: [], entities: [] };
    }
    const sid = ls.schoolId;
    try {
      const [teachers, students, admins, entRes] = await Promise.all([
        countRole(deps, sid, "teacher"),
        countRole(deps, sid, "student"),
        countRole(deps, sid, "school_admin"),
        deps.session.from("entitlements").select("plan_key, status, active, current_period_end, updated_at").eq("school_id", sid) as Promise<QueryResult>,
      ]);
      const ent = pickEntitlement(rows<EntitlementRow>(entRes, "entitlements"));
      const counts = { teachers, students, admins };
      return stripEmails({
        ok: true,
        summary: seatsSummary(counts, ent, locale),
        facts: [
          { row: "seats", scope: "school", teachers, students, admins, seatLimit: null },
          ...(ent ? [{ row: "licence", plan: ent.plan_key, status: ent.status, active: !!ent.active, periodEnd: ent.current_period_end }] : [{ row: "licence", plan: null, status: null, active: false, periodEnd: null }]),
        ],
        entities: [],
      });
    } catch (e) {
      return failed(ctx, e);
    }
  },
};

// ═══ school.cost ═════════════════════════════════════════════════════════════

/** A generation row as the cost read selects it (CostGen + its school). */
export type SchoolCostGen = CostGen & { school_id?: string | null };

export type CostWindowFigures = { kits: number; costed: number; usd: number; excluded: Array<{ reason: string; n: number }> };
export type SchoolCost = {
  last30: CostWindowFigures;
  since: CostWindowFigures;
  /** The 30-day window starts before USAGE_TRACKED_FROM. */
  startsBeforeTracking: boolean;
  /** Top teachers by 30-day cost (owner id, client-kit totalUsd, costed kits). */
  top: Array<{ ownerId: string; usd: number; kits: number }>;
};

const figuresOf = (g: GroupStats): CostWindowFigures => ({ kits: g.kits, costed: g.costed, usd: g.totalUsd, excluded: g.excluded });

/**
 * The cost fold for a leader. Pure. `gens` / `jobs` are already cut to the
 * school or the scope; the money is kit-cost.ts kitCostReport's CLIENT group
 * (generations without params.catalogue, one kit per book × chapter × part ×
 * language, kits started before USAGE_TRACKED_FROM excluded) — byte for byte
 * the console's fold. Top teachers: the same fold over each owner's own rows.
 */
export function schoolCostFold(input: { gens: readonly CostGen[]; jobs: readonly CostJob[]; nowMs: number; topN?: number }): SchoolCost {
  const start30 = input.nowMs - COST_DAYS * DAY;
  const tracked = Date.parse(USAGE_TRACKED_FROM);
  const fold = (gens: readonly CostGen[], from: number) => kitCostReport({ gens, jobs: input.jobs, topicKits: [], excludedOwners: new Set(), windowStartMs: from }).client;
  const last30 = fold(input.gens, start30);
  const since = fold(input.gens, tracked);
  const owners = [...new Set(input.gens.map((g) => g.owner_id))];
  const top = owners
    .map((ownerId) => {
      const c = fold(input.gens.filter((g) => g.owner_id === ownerId), start30);
      return { ownerId, usd: c.totalUsd, kits: c.costed };
    })
    .filter((t) => t.usd > 0)
    .sort((a, b) => b.usd - a.usd || a.ownerId.localeCompare(b.ownerId))
    .slice(0, input.topN ?? COST_TOP_TEACHERS);
  return { last30: figuresOf(last30), since: figuresOf(since), startsBeforeTracking: start30 < tracked, top };
}

/** The cost answer. Pure. `names` → the principal's top-teacher line. */
export function costSummary(c: SchoolCost, where: string, locale: string, names: Map<string, string> | null): string {
  const date = fmtDate(Date.parse(USAGE_TRACKED_FROM), locale);
  const parts = [
    lineFor(F_COST, locale, { where, kits: c.last30.kits, costed: c.last30.costed, usd: usd(c.last30.usd) }),
    lineFor(F_COST_SINCE, locale, { date, kits: c.since.kits, costed: c.since.costed, usd: usd(c.since.usd) }),
  ];
  if (c.startsBeforeTracking) parts.push(lineFor(F_COST_TRACKING, locale, { date }));
  if (names && c.top.length) {
    parts.push(lineFor(F_COST_TOP, locale, { items: c.top.map((t) => `${names.get(t.ownerId) ?? "Teacher"} ${usd(t.usd)} (${t.kits})`).join("; ") }));
  }
  return parts.join(" ");
}

/** The generation ids a coordinator's cost covers: those shared to an
 *  in-scope class (and, for a subject row, of that subject) — exactly RLS's
 *  coordinates_generation, so their OWN out-of-scope kits never count. Pure. */
export function scopeGenerationIds(health: HealthRows, ls: LeaderScope, subjectOf?: Map<string, string | null>): Set<string> {
  return new Set(cutLeaderRows(health, ls, { subjectOf }).shares.map((s) => s.generation_id));
}

const GEN_COLS =
  "id, owner_id, school_id, kind, book_id, chapter_ref, created_at, part:params->>part, language:params->>language, catalogue:params->>catalogue, catalogue_ref:params->>catalogue_ref, coverage_model:params->>coverage_model";

export const schoolCost: SkCapability = {
  meta: {
    name: "school.cost",
    description:
      "Generation cost (principal: the whole school; coordinator: kits shared to their scope grades and subjects): kits made and their recorded cost in USD over the last 30 days and since cost tracking began (15 Oct 2026); the principal also gets the top 3 teachers by cost. Same fold as the console's kit cost.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    tier: "immediate",
    kind: "read",
    roles: ["school_admin", "coordinator"],
    hats: ["principal", "coordinator"],
    // S5 slice B: gated like school.health (ctx.flags.analytics); off → the
    // turn route's fixed analytics-off line, and the model is not offered it.
    flags: ["analytics"],
  },
  async handler(ctx, _args, deps) {
    const me = ctx.user.id;
    const locale = ctx.user.locale;
    const gate = figureGate(ctx);
    if ("early" in gate) return gate.early;
    const ls = gate.ls;
    try {
      const nowMs = deps.now.getTime();
      // A kit is dated by its FIRST piece: read a week before the earlier
      // window start, as the console does, so earlier pieces are seen.
      const from = new Date(Math.min(nowMs - COST_DAYS * DAY, Date.parse(USAGE_TRACKED_FROM)) - 7 * DAY).toISOString();
      const [gensRes, jobsRes] = await Promise.all([
        selectAll<SchoolCostGen>(() => deps.session.from("generations").select(GEN_COLS).gte("created_at", from), { max: GENS_MAX }),
        selectAll<CostJob>(() => deps.session.from("jobs").select("id, generation_id, type, status, usage, created_at").gte("created_at", from), { max: JOBS_MAX }),
      ]);
      if (gensRes.error) throw new Error(`generations: ${gensRes.error.message}`);
      if (jobsRes.error) throw new Error(`jobs: ${jobsRes.error.message}`);
      let gens = gensRes.data.filter((g) => g.school_id === ls.schoolId);
      if (ls.mode === "scope") {
        const all = await schoolHealthRows(deps, me);
        const subjectOf = needsSubjects(ls) ? await generationSubjects(deps, me, all.shares.map((s) => s.generation_id)) : undefined;
        const ids = scopeGenerationIds(all, ls, subjectOf);
        gens = gens.filter((g) => ids.has(g.id));
      }
      const genIds = new Set(gens.map((g) => g.id));
      const jobs = jobsRes.data.filter((j) => j.generation_id !== null && genIds.has(j.generation_id));
      const fold = schoolCostFold({ gens, jobs, nowMs });
      let names: Map<string, string> | null = null;
      if (ls.mode === "school") {
        names = new Map();
        const ids = fold.top.map((t) => t.ownerId);
        if (ids.length) {
          for (const p of rows<{ id: string; full_name: string | null; username: string | null }>(await deps.session.from("profiles").select("id, full_name, username").in("id", ids), "profiles")) {
            names.set(p.id, notAnEmail(p.full_name) || notAnEmail(p.username) || "Teacher");
          }
        }
      }
      const where = whereLabel(ls, locale);
      const partial = gensRes.data.length >= GENS_MAX || jobsRes.data.length >= JOBS_MAX;
      const facts: Array<Record<string, string | number | boolean | null>> = [
        { row: "window", scope: ls.mode, where, window: "last_30_days", kits: fold.last30.kits, costed: fold.last30.costed, usd: cents(fold.last30.usd), partial },
        { row: "window", scope: ls.mode, where, window: "since_tracking", from: USAGE_TRACKED_FROM.slice(0, 10), kits: fold.since.kits, costed: fold.since.costed, usd: cents(fold.since.usd), partial },
      ];
      for (const x of fold.last30.excluded) facts.push({ row: "excluded", window: "last_30_days", reason: x.reason, kits: x.n });
      if (names) for (const t of fold.top) facts.push({ row: "teacher", name: names.get(t.ownerId) ?? "Teacher", usd: cents(t.usd), kits: t.kits });
      return stripEmails({ ok: true, summary: costSummary(fold, where, locale, names).slice(0, 900), facts, entities: [] });
    } catch (e) {
      return failed(ctx, e);
    }
  },
};

// ═══ school.gaps ═════════════════════════════════════════════════════════════

export type GapSlot = { class_id: string; subject: string | null; kind?: string | null };
export type GapClass = { id: string; grade: string | null; school_id?: string | null };
export type GapBook = { id: string; title?: string | null; grade: string | null; subject: string | null };
export type Gap = { subject: string; grade: string; periods: number; kind: "no_book" | "no_kits"; books: GapBook[] };
export type GapsResult = { pairs: number; gaps: Gap[]; slots: number };

const fold = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * Timetable pairs vs the shelf. Pure, deterministic. Slots are cut to lesson
 * slots of the leader's classes (school: classes of the school; scope: a
 * class of a scope grade, and, for a scope row with a subject, a slot of that
 * subject — as timetable.now_next's leader mode). A pair is (canonical
 * subject, normalised grade level); a book covers it when school-books'
 * isRelevant says so for that one grade and subject. `kitBooks` = books with
 * at least one generation. At most GAPS_MAX, most periods first.
 */
export function computeGaps(input: { slots: GapSlot[]; classes: GapClass[]; books: GapBook[]; kitBooks: Set<string>; ls: LeaderScope; grade?: string }): GapsResult {
  const { ls } = input;
  const scopeRows: ScopeRow[] = ls.rows ?? [];
  const classById = new Map(
    input.classes
      .filter((c) => !!ls.schoolId && c.school_id === ls.schoolId && (ls.mode === "school" || scopeRows.some((r) => sameGrade(c.grade, r.grade))) && (!input.grade || sameGrade(c.grade, input.grade)))
      .map((c) => [c.id, c] as const),
  );
  type Pair = { subject: string; grade: string; periods: number; order: number };
  const pairs = new Map<string, Pair>();
  let slots = 0;
  for (const s of input.slots) {
    if ((s.kind ?? "lesson") !== "lesson") continue;
    const c = classById.get(s.class_id);
    const subject = fold(s.subject);
    const grade = fold(c?.grade);
    if (!c || !subject || !grade) continue;
    if (ls.mode === "scope" && !scopeRows.some((r) => sameGrade(c.grade, r.grade) && (r.subject === null || sameSubject(subject, r.subject)))) continue;
    slots++;
    const level = gradeLevel(grade);
    const key = `${level ?? grade.toLowerCase()}|${canonicalSubjectWord(subject) || subject.toLowerCase()}`;
    const p = pairs.get(key);
    if (p) p.periods++;
    else pairs.set(key, { subject, grade, periods: 1, order: pairs.size });
  }
  const gaps: Gap[] = [];
  for (const p of pairs.values()) {
    const books = input.books.filter((b) => isRelevant({ grade: b.grade, subject: b.subject }, { grades: [p.grade], subjects: [p.subject] }));
    if (!books.length) gaps.push({ subject: p.subject, grade: p.grade, periods: p.periods, kind: "no_book", books: [] });
    else if (!books.some((b) => input.kitBooks.has(b.id))) gaps.push({ subject: p.subject, grade: p.grade, periods: p.periods, kind: "no_kits", books });
  }
  const levelOf = (g: string) => gradeLevel(g) ?? 99;
  gaps.sort((a, b) => b.periods - a.periods || (a.kind === b.kind ? 0 : a.kind === "no_book" ? -1 : 1) || a.subject.localeCompare(b.subject) || levelOf(a.grade) - levelOf(b.grade) || a.grade.localeCompare(b.grade));
  return { pairs: pairs.size, gaps: gaps.slice(0, GAPS_MAX), slots };
}

export const SCHOOL_SHELF_PATH = "/dashboard/school/books";

/** The gaps answer. Pure. */
export function gapsSummary(r: GapsResult, where: string, locale: string): string {
  if (!r.slots) return lineFor(F_GAPS_NO_TIMETABLE, locale, { where });
  if (!r.gaps.length) return lineFor(F_GAPS_NONE, locale, { where, pairs: r.pairs });
  const items = r.gaps
    .map((g) => `${g.subject}, ${gradeLabel(g.grade, locale)} — ${lineFor(g.kind === "no_book" ? F_GAP_NO_BOOK : F_GAP_NO_KITS, locale)} (${lineFor(F_GAP_PERIODS, locale, { n: g.periods })})`)
    .join("; ");
  return `${lineFor(F_GAPS, locale, { where, n: r.gaps.length, items })} ${lineFor(F_GAPS_OFFER, locale)}`;
}

export const schoolGaps: SkCapability = {
  meta: {
    name: "school.gaps",
    description:
      "Shelf gaps (principal: the school; coordinator: their scope grades): timetabled subject and grade pairs with no relevant book on the school shelf, and pairs whose book has no kits yet — at most 8, most-taught first. Optionally one grade. To add a book the leader opens the school shelf (navigate target school_books).",
    parameters: {
      type: "object",
      properties: { grade: { type: "string", description: "Only this grade, e.g. \"5\" or \"Form 2\" (a coordinator: one of their scope grades)." } },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["school_admin", "coordinator"],
    hats: ["principal", "coordinator"],
    // S5 slice B: gated like school.health (ctx.flags.analytics); off → the
    // turn route's fixed analytics-off line, and the model is not offered it.
    flags: ["analytics"],
  },
  async handler(ctx, args, deps) {
    const locale = ctx.user.locale;
    const grade = str(args, "grade", 20);
    const gate = figureGate(ctx, grade);
    if ("early" in gate) return gate.early;
    const ls = gate.ls;
    const sid = ls.schoolId as string;
    try {
      const [slotsRes, classesRes, booksRes] = await Promise.all([
        selectAll<GapSlot>(() => deps.session.from("timetable_slots").select("class_id, subject, kind").eq("school_id", sid), { max: SLOTS_MAX }),
        deps.session.from("classes").select("id, grade, school_id").eq("school_id", sid) as Promise<QueryResult>,
        selectAll<GapBook>(() => deps.session.from("books").select("id, title, grade, subject").eq("school_id", sid).is("removed_at", null), { max: GENS_MAX }),
      ]);
      if (slotsRes.error) throw new Error(`timetable_slots: ${slotsRes.error.message}`);
      if (booksRes.error) throw new Error(`books: ${booksRes.error.message}`);
      const classes = rows<GapClass>(classesRes, "classes");
      const books = booksRes.data;
      // Which shelf books already have a kit: only the books that cover a
      // pair matter, so compute without kits first and read those books.
      const first = computeGaps({ slots: slotsRes.data, classes, books, kitBooks: new Set(), ls, grade });
      const candidates = [...new Set(first.gaps.flatMap((g) => g.books.map((b) => b.id)))].sort();
      const kitBooks = new Set<string>();
      for (let i = 0; i < candidates.length; i += BOOK_IDS_CHUNK) {
        const chunk = candidates.slice(i, i + BOOK_IDS_CHUNK);
        const res = await selectAll<{ book_id: string | null }>(() => deps.session.from("generations").select("book_id").in("book_id", chunk), { max: GENS_MAX });
        if (res.error) throw new Error(`generations: ${res.error.message}`);
        for (const g of res.data) if (g.book_id) kitBooks.add(g.book_id);
      }
      const r = computeGaps({ slots: slotsRes.data, classes, books, kitBooks, ls, grade });
      const where = whereLabel(ls, locale, grade);
      const label = lineFor(F_OPEN_SHELF, locale);
      const facts: Array<Record<string, string | number | boolean | null>> = r.gaps.map((g) => ({
        row: "gap",
        subject: g.subject,
        grade: g.grade,
        kind: g.kind,
        periodsPerWeek: g.periods,
        books: g.books.map((b) => b.title || "Book").join(", ") || null,
      }));
      facts.unshift({ row: "totals", scope: ls.mode, where, pairs: r.pairs, gaps: r.gaps.length, lessonSlots: r.slots });
      // The offer: the existing navigate target (design decision 3 — adding a
      // book is the shelf's own upload). Facts only; nothing navigates unasked.
      if (r.gaps.length) facts.push({ row: "offer", target: "school_books", path: SCHOOL_SHELF_PATH, label });
      const entities: ResolvedEntity[] = r.gaps
        .filter((g) => g.kind === "no_kits")
        .flatMap((g) => g.books)
        .slice(0, GAPS_MAX)
        .map((b) => ({ kind: "book" as const, id: b.id, label: b.title || "Book", via: "school.gaps" }));
      return stripEmails({ ok: true, summary: gapsSummary(r, where, locale).slice(0, 900), facts, entities });
    } catch (e) {
      return failed(ctx, e);
    }
  },
};

// ═══ school.trend ════════════════════════════════════════════════════════════

export type TrendWeek = {
  /** ISO week label, "2026-W44". */
  week: string;
  /** Monday 00:00 UTC of the week. */
  startMs: number;
  /** The current week (counted up to now). */
  partial: boolean;
  /** Learner × class-share pairs due in the week. */
  due: number;
  /** Submissions submitted in the week. */
  submitted: number;
  /** Of the pairs due so far in the week, % submitted by the due time (null: none due yet). */
  onTimePct: number | null;
  /** Submissions awaiting a teacher's mark at the week's end (or now). */
  pending: number;
};

/** Monday 00:00 UTC of the ISO week holding `ms`. Pure. */
export function isoWeekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY;
}

/** "2026-W44" for the ISO week starting at `mondayMs`. Pure. */
export function isoWeekLabel(mondayMs: number): string {
  const thursday = new Date(mondayMs + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - jan1) / (7 * DAY));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The approximate 4-week trend from rows already cut to the school or the
 * scope (cutLeaderRows). Pure, UTC weeks, oldest first, the current week last.
 *   due       — (class share with due_at in the week) × its class's learners
 *   submitted — submissions whose submitted_at falls in the week
 *   on time   — of the pairs whose due_at has passed, the share with a
 *               submission for that generation at or before due_at
 *   awaiting  — at the week's end (now for this week): submitted, needing a
 *               teacher's mark (grade_status pending now, or graded later
 *               than that moment); auto-marked work never waits
 */
export function computeTrend(rows: HealthRows, nowMs: number, weeks = TREND_WEEKS): TrendWeek[] {
  const thisMonday = isoWeekStart(nowMs);
  const learnersOf = new Map<string, string[]>();
  for (const e of rows.enrollments) (learnersOf.get(e.class_id) ?? learnersOf.set(e.class_id, []).get(e.class_id)!).push(e.student_id);
  const firstSubmit = new Map<string, number>();
  for (const s of rows.submissions) {
    const t = Date.parse(s.submitted_at);
    if (!Number.isFinite(t)) continue;
    const k = `${s.generation_id}|${s.student_id}`;
    const prev = firstSubmit.get(k);
    if (prev === undefined || t < prev) firstSubmit.set(k, t);
  }
  const out: TrendWeek[] = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const ws = thisMonday - k * 7 * DAY;
    const we = ws + 7 * DAY;
    const end = Math.min(we, nowMs);
    let due = 0;
    let dueSoFar = 0;
    let onTime = 0;
    for (const s of rows.shares) {
      if (!s.class_id || !s.due_at) continue;
      const d = Date.parse(s.due_at);
      if (!Number.isFinite(d) || d < ws || d >= we) continue;
      for (const sid of learnersOf.get(s.class_id) ?? []) {
        due++;
        if (d > nowMs) continue;
        dueSoFar++;
        const t = firstSubmit.get(`${s.generation_id}|${sid}`);
        if (t !== undefined && t <= d) onTime++;
      }
    }
    let submitted = 0;
    let pending = 0;
    for (const s of rows.submissions) {
      const t = Date.parse(s.submitted_at);
      if (!Number.isFinite(t)) continue;
      if (t >= ws && t < we) submitted++;
      if (t >= end) continue;
      const graded = s.graded_at ? Date.parse(s.graded_at) : NaN;
      if (s.grade_status === "pending" || (s.grade_status === "graded" && Number.isFinite(graded) && graded >= end)) pending++;
    }
    out.push({ week: isoWeekLabel(ws), startMs: ws, partial: k === 0, due, submitted, onTimePct: dueSoFar ? Math.round((onTime / dueSoFar) * 100) : null, pending });
  }
  return out;
}

/** The trend answer. Pure. */
export function trendSummary(weeks: TrendWeek[], where: string, locale: string): string {
  if (!weeks.some((w) => w.due || w.submitted || w.pending)) return lineFor(F_TREND_NONE, locale, { where });
  const items = weeks
    .map((w) =>
      lineFor(F_TREND_WEEK, locale, {
        week: w.partial ? lineFor(F_THIS_WEEK, locale) : lineFor(F_WEEK_OF, locale, { date: fmtDate(w.startMs, locale, false) }),
        due: w.due,
        submitted: w.submitted,
        onTime: w.onTimePct === null ? lineFor(S_NOT_YET, locale) : `${w.onTimePct}%`,
        pending: w.pending,
      }),
    )
    .join("; ");
  return lineFor(F_TREND, locale, { where, items });
}

export const schoolTrend: SkCapability = {
  meta: {
    name: "school.trend",
    description:
      "An APPROXIMATE 4-week trend (principal: the school; coordinator: their scope grades), from due dates and submission dates — per ISO week: work due, work submitted, % on time, awaiting marking at the week's end. Optionally one grade. Always say it is approximate.",
    parameters: {
      type: "object",
      properties: { grade: { type: "string", description: "Only this grade, e.g. \"5\" or \"Form 2\" (a coordinator: one of their scope grades)." } },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["school_admin", "coordinator"],
    hats: ["principal", "coordinator"],
    // S5 slice B: gated like school.health (ctx.flags.analytics); off → the
    // turn route's fixed analytics-off line, and the model is not offered it.
    flags: ["analytics"],
  },
  async handler(ctx, args, deps) {
    const me = ctx.user.id;
    const locale = ctx.user.locale;
    const grade = str(args, "grade", 20);
    const gate = figureGate(ctx, grade);
    if ("early" in gate) return gate.early;
    const ls = gate.ls;
    try {
      const all = await schoolHealthRows(deps, me);
      const subjectOf = needsSubjects(ls) ? await generationSubjects(deps, me, all.shares.map((s) => s.generation_id)) : undefined;
      const cut = cutLeaderRows(all, ls, { grade, subjectOf });
      const where = whereLabel(ls, locale, grade);
      if (!cut.classes.length) return { ok: true, summary: lineFor(S_EMPTY, locale, { where }), facts: [], entities: [] };
      const weeks = computeTrend(cut, deps.now.getTime());
      const facts: Array<Record<string, string | number | boolean | null>> = weeks.map((w) => ({
        row: "week",
        scope: ls.mode,
        where,
        week: w.week,
        from: new Date(w.startMs).toISOString().slice(0, 10),
        partial: w.partial,
        due: w.due,
        submitted: w.submitted,
        onTimePct: w.onTimePct,
        awaitingMarking: w.pending,
        approximate: true,
      }));
      return stripEmails({ ok: true, summary: trendSummary(weeks, where, locale).slice(0, 900), facts, entities: [] });
    } catch (e) {
      return failed(ctx, e);
    }
  },
};

export const SCHOOL_FIGURE_CAPABILITIES: SkCapability[] = [schoolSeats, schoolCost, schoolGaps, schoolTrend];
