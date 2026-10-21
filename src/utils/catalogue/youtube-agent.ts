// Pure rules for the YouTube Publishing Agent's Library controls (Bulk
// YouTube Posting plan §2.5 / §3, migration 0150). No I/O: the route
// (/api/library/youtube/agent), the loader and the panel share one answer,
// and the rules are unit-tested without a database.
//
// FOUNDER 2026-10-21: "post 1 video per language a day (if available). that
// keeps uploads consistent" — the worker (sketchcast-ai catalogue/
// publish_agent.py) runs one ROUND per Pacific quota day after `daily_at`,
// taking the oldest pending kit of each language; "Run once more" asks it for
// one extra round now. This module decides what a selection may add to the
// queue, how long the queue takes at one a day per language, and what the
// panel says about the next round. The worker mirrors daily_minutes / the
// Pacific quota day — keep the two in step.

import type { VideoRow } from "./youtube-videos";

export const QUOTA_TZ = "America/Los_Angeles";
export const DEFAULT_DAILY_AT = "00:30";

export type QueueStatus = "pending" | "selected" | "queued" | "done" | "failed" | "skipped" | "cancelled";
export const OPEN_STATUSES: readonly QueueStatus[] = ["pending", "selected", "queued"];

export type QueueItem = {
  id: string;
  kit_id: string;
  topic_id: string | null;
  language: string;
  status: QueueStatus;
  round_id: string | null;
  job_id: string | null;
  attempts: number;
  last_error: string | null;
  added_at: string;
  updated_at: string;
};

export type RoundStatus = "requested" | "running" | "done";
export type Round = {
  id: string;
  trigger: "daily" | "manual";
  quota_day: string;
  status: RoundStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  summary: Record<string, unknown> | null;
};

export type AgentSettings = { paused?: boolean; daily_at?: string };

export type AgentControl = "pause" | "resume" | "run_once";
export type AgentAction = AgentControl | "preview" | "add" | "remove";
export const AGENT_ACTIONS: readonly AgentAction[] = ["preview", "add", "remove", "run_once", "pause", "resume"];
export const isAgentAction = (v: unknown): v is AgentAction => typeof v === "string" && (AGENT_ACTIONS as readonly string[]).includes(v);

/** A selection is capped so one click cannot queue the whole catalogue by
 *  accident; at one a day per language, 500 is months of posting anyway. */
export const MAX_ADD = 500;

// ── the Pacific quota clock ──────────────────────────────────────────────────

/** `ms` on YouTube's quota clock: the Pacific calendar day and the minutes
 *  after its midnight. */
export function pacific(ms: number): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: QUOTA_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export const quotaDay = (ms: number) => pacific(ms).day;

/** `daily_at` ("HH:MM", Pacific) as minutes after midnight; nonsense falls
 *  back to the default — the worker's daily_minutes. */
export function dailyMinutes(settings: AgentSettings | null | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((settings?.daily_at ?? "").trim());
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 24 && min < 60) return h * 60 + min;
  }
  return 30;
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** One line for the panel: when the next daily round runs. */
export function nextRoundLabel(opts: {
  nowMs: number;
  settings: AgentSettings | null;
  dailyDoneToday: boolean;
  openRound: Round | null;
  pending: number;
}): string {
  const at = dailyMinutes(opts.settings);
  if (opts.settings?.paused) return "Paused — no round starts until you resume.";
  if (opts.openRound) return opts.openRound.status === "requested" ? "A round starts within a minute." : "A round is running now.";
  if (opts.pending === 0) return "Nothing is waiting — tick translations below to queue them.";
  const now = pacific(opts.nowMs);
  if (!opts.dailyDoneToday) {
    return now.minutes >= at ? "Today's round starts within a minute." : `Today's round starts at ${hhmm(at)} Pacific.`;
  }
  return `Next daily round: tomorrow at ${hhmm(at)} Pacific (YouTube's quota day).`;
}

// ── what a selection may add ─────────────────────────────────────────────────

