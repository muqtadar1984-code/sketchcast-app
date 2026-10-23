// The Fix Agent's board (Library → Fixes v2): the rules behind the trend
// strip, the filters, the cause groups, the queue line and the re-check
// badge. Pure — no server imports — so the server page (which builds the
// rows), the client board (which filters and groups them) and the tests all
// read the same rules. The case rules themselves (statuses, the decision,
// the defensive JSON readers) are in ./fix-cases.ts.

import { findingsOf, isOpen, type FixCase } from "./fix-cases";

// ── the cause of a failure ───────────────────────────────────────────────────

export type CauseKey = "reply_shape" | "quiz_item" | "maths_question" | "numbers" | "throttle" | "diagnosis_failed" | "review" | "other";
export type Cause = { key: CauseKey; label: string };

export const CAUSE_LABEL: Record<CauseKey, string> = {
  reply_shape: "Model reply shape",
  quiz_item: "Quiz item dropped",
  maths_question: "Maths in the question",
  numbers: "Numbers differ",
  throttle: "Throttled",
  diagnosis_failed: "Diagnosis failed",
  review: "Rejected in review",
  other: "Other",
};

export const CAUSE_KEYS = Object.keys(CAUSE_LABEL) as CauseKey[];

const cause = (key: CauseKey): Cause => ({ key, label: CAUSE_LABEL[key] });

// Tried in this order on ONE message. "diagnosis failed: <why>" names the
// agent's failure, whatever the why says; a quiz message carries
// "(numbers differ; …)" in brackets and a maths message is a sharper
// "numbers differ", so both come before the plain numbers rule.
const PATTERNS: [CauseKey, RegExp][] = [
  ["diagnosis_failed", /diagnosis failed/i],
  ["quiz_item", /quiz question\(s\) have no staged translation/i],
  ["maths_question", /maths in the (question|stem) altered/i],
  ["numbers", /numbers differ/i],
  ["reply_shape", /did not return \d+ items/i],
  ["throttle", /\b429\b|rate[ -]?limit|resource[ _]?exhausted|overloaded/i],
];

