// The Fix Agent's cases (Phase 1: failed translations; migration 0151). Pure:
// no server imports, so the Library → Fixes page, its client buttons, the
// decision route and the tests all read the same rules.
//
// The WORKER (sketchcast-ai catalogue/fix_agent.py) writes everything on a
// case — evidence, diagnosis, proposal, the retry and its outcome. The Library
// writes only the founder's decision (proposed → approved | rejected, through
// decisionPatch) and the agent's on/off switch (platform_settings 'fix_agent').
// Every JSON field is the worker's, so every reader here is defensive: a field
// may be missing, null, or the wrong shape, and the page still renders.

export const FIX_STATUSES = ["new", "diagnosing", "proposed", "approved", "applied", "resolved", "rejected", "needs_founder"] as const;
export type FixStatus = (typeof FIX_STATUSES)[number];

/** Closed cases: the retry reached review, or the founder said no. Every other
 *  status — needs_founder included — stays at the top of the page. */
export const CLOSED_STATUSES: readonly FixStatus[] = ["resolved", "rejected"];

export type FixAction = "rerun" | "rerun_with_note" | "rerun_with_waiver" | "check_rule";
export type Classification = "check_false_positive" | "translation_error" | "infrastructure" | "unknown";
export type Decision = "approve" | "reject";

export type Finding = { where?: string; what?: string; missing?: string[]; extra?: string[]; source?: string; target?: string };
export type Evidence = { part?: number; reproduced?: boolean; findings?: Finding[] };
export type Verdict = { where?: string; verdict?: "faithful" | "wrong" | string; why?: string };
export type Diagnosis = { classification?: Classification | string; explanation?: string; verdicts?: Verdict[]; model?: string };
export type Waiver = { where?: string; what?: string; extra?: string[]; missing?: string[]; justification?: string };
export type CheckRule = { file?: string; change?: string; test?: string };
export type Proposal = {
  summary?: string;
  actions?: (FixAction | string)[];
  note?: string;
  waivers?: Waiver[];
  check_rule?: CheckRule;
  blast_radius?: string;
  est_cost_usd?: number;
  risk?: "low" | "sensitive" | string;
};
export type Outcome = {
  job_id?: string;
  job_status?: string;
  kit_id?: string;
  kit_status?: string;
  translation_status?: string;
  error?: string;
  at?: string;
};
export type HistoryRound = {
  round?: number;
  evidence?: Evidence;
  diagnosis?: Diagnosis;
  proposal?: Proposal;
  decided_by?: string | null;
  decided_at?: string | null;
  applied_job_id?: string | null;
  outcome?: Outcome;
};

export type FixCase = {
  id: string;
  kind?: string | null;
  component?: string | null;
  status: FixStatus | string;
  round?: number | null;
  topic_id?: string | null;
  source_kit_id?: string | null;
  language?: string | null;
  title?: string | null;
  issue?: string | null;
  source_job_id?: string | null;
  evidence?: Evidence | null;
  diagnosis?: Diagnosis | null;
  proposal?: Proposal | null;
  risk?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
  decision_note?: string | null;
  applied_job_id?: string | null;
  applied_at?: string | null;
  outcome?: Outcome | null;
  history?: HistoryRound[] | null;
  cost_usd?: number | string | null;
  created_at?: string | null;
  updated_at?: string | null;
  resolved_at?: string | null;
};

/** platform_settings 'fix_agent' (0151, seeded OFF). */
export type FixAgentSettings = { enabled?: boolean; summary_email?: string };

// ── labels ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<FixStatus, string> = {
  new: "Diagnosing",
  diagnosing: "Diagnosing",
  proposed: "Waiting for you",
  approved: "Approved — waiting for the lane",
  applied: "Retrying",
  resolved: "In review — done",
  rejected: "Rejected",
  needs_founder: "Needs your attention",
};

export function isFixStatus(s: unknown): s is FixStatus {
  return typeof s === "string" && (FIX_STATUSES as readonly string[]).includes(s);
}

/** The founder-facing word for a case's status; an unknown one reads as itself. */
export function statusLabel(status: unknown): string {
  if (isFixStatus(status)) return STATUS_LABEL[status];
  return typeof status === "string" && status ? status : "Unknown";
}

const ACTION_LABEL: Record<FixAction, string> = {
  rerun: "Re-run",
  rerun_with_note: "Re-run with an instruction",
  rerun_with_waiver: "Re-run with a waiver",
  check_rule: "Fix the check (needs a PR)",
};

/** An own key of `table` (never an inherited one like "toString"). */
const own = (table: object, k: unknown): k is string => typeof k === "string" && Object.prototype.hasOwnProperty.call(table, k);