export type QueuePlan = {
  accepted: { kitId: string; topicId: string; language: string; languageName: string; title: string }[];
  excluded: { kitId: string; title: string; languageName: string; why: string }[];
  /** per language: already waiting + this selection, and the days at one a day */
  perLanguage: { language: string; name: string; adding: number; waiting: number; days: number }[];
  /** the queue's length in days at one per language per day (the longest language) */
  days: number;
};

/** Which selected rows go into the queue: postable (selectableForPost — the
 *  view's one rule) and not already waiting in it. Pure. */
export function planQueue(rows: VideoRow[], selected: readonly string[], open: readonly Pick<QueueItem, "kit_id" | "language">[]): QueuePlan {
  const want = new Set(selected);
  const waitingKits = new Set(open.map((o) => o.kit_id));
  const waitingBy = new Map<string, number>();
  for (const o of open) waitingBy.set(o.language, (waitingBy.get(o.language) ?? 0) + 1);

  const accepted: QueuePlan["accepted"] = [];
  const excluded: QueuePlan["excluded"] = [];
  const found = new Set<string>();
  for (const r of rows) {
    if (!want.has(r.kitId)) continue;
    found.add(r.kitId);
    if (waitingKits.has(r.kitId)) excluded.push({ kitId: r.kitId, title: r.title, languageName: r.languageName, why: "Already in the posting queue." });
    else if (!r.postable.ok) excluded.push({ kitId: r.kitId, title: r.title, languageName: r.languageName, why: r.postable.why });
    else accepted.push({ kitId: r.kitId, topicId: r.topicId, language: r.language, languageName: r.languageName, title: r.title });
  }
  for (const id of selected) {
    if (!found.has(id)) excluded.push({ kitId: id, title: id, languageName: "", why: "Not a translated kit in this list." });
  }
  const capped = accepted.slice(0, MAX_ADD);
  for (const a of accepted.slice(MAX_ADD)) excluded.push({ kitId: a.kitId, title: a.title, languageName: a.languageName, why: `More than ${MAX_ADD} in one selection.` });

  const adding = new Map<string, { name: string; n: number }>();
  for (const a of capped) adding.set(a.language, { name: a.languageName, n: (adding.get(a.language)?.n ?? 0) + 1 });
  const perLanguage = [...adding.entries()]
    .map(([language, v]) => {
      const waiting = waitingBy.get(language) ?? 0;
      return { language, name: v.name, adding: v.n, waiting, days: waiting + v.n };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const days = Math.max(0, ...[...waitingBy.values()], ...perLanguage.map((p) => p.days));
  return { accepted: capped, excluded, perLanguage, days };
}

// ── the queue, as the panel shows it ─────────────────────────────────────────

export type LanguageQueue = { language: string; waiting: number; next: QueueItem | null; inFlight: QueueItem | null };

/** Per language: how many wait, the next to go (oldest pending) and the one
 *  in the running round, if any. Pure. */
export function queueByLanguage(items: readonly QueueItem[]): LanguageQueue[] {
  const by = new Map<string, LanguageQueue>();
  const sorted = [...items].sort((a, b) => a.added_at.localeCompare(b.added_at) || a.id.localeCompare(b.id));
  for (const it of sorted) {
    if (!(OPEN_STATUSES as readonly string[]).includes(it.status)) continue;
    const q = by.get(it.language) ?? { language: it.language, waiting: 0, next: null, inFlight: null };
    if (it.status === "pending") {
      q.waiting += 1;
      q.next ??= it;
    } else {
      q.inFlight ??= it;
    }
    by.set(it.language, q);
  }
  return [...by.values()].sort((a, b) => a.language.localeCompare(b.language));
}

/** Whether "Run once more" may be pressed, with the sentence when not. */
export function runOnceAccepts(openRound: Round | null, pending: number, paused: boolean): { ok: true } | { ok: false; why: string } {
  if (paused) return { ok: false, why: "The agent is paused — resume it first." };
  if (openRound) return { ok: false, why: "A round is already in progress — it posts one video per language, one at a time." };
  if (pending === 0) return { ok: false, why: "Nothing is waiting in the posting queue." };
  return { ok: true };
}