function match(text: unknown): CauseKey | null {
  if (typeof text !== "string" || !text.trim()) return null;
  for (const [key, re] of PATTERNS) if (re.test(text)) return key;
  return null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

const REVIEW_FAILED = new Set(["rejected", "failed"]);

/** Why a case failed, as one of a handful of causes. The CURRENT failure
 *  first — the retry's error (outcome.error), then a retried kit rejected or
 *  failed in review with no job error, then the case's issue — and only then
 *  the agent's diagnosis and the evidence findings' `what`. */
export function causeOf(row: Pick<FixCase, "issue" | "outcome" | "diagnosis" | "evidence"> | null | undefined): Cause {
  const outcome = obj(row?.outcome);
  const fromOutcome = match(outcome.error);
  if (fromOutcome) return cause(fromOutcome);
  if (!str(outcome.error) && (REVIEW_FAILED.has(String(outcome.kit_status)) || REVIEW_FAILED.has(String(outcome.translation_status)))) return cause("review");
  const fromIssue = match(row?.issue);
  if (fromIssue) return cause(fromIssue);
  const fromDiagnosis = match(obj(row?.diagnosis).explanation);
  if (fromDiagnosis) return cause(fromDiagnosis);
  for (const f of findingsOf(row?.evidence)) {
    const k = match(f.what);
    if (k) return cause(k);
  }
  return cause("other");
}

// ── the worker's re-check against the current code ──────────────────────────

/** "Passes with the current check" when the re-check accepts every saved
 *  pair; "Fixed in #316" when a known fixed pattern matched; both in one
 *  badge when both hold; null when neither (or no re-check yet). */
export function recheckBadge(row: Pick<FixCase, "evidence"> | null | undefined): string | null {
  const r = obj(obj(row?.evidence).recheck);
  const passes = r.passes === true;
  const fixedBy = str(r.fixed_by);
  if (passes && fixedBy) return `Passes with the current check (${fixedBy})`;
  if (passes) return "Passes with the current check";
  if (fixedBy) return `Fixed in ${fixedBy}`;
  return null;
}

/** A group's badge: only when EVERY open row in it carries one. The shared
 *  label when they agree, else a summary. Null for a group with no open row. */
export function groupBadge(rows: readonly { status: string; badge: string | null }[]): string | null {
  const open = rows.filter((r) => isOpen(r));
  if (!open.length || open.some((r) => !r.badge)) return null;
  const labels = new Set(open.map((r) => r.badge));
  return labels.size === 1 ? (open[0].badge as string) : "Every open case passes or is fixed";
}

// ── the queue of approved cases ─────────────────────────────────────────────

/** Minutes one translation takes, roughly (10–20 min). */
export const MINUTES_PER_RETRY = 15;

export type QueueSpot = { position: number; etaMinutes: number; label: string };

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

export function minutesLabel(m: number): string {
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `~${h} h ${rest} min` : `~${h} h`;
}

const ms = (iso: unknown): number => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** Each approved case's place in line. The worker takes approved cases ONE
 *  AT A TIME, oldest created_at first, so a case's position is its rank among
 *  the approved ones — behind any case already retrying ('applied'). */
export function queueInfo(rows: readonly Pick<FixCase, "id" | "status" | "created_at">[]): Record<string, QueueSpot> {
  const ahead = rows.filter((r) => r.status === "applied").length;
  const approved = rows.filter((r) => r.status === "approved").sort((a, b) => ms(a.created_at) - ms(b.created_at) || a.id.localeCompare(b.id));
  const out: Record<string, QueueSpot> = {};
  approved.forEach((r, i) => {
    const position = ahead + i + 1;
    const etaMinutes = position * MINUTES_PER_RETRY;
    out[r.id] = { position, etaMinutes, label: `${ordinal(position)} in line · ${minutesLabel(etaMinutes)}` };
  });
  return out;
}

// ── a retry's job ───────────────────────────────────────────────────────────

export type JobLite = { status?: string | null; progress?: number | string | null; stage?: unknown };
export type Progress = { text: string; pct: number | null };

/** "script 40%" for a running retry; "queued" before the worker claims it. */
export function progressOf(job: JobLite | null | undefined): Progress | null {
  if (!job || typeof job.status !== "string") return null;
  const raw = num(job.progress);
  const pct = raw === undefined ? null : Math.max(0, Math.min(100, Math.round(raw)));
  const step = str(obj(job.stage).step) ?? (typeof job.stage === "string" ? str(job.stage) : undefined);
  if (job.status === "queued") return { text: "queued", pct: 0 };
  if (job.status === "processing") {
    const text = [step ?? "working", pct === null ? null : `${pct}%`].filter(Boolean).join(" ");
    return { text, pct };
  }
  if (job.status === "completed") return { text: "finishing", pct: 100 };
  return { text: job.status, pct };
}

// ── the trend strip ─────────────────────────────────────────────────────────

export type WeekStats = {
  failures: number;
  fixed: number;
  /** fixed / failures as a whole percent; null with no failures */
  rate: number | null;
  /** the mean cost_usd of the fixed cases that carry one; null when none */
  avgCostUsd: number | null;
  byCause: (Cause & { count: number })[];
};

export const WEEK_MS = 7 * 86_400_000;

/** The last 7 days: cases opened, how many of those reached review, what a
 *  fixed one cost, and the top three causes. */
export function weekStats(rows: readonly Pick<FixCase, "status" | "created_at" | "cost_usd" | "issue" | "outcome" | "diagnosis" | "evidence">[], nowMs: number): WeekStats {
  const since = nowMs - WEEK_MS;
  const week = rows.filter((r) => {
    const t = ms(r.created_at);
    return t >= since && t <= nowMs;
  });
  const fixed = week.filter((r) => r.status === "resolved");
  const costs = fixed.map((r) => num(r.cost_usd)).filter((n): n is number => n !== undefined);
  const counts = new Map<CauseKey, number>();
  for (const r of week) {
    const k = causeOf(r).key;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const byCause = [...counts]
    .map(([key, count]) => ({ ...cause(key), count }))
    .sort((a, b) => b.count - a.count || CAUSE_KEYS.indexOf(a.key) - CAUSE_KEYS.indexOf(b.key))
    .slice(0, 3);
  return {
    failures: week.length,
    fixed: fixed.length,
    rate: week.length ? Math.round((fixed.length / week.length) * 100) : null,
    avgCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
    byCause,
  };
}

// ── the board's rows ────────────────────────────────────────────────────────

/** One case as the client board needs it: plain data only (the case's full
 *  detail is rendered on the server and travels beside it). */
export type BoardRow = {
  id: string;
  status: string;
  title: string;
  topicId: string | null;
  topicTitle: string | null;
  language: string | null;
  cause: Cause;
  badge: string | null;
  /** an approved case's place in line */
  queue: string | null;
  /** a retrying case's job */
  progress: Progress | null;
  createdAt: string | null;
};

export function boardRows(
  cases: readonly FixCase[],
  topics: Record<string, string>,
  jobs: Record<string, JobLite>,
): BoardRow[] {
  const queue = queueInfo(cases);
  return cases.map((c) => ({
    id: c.id,
    status: String(c.status ?? ""),
    title: c.title || "Untitled case",
    topicId: c.topic_id ?? null,
    topicTitle: (c.topic_id && topics[c.topic_id]) || null,
    language: c.language ?? null,
    cause: causeOf(c),
    badge: recheckBadge(c),
    queue: queue[c.id]?.label ?? null,
    progress: c.status === "applied" ? (progressOf(c.applied_job_id ? jobs[c.applied_job_id] : null) ?? { text: "starting", pct: null }) : null,
    createdAt: c.created_at ?? null,
  }));
}

// ── filters ─────────────────────────────────────────────────────────────────

export const STATUS_FILTERS = [
  { key: "open", label: "Open" },
  { key: "waiting", label: "Waiting for you" },
  { key: "needs_you", label: "Needs you" },
  { key: "approved", label: "Approved" },
  { key: "retrying", label: "Retrying" },
  { key: "in_review", label: "In review" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number]["key"];

const STATUS_OF: Partial<Record<StatusFilter, string>> = {
  waiting: "proposed",
  needs_you: "needs_founder",
  approved: "approved",
  retrying: "applied",
  in_review: "resolved",
  rejected: "rejected",
};

export function matchesStatus(status: unknown, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "open") return isOpen({ status });
  return status === STATUS_OF[filter];
}

export type BoardView = "grouped" | "list";
export type BoardParams = { status: StatusFilter; cause: string; lang: string; q: string; view: BoardView };
export const DEFAULT_PARAMS: BoardParams = { status: "open", cause: "", lang: "", q: "", view: "grouped" };

const isStatusFilter = (v: unknown): v is StatusFilter => STATUS_FILTERS.some((s) => s.key === v);
const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

/** The board's state from the URL (?status=&cause=&lang=&q=&view=); anything
 *  unknown falls back to the default (Open, grouped). */
export function parseBoardParams(sp: Record<string, string | string[] | undefined> | null | undefined): BoardParams {
  const s = sp ?? {};
  const status = first(s.status).trim();
  const causeKey = first(s.cause).trim();
  const view = first(s.view).trim();
  return {
    status: isStatusFilter(status) ? status : DEFAULT_PARAMS.status,
    cause: (CAUSE_KEYS as string[]).includes(causeKey) ? causeKey : "",
    lang: first(s.lang).trim().slice(0, 16),
    q: first(s.q).trim().slice(0, 100),
    view: view === "list" ? "list" : "grouped",
  };
}

/** The query string for `p` — defaults left out, "" when all are defaults. */
export function boardQuery(p: BoardParams): string {
  const qs = new URLSearchParams();
  if (p.status !== DEFAULT_PARAMS.status) qs.set("status", p.status);
  if (p.cause) qs.set("cause", p.cause);
  if (p.lang) qs.set("lang", p.lang);
  if (p.q.trim()) qs.set("q", p.q.trim());
  if (p.view !== DEFAULT_PARAMS.view) qs.set("view", p.view);
  const s = qs.toString();
  return s ? `?${s}` : "";
}

type Filterable = { status: string; cause: Cause; language: string | null; topicTitle: string | null; title: string };

export function filterCases<T extends Filterable>(rows: readonly T[], f: Partial<Pick<BoardParams, "status" | "cause" | "lang" | "q">>): T[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return rows.filter(
    (r) =>
      matchesStatus(r.status, f.status ?? "open") &&
      (!f.cause || r.cause.key === f.cause) &&
      (!f.lang || r.language === f.lang) &&
      (!q || `${r.topicTitle ?? ""}\n${r.title}`.toLowerCase().includes(q)),
  );
}

/** The chips' counts: each facet counted under the OTHER filters. */
export function facetCounts<T extends Filterable>(rows: readonly T[], p: Pick<BoardParams, "status" | "cause" | "lang" | "q">) {
  const status = Object.fromEntries(STATUS_FILTERS.map((s) => [s.key, filterCases(rows, { ...p, status: s.key }).length])) as Record<StatusFilter, number>;
  const causeRows = filterCases(rows, { ...p, cause: "" });
  const causes = CAUSE_KEYS.map((key) => ({ ...cause(key), count: causeRows.filter((r) => r.cause.key === key).length })).filter((c) => c.count > 0);
  const langRows = filterCases(rows, { ...p, lang: "" });
  const langMap = new Map<string, number>();
  for (const r of langRows) if (r.language) langMap.set(r.language, (langMap.get(r.language) ?? 0) + 1);
  const langs = [...langMap].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return { status, causes, causeTotal: causeRows.length, langs, langTotal: langRows.length };
}

// ── groups ──────────────────────────────────────────────────────────────────

export type CaseGroup<T> = { key: string; label: string; rows: T[]; waiting: number; needsYou: number };

/** Rows by cause: groups holding a case that waits for the founder (or needs
 *  them) first, then the bigger groups; resolved cases go to one final
 *  "Resolved" group (present only when the status filter shows them). Rows
 *  keep their order inside a group. */
export function groupByCause<T extends { status: string; cause: Cause }>(rows: readonly T[]): CaseGroup<T>[] {
  const byKey = new Map<string, CaseGroup<T>>();
  const resolved: T[] = [];
  for (const r of rows) {
    if (r.status === "resolved") {
      resolved.push(r);
      continue;
    }
    const g = byKey.get(r.cause.key) ?? { key: r.cause.key, label: r.cause.label, rows: [], waiting: 0, needsYou: 0 };
    g.rows.push(r);
    if (r.status === "proposed") g.waiting++;
    if (r.status === "needs_founder") g.needsYou++;
    byKey.set(r.cause.key, g);
  }
  const groups = [...byKey.values()].sort((a, b) => {
    const urgent = (g: CaseGroup<T>) => (g.waiting + g.needsYou > 0 ? 0 : 1);
    return urgent(a) - urgent(b) || b.rows.length - a.rows.length || a.label.localeCompare(b.label);
  });
  if (resolved.length) groups.push({ key: "resolved", label: "Resolved", rows: resolved, waiting: 0, needsYou: 0 });
  return groups;
}

// ── the look shared by the server detail and the client rows ───────────────

const STATUS_TONE: Record<string, string> = {
  new: "bg-[#EDE7FB] text-[#5B3FBF]",
  diagnosing: "bg-[#EDE7FB] text-[#5B3FBF]",
  proposed: "bg-[#FFF1D6] text-[#9A6400]",
  approved: "bg-[#E3EEFB] text-[#1F5FA8]",
  applied: "bg-[#E3EEFB] text-[#1F5FA8]",
  resolved: "bg-[#E6F6F2] text-[#0F7A68]",
  rejected: "bg-[#F4F5F2] text-[#5B6470]",
  needs_founder: "bg-[#FFE9E3] text-[#B3401F]",
};

export function statusTone(status: unknown): string {
  return (typeof status === "string" && Object.prototype.hasOwnProperty.call(STATUS_TONE, status) && STATUS_TONE[status]) || "bg-[#F4F5F2] text-[#5B6470]";
}

const SHORT_STATUS: Record<string, string> = {
  new: "Diagnosing",
  diagnosing: "Diagnosing",
  proposed: "Waiting for you",
  needs_founder: "Needs you",
  approved: "Approved",
  applied: "Retrying",
  resolved: "In review",
  rejected: "Rejected",
};

/** The row chip's word for a status (the filter chips' words). */
export function shortStatus(status: unknown): string {
  if (typeof status === "string" && Object.prototype.hasOwnProperty.call(SHORT_STATUS, status)) return SHORT_STATUS[status];
  return typeof status === "string" && status ? status : "Unknown";
}

/** The statuses that keep the page refreshing itself. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["new", "diagnosing", "approved", "applied"]);