export function actionLabel(action: unknown): string {
  if (own(ACTION_LABEL, action)) return ACTION_LABEL[action as FixAction];
  return typeof action === "string" && action ? action : "Unknown action";
}

const CLASSIFICATION_LABEL: Record<Classification, string> = {
  check_false_positive: "False alarm — the check was wrong",
  translation_error: "The translation was wrong",
  infrastructure: "Infrastructure — a service failed",
  unknown: "Not sure yet",
};

export function classificationLabel(c: unknown): string {
  if (own(CLASSIFICATION_LABEL, c)) return CLASSIFICATION_LABEL[c as Classification];
  return typeof c === "string" && c ? c : CLASSIFICATION_LABEL.unknown;
}

// ── the founder's decision ──────────────────────────────────────────────────

export const DECISION_NOTE_MAX = 500;

export function isDecision(v: unknown): v is Decision {
  return v === "approve" || v === "reject";
}

/** Only a proposal waits for the founder: Approve / Reject show on it alone,
 *  and the route's update is guarded on the same status. */
export function isDecidable(row: { status?: unknown } | null | undefined): boolean {
  return row?.status === "proposed";
}

/** A note from the body: trimmed, capped at DECISION_NOTE_MAX, null when empty
 *  or not a string. */
export function cleanNote(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const s = note.trim().slice(0, DECISION_NOTE_MAX).trim();
  return s ? s : null;
}

export type DecisionPatch = {
  status: "approved" | "rejected";
  decided_by: string;
  decided_at: string;
  decision_note: string | null;
  updated_at: string;
};

/** The columns the decision route writes — nothing else on the row is the
 *  Library's (the worker queues the retry from 'approved'). */
export function decisionPatch(action: Decision, actorId: string, note: unknown, nowIso: string): DecisionPatch {
  return {
    status: action === "approve" ? "approved" : "rejected",
    decided_by: actorId,
    decided_at: nowIso,
    decision_note: cleanNote(note),
    updated_at: nowIso,
  };
}

// ── retry after "needs you" ─────────────────────────────────────────────────
// A case the agent gave up on (two rounds, or a diagnosis it could not make)
// is retried by the founder once the cause is fixed — usually a check or
// translator change shipped in the worker. The case goes back to 'approved'
// with its last proposal; the worker queues it through fix_case_enqueue (one
// translation at a time, never while a user's job is live). The round it
// ended in is kept in `history`.

export function isRetryable(row: { status?: unknown } | null | undefined): boolean {
  return row?.status === "needs_founder";
}

export type RetryPatch = {
  status: "approved";
  applied_job_id: null;
  applied_at: null;
  decided_by: string;
  decided_at: string;
  decision_note: string;
  history: unknown[];
  updated_at: string;
};

export function retryPatch(
  row: Pick<FixCase, "round" | "source_job_id" | "evidence" | "diagnosis" | "proposal" | "decided_by" | "decided_at" | "decision_note" | "applied_job_id" | "applied_at" | "outcome" | "history">,
  actorId: string,
  nowIso: string,
): RetryPatch {
  const done = {
    round: row.round ?? null,
    source_job_id: row.source_job_id ?? null,
    evidence: row.evidence ?? null,
    diagnosis: row.diagnosis ?? null,
    proposal: row.proposal ?? null,
    decided_by: row.decided_by ?? null,
    decided_at: row.decided_at ?? null,
    decision_note: row.decision_note ?? null,
    applied_job_id: row.applied_job_id ?? null,
    applied_at: row.applied_at ?? null,
    outcome: row.outcome ?? null,
  };
  return {
    status: "approved",
    applied_job_id: null,
    applied_at: null,
    decided_by: actorId,
    decided_at: nowIso,
    decision_note: "retried by the founder after it needed attention",
    history: [...(Array.isArray(row.history) ? row.history : []), done],
    updated_at: nowIso,
  };
}

// ── ordering and the page's window ──────────────────────────────────────────

export function isOpen(row: { status?: unknown }): boolean {
  return !(CLOSED_STATUSES as readonly unknown[]).includes(row.status);
}

const LIFECYCLE: Record<string, number> = { new: 0, diagnosing: 1, proposed: 2, approved: 3, applied: 4, needs_founder: 5 };

const ms = (iso: unknown): number => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** When a case last moved: closed cases by resolved_at, else updated_at, else created_at. */
export function lastMoved(row: Pick<FixCase, "resolved_at" | "updated_at" | "created_at">): number {
  return ms(row.resolved_at) || ms(row.updated_at) || ms(row.created_at);
}

/** Open cases first, in lifecycle order (an unknown status after the known
 *  ones), newest first within a status; then closed cases, newest first. */
export function sortCases<T extends FixCase>(rows: readonly T[]): T[] {
  const rank = (r: T) => (isOpen(r) ? (own(LIFECYCLE, r.status) ? LIFECYCLE[r.status] : 6) : 100);
  return [...rows].sort((a, b) => rank(a) - rank(b) || lastMoved(b) - lastMoved(a) || a.id.localeCompare(b.id));
}

export const CLOSED_WINDOW_DAYS = 30;

/** What the page shows: every open case, and the closed ones that closed in
 *  the last `days` days. Sorted. */
export function visibleCases<T extends FixCase>(rows: readonly T[], nowMs: number, days = CLOSED_WINDOW_DAYS): T[] {
  const since = nowMs - days * 86_400_000;
  return sortCases(rows.filter((r) => isOpen(r) || lastMoved(r) >= since));
}

// ── defensive readers for the worker's JSON ─────────────────────────────────

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number").map((x) => String(x)) : [];
const objList = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && !Array.isArray(x)) : []);

export function findingsOf(evidence: unknown): (Finding & { missing: string[]; extra: string[] })[] {
  return objList(obj(evidence).findings).map((f) => ({
    where: str(f.where),
    what: str(f.what),
    missing: strList(f.missing),
    extra: strList(f.extra),
    source: str(f.source),
    target: str(f.target),
  }));
}

export function verdictsOf(diagnosis: unknown): Verdict[] {
  return objList(obj(diagnosis).verdicts).map((v) => ({ where: str(v.where), verdict: str(v.verdict), why: str(v.why) }));
}

export function actionsOf(proposal: unknown): string[] {
  return strList(obj(proposal).actions);
}

export function waiversOf(proposal: unknown): (Waiver & { extra: string[]; missing: string[] })[] {
  return objList(obj(proposal).waivers).map((w) => ({
    where: str(w.where),
    what: str(w.what),
    extra: strList(w.extra),
    missing: strList(w.missing),
    justification: str(w.justification),
  }));
}

export function checkRuleOf(proposal: unknown): CheckRule | null {
  const r = obj(obj(proposal).check_rule);
  const change = str(r.change);
  return change ? { file: str(r.file), change, test: str(r.test) } : null;
}

export function historyOf(history: unknown): HistoryRound[] {
  return objList(history).map((h) => ({
    round: num(h.round),
    evidence: obj(h.evidence) as Evidence,
    diagnosis: obj(h.diagnosis) as Diagnosis,
    proposal: obj(h.proposal) as Proposal,
    decided_by: str(h.decided_by) ?? null,
    decided_at: str(h.decided_at) ?? null,
    applied_job_id: str(h.applied_job_id) ?? null,
    outcome: obj(h.outcome) as Outcome,
  }));
}

/** A dollar amount from a number or a numeric string (numeric(10,4) arrives as
 *  either), or null. */
export function usd(v: unknown): string | null {
  const n = num(v);
  if (n === undefined) return null;
  return n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}

/** The retry's kit reached review (or later): the topic page is worth a link. */
export function outcomeInReview(outcome: unknown, status?: unknown): boolean {
  const o = obj(outcome);
  return status === "resolved" || o.kit_status === "in_review" || o.translation_status === "in_review" || o.translation_status === "approved";
}

// ── the evidence table's highlight ──────────────────────────────────────────

export type Segment = { text: string; hit: boolean };

const isDigit = (c: string | undefined) => !!c && c >= "0" && c <= "9";

/** `text` cut into plain and highlighted runs: every case-insensitive
 *  occurrence of a token is a hit — except where a token that starts (ends)
 *  with a digit sits right after (before) another digit, so "2" does not light
 *  up inside "12". Overlaps resolve to the earliest, then the longest token. */
export function highlightSegments(text: string, tokens: readonly string[]): Segment[] {
  const toks = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!text || !toks.length) return text ? [{ text, hit: false }] : [];
  const lower = text.toLowerCase();
  const out: Segment[] = [];
  let plainFrom = 0;
  let i = 0;
  while (i < text.length) {
    let len = 0;
    for (const t of toks) {
      if (!lower.startsWith(t.toLowerCase(), i)) continue;
      if (isDigit(t[0]) && isDigit(text[i - 1])) continue;
      if (isDigit(t[t.length - 1]) && isDigit(text[i + t.length])) continue;
      len = t.length;
      break;
    }
    if (!len) {
      i++;
      continue;
    }
    if (i > plainFrom) out.push({ text: text.slice(plainFrom, i), hit: false });
    out.push({ text: text.slice(i, i + len), hit: true });
    i += len;
    plainFrom = i;
  }
  if (plainFrom < text.length) out.push({ text: text.slice(plainFrom), hit: false });
  return out;
}
