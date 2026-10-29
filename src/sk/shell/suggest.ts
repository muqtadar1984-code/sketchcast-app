// SK S6 slice C — the greeting's ONE contextual suggestion (Final Plan §4.6:
// "at most one contextual suggestion per visit, only when a tool supports
// it"; §6 S6 "nothing sent unasked"; S6 design decision 5: in-app only).
//
// THE RULES, every one enforced here:
//   * only when the user's `suggestions` preference is on (default ON);
//   * at most ONE line, and none at all when the kit notices already filled
//     the greeting (or the student's tutor greeting already offered "Carry on?");
//   * built ONLY from a tool result read in this same request — the SAME code
//     the tool runs (the capability handler, or the queue / assembly it reads)
//     through the user's own session client;
//   * never twice for the same item: its id goes into the announced note and
//     the memory blob (memory.ts), and an announced id is skipped;
//   * time-boxed like kitNotices: ≤ SUGGEST_TIMEOUT_MS for ALL candidates
//     together; a slow, failing or empty read is skipped silently (logged);
//   * leaders (principal / coordinator hat): NOTHING that reads school-wide —
//     no school.* capability (metered, S5) and no leader mode of a teacher
//     tool; with the teacher hat they get their own teacher suggestion only;
//   * a suggestion that offers an action leaves the one-turn `offer`, so a
//     bare "yes" runs exactly that (the turn route), and nothing else;
//   * NOTHING is sent: this module returns a line for the greeting the user
//     opened. It imports no mailer, no push, no notifier (s6 guard test).
//
// Candidates, in priority order:
//   teacher  1. the next period starting within 15 min  (timetable.now_next)
//            2. marking waiting                          (marking.next's queue)
//            3. work due tomorrow in her classes         (assignments.status due=tomorrow)
//   student  1. the next idea to work on in the open kit (tutor.where, "weak")
//            2. her own work due tomorrow                (the child.status assembly, her own rows)
//   parent   1. a verified child's overdue work, else work due tomorrow (child.status assembly)
//   then, only when none of the above produced a line (workflow memory):
//            a pending task from a lapsed conversation, else "Last time: 5B, … — carry on?"

import type { SkCapabilityDeps, SkCapabilityResult, SkContext } from "./types";
import type { SkMemory, SkOffer } from "./memory";
import type { WorkflowFact } from "@/sk/facts";
import { allowedFor } from "./registry";
import { lineFor } from "./lines";
import { hmacHex } from "./hash";
import { leaderScope } from "@/sk/capabilities/leader-scope";
import { clockAt, timetableNowNext } from "@/sk/capabilities/timetable";
import { assignmentsStatus } from "@/sk/capabilities/assignments";
import { markingQueue } from "@/sk/capabilities/marking";
import { tutorWhere } from "@/sk/capabilities/tutor";
import { readChildSlice } from "@/sk/capabilities/parent";
import { verifiedChildren } from "@/sk/capabilities/child-scope";
import { childWorkItems, isDoneStatus, uniqueWork, type ChildWorkItem } from "@/utils/child-work";
import { pendingFromFact } from "./workflow";
import {
  SUGGEST_CHILD_OVERDUE,
  SUGGEST_CHILD_TOMORROW,
  SUGGEST_DUE_MANY,
  SUGGEST_DUE_ONE,
  SUGGEST_LAST_TIME,
  SUGGEST_LAST_TIME_KIT,
  SUGGEST_MARKING,
  SUGGEST_MARKING_ONE,
  SUGGEST_PENDING,
  SUGGEST_PERIOD,
  SUGGEST_STUDENT_DUE,
  SUGGEST_WORK,
} from "./suggest-lines";

export const SUGGEST_TIMEOUT_MS = 1500;
/** "Starts within 15 min" (Final Plan §4.6 "a period starting"). */
export const PERIOD_SOON_MIN = 15;
const KL_OFFSET_MIN = 8 * 60;
const DAY_MS = 86_400_000;

/** Every tool a suggestion may read. The guard test pins it: no school.*. */
export const SUGGEST_TOOLS = ["timetable.now_next", "marking.next", "assignments.status", "tutor.where", "child.status"] as const;
export type SuggestTool = (typeof SUGGEST_TOOLS)[number] | "own.work";

export type SuggestSource = SuggestTool | "workflow.pending_task" | "workflow.recent_kit";

export type Suggestion = {
  /** Announced-list id (memory.ts cleanIds shape): never suggested twice. */
  id: string;
  line: string;
  offer: SkOffer | null;
  source: SuggestSource;
  /** A lapsed conversation's pending task, restored into the fresh memory. */
  pending?: SkMemory["pending"];
};

/** The reads, injectable so the tests can count and slow them. */
export type SuggestReads = {
  nowNext: (ctx: SkContext, deps: SkCapabilityDeps) => Promise<SkCapabilityResult>;
  markingQueue: (ctx: SkContext, deps: SkCapabilityDeps) => Promise<Array<{ id: string }>>;
  dueTomorrow: (ctx: SkContext, deps: SkCapabilityDeps) => Promise<SkCapabilityResult>;
  tutorWhere: (ctx: SkContext, deps: SkCapabilityDeps) => Promise<SkCapabilityResult>;
  /** The child.status assembly for these ids (a parent's children, or a student herself). */
  work: (ctx: SkContext, deps: SkCapabilityDeps, ids: string[]) => Promise<Map<string, ChildWorkItem[]>>;
};

export const DEFAULT_READS: SuggestReads = {
  nowNext: (ctx, deps) => timetableNowNext.handler(ctx, {}, deps),
  markingQueue: (ctx, deps) => markingQueue(ctx, deps),
  dueTomorrow: (ctx, deps) => assignmentsStatus.handler(ctx, { due: "tomorrow" }, deps),
  tutorWhere: (ctx, deps) => tutorWhere.handler(ctx, {}, deps),
  work: async (ctx, deps, ids) => {
    const slice = await readChildSlice(deps, ctx.user.id, ids);
    return new Map(ids.map((id) => [id, uniqueWork(childWorkItems(slice, id, deps.now.getTime()))] as const));
  },
};

export type SuggestInput = {
  ctx: SkContext;
  deps: SkCapabilityDeps;
  /** Ids already announced (the note + the carried blob). */
  announced: readonly string[];
  /** The user's `suggestions` preference (prefs.ts; default on). */
  enabled: boolean;
  /** The kit notices (or the student's tutor offer) already filled the greeting. */
  filled: boolean;
  /** The user's live workflow facts (facts.ts recallWorkflow), newest first. */
  workflow?: readonly WorkflowFact[];
  timeoutMs?: number;
  reads?: Partial<SuggestReads>;
  log?: (msg: string, detail?: unknown) => void;
};

/** A short, stable id in the announced list's alphabet. */
export function suggestionId(prefix: string, ...parts: Array<string | number | null | undefined>): string {
  return `${prefix}-${hmacHex("sk-suggest", parts.map((p) => String(p ?? "")).join("|")).slice(0, 20)}`;
}

/** The civil day (YYYY-MM-DD) an instant falls on in Kuala Lumpur (UTC+8). */
export function klDate(ms: number): string {
  return new Date(ms + KL_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** Is `iso` due on the day AFTER `now`, in Kuala Lumpur time? (assignment-status's "tomorrow".) */
export function dueTomorrowKl(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return false;
  const d = Date.parse(iso);
  return Number.isFinite(d) && klDate(d) === klDate(now.getTime() + DAY_MS);
}

const toMin = (hhmm: string | null | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const has = (ctx: SkContext, name: string) => allowedFor(ctx).some((c) => c.meta.name === name);
const workTitle = (ctx: SkContext, w: { title: string | null }) => (w.title && w.title.trim() ? w.title.trim().slice(0, 120) : lineFor(SUGGEST_WORK, ctx.user.locale));
const isOwnMode = (ctx: SkContext) => leaderScope(ctx).mode === "own";
const isTeacherish = (ctx: SkContext) => ctx.user.role !== "student" && ctx.user.role !== "parent" && isOwnMode(ctx);

type Candidate = { source: SuggestSource; run: () => Promise<Suggestion | null> };

// ── teacher ──────────────────────────────────────────────────────────────────

function periodSoon(ctx: SkContext, deps: SkCapabilityDeps, r: SkCapabilityResult): Suggestion | null {
  if (!r.ok) return null;
  const clock = deps.clock && Number.isFinite(deps.clock.day) && Number.isFinite(deps.clock.minutes) ? deps.clock : clockAt(deps.now);
  for (const f of r.facts ?? []) {
    if (f.state !== "next" || f.confidence !== "slot" || typeof f.classId !== "string") continue;
    const start = toMin(f.startsAt as string | null);
    if (start === null) continue;
    const n = start - clock.minutes;
    if (n <= 0 || n > PERIOD_SOON_MIN) continue;
    const cls = String(f.className ?? "");
    const label = `${cls} ${String(f.subject ?? "")}`.trim();
    return {
      id: suggestionId("tt", klDate(deps.now.getTime()), f.period as number, f.classId),
      line: lineFor(SUGGEST_PERIOD, ctx.user.locale, { period: String(f.periodLabel ?? f.period ?? ""), n, class: cls, subject: String(f.subject ?? "") }),
      offer: { target: "board", classId: f.classId, label: label.slice(0, 160) || cls },
      source: "timetable.now_next",
    };
  }
  return null;
}

function markingWaiting(ctx: SkContext, queue: Array<{ id: string }>): Suggestion | null {
  if (!queue.length) return null;
  const n = queue.length;
  return {
    id: suggestionId("mk", queue[0]!.id),
    line: n === 1 ? lineFor(SUGGEST_MARKING_ONE, ctx.user.locale) : lineFor(SUGGEST_MARKING, ctx.user.locale, { n }),
    offer: { target: "read", capability: "marking.next", args: {}, label: "marking" },
    source: "marking.next",
  };
}

function dueTomorrowTeacher(ctx: SkContext, r: SkCapabilityResult): Suggestion | null {
  if (!r.ok) return null;
  const rows = (r.facts ?? []).filter((f) => typeof f.shareId === "string");
  if (!rows.length) return null;
  const first = rows[0]!;
  const line =
    rows.length === 1
      ? lineFor(SUGGEST_DUE_ONE, ctx.user.locale, { title: workTitle(ctx, { title: (first.title as string) ?? null }), class: String(first.className ?? ""), n: Number(first.notDone ?? 0) })
      : lineFor(SUGGEST_DUE_MANY, ctx.user.locale, { n: rows.length });
  return {
    id: suggestionId("dt", ...rows.map((x) => x.shareId as string)),
    line,
    offer: { target: "read", capability: "assignments.status", args: { due: "tomorrow" }, label: "due tomorrow" },
    source: "assignments.status",
  };
}

function teacherCandidates(ctx: SkContext, deps: SkCapabilityDeps, reads: SuggestReads): Candidate[] {
  // Leaders with a leader hat: nothing (no school-wide read is ever made for a
  // suggestion). Their teacher hat is the "own" mode and lands here.
  if (!isTeacherish(ctx)) return [];
  const out: Candidate[] = [];
  if (has(ctx, "timetable.now_next")) out.push({ source: "timetable.now_next", run: async () => periodSoon(ctx, deps, await reads.nowNext(ctx, deps)) });
  if (has(ctx, "marking.next")) out.push({ source: "marking.next", run: async () => markingWaiting(ctx, await reads.markingQueue(ctx, deps)) });
  if (has(ctx, "assignments.status")) out.push({ source: "assignments.status", run: async () => dueTomorrowTeacher(ctx, await reads.dueTomorrow(ctx, deps)) });
  return out;
}

// ── student ──────────────────────────────────────────────────────────────────

function studentCandidates(ctx: SkContext, deps: SkCapabilityDeps, reads: SuggestReads): Candidate[] {
  if (ctx.user.role !== "student") return [];
  const out: Candidate[] = [];
  const t = ctx.tutor;
  if (t?.kit && has(ctx, "tutor.where")) {
    out.push({
      source: "tutor.where",
      run: async () => {
        const r = await reads.tutorWhere(ctx, deps);
        const f = (r.facts ?? [])[0];
        if (!r.ok || f?.next !== "weak" || !r.summary) return null;
        return { id: suggestionId("tw", t.kit, String(f.heading ?? f.section ?? "")), line: r.summary.slice(0, 300), offer: null, source: "tutor.where" };
      },
    });
  }
  out.push({
    source: "own.work",
    run: async () => {
      const items = (await reads.work(ctx, deps, [ctx.user.id])).get(ctx.user.id) ?? [];
      const due = items.find((w) => !isDoneStatus(w.status) && !w.awaitingMarking && dueTomorrowKl(w.due, deps.now));
      if (!due) return null;
      return { id: suggestionId("sd", due.genId, klDate(Date.parse(due.due as string))), line: lineFor(SUGGEST_STUDENT_DUE, ctx.user.locale, { title: workTitle(ctx, due) }), offer: null, source: "own.work" };
    },
  });
  return out;
}

// ── parent ───────────────────────────────────────────────────────────────────

function parentCandidates(ctx: SkContext, deps: SkCapabilityDeps, reads: SuggestReads, announced: Set<string>): Candidate[] {
  const kids = verifiedChildren(ctx);
  if (!kids.length || !has(ctx, "child.status")) return [];
  return [
    {
      source: "child.status",
      run: async () => {
        const work = await reads.work(ctx, deps, kids.map((k) => k.id));
        const pick = (child: (typeof kids)[number], w: ChildWorkItem, kind: "overdue" | "tomorrow", n: number): Suggestion => ({
          id: suggestionId("cp", child.id, w.genId, kind),
          line:
            kind === "overdue"
              ? lineFor(SUGGEST_CHILD_OVERDUE, ctx.user.locale, { name: child.firstName, n, title: workTitle(ctx, w) })
              : lineFor(SUGGEST_CHILD_TOMORROW, ctx.user.locale, { name: child.firstName, title: workTitle(ctx, w) }),
          offer: { target: "read", capability: "child.status", args: { child: child.id }, label: child.firstName },
          source: "child.status",
        });
        // Overdue first (any child), then due tomorrow; an item already
        // announced is skipped so the next one can come up.
        for (const child of kids) {
          const overdue = (work.get(child.id) ?? []).filter((w) => w.overdue);
          const fresh = overdue.find((w) => !announced.has(suggestionId("cp", child.id, w.genId, "overdue")));
          if (fresh) return pick(child, fresh, "overdue", overdue.length);
        }
        for (const child of kids) {
          const tomorrow = (work.get(child.id) ?? []).filter((w) => !isDoneStatus(w.status) && !w.awaitingMarking && dueTomorrowKl(w.due, deps.now));
          const fresh = tomorrow.find((w) => !announced.has(suggestionId("cp", child.id, w.genId, "tomorrow")));
          if (fresh) return pick(child, fresh, "tomorrow", tomorrow.length);
        }
        return null;
      },
    },
  ];
}

// ── workflow memory (only when nothing else spoke) ──────────────────────────

/** PURE: the "carry on?" line from the newest workflow facts, or null. */
export function workflowSuggestion(ctx: SkContext, facts: readonly WorkflowFact[], announced: ReadonlySet<string>): Suggestion | null {
  if (!isTeacherish(ctx)) return null;
  for (const f of facts) {
    if (f.kind === "pending_task") {
      const pending = pendingFromFact(f);
      const id = suggestionId("pt", f.key, f.updatedAt);
      if (pending && !announced.has(id)) return { id, line: lineFor(SUGGEST_PENDING, ctx.user.locale), offer: null, source: "workflow.pending_task", pending };
    }
  }
  const kit = facts.find((f) => f.kind === "recent_kit");
  if (!kit) return null;
  const v = (kit.value ?? {}) as { label?: unknown; classId?: unknown; classLabel?: unknown; generationId?: unknown; bookId?: unknown; chapterRef?: unknown };
  const label = typeof v.label === "string" ? v.label.trim().slice(0, 120) : "";
  if (!label) return null;
  const id = suggestionId("lt", kit.key, kit.updatedAt);
  if (announced.has(id)) return null;
  const classLabel = typeof v.classLabel === "string" ? v.classLabel.trim().slice(0, 60) : "";
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  const offer: SkOffer = {
    target: "board",
    label,
    ...(str(v.classId) ? { classId: str(v.classId) } : {}),
    ...(str(v.generationId) ? { generationId: str(v.generationId) } : { ...(str(v.bookId) ? { bookId: str(v.bookId) } : {}), ...(str(v.chapterRef) ? { chapterRef: str(v.chapterRef) } : {}) }),
  };
  return {
    id,
    line: classLabel ? lineFor(SUGGEST_LAST_TIME, ctx.user.locale, { class: classLabel, kit: label }) : lineFor(SUGGEST_LAST_TIME_KIT, ctx.user.locale, { kit: label }),
    offer,
    source: "workflow.recent_kit",
  };
}

// ── the engine ───────────────────────────────────────────────────────────────

/**
 * The ONE suggestion for this greeting, or null. Never throws, never exceeds
 * the time box: candidates run one after another in priority order against a
 * single deadline; the first that produces an un-announced line wins.
 */
export async function greetingSuggestion(input: SuggestInput): Promise<Suggestion | null> {
  const { ctx, deps } = input;
  const log = input.log ?? ((msg: string, detail?: unknown) => console.warn(msg, detail ?? ""));
  if (!input.enabled || input.filled) return null;
  const announced = new Set(input.announced);
  const reads: SuggestReads = { ...DEFAULT_READS, ...(input.reads ?? {}) };
  const candidates = [...teacherCandidates(ctx, deps, reads), ...studentCandidates(ctx, deps, reads), ...parentCandidates(ctx, deps, reads, announced)];

  const deadline = Date.now() + (input.timeoutMs ?? SUGGEST_TIMEOUT_MS);
  for (const c of candidates) {
    const left = deadline - Date.now();
    if (left <= 0) {
      log("sk-shell.greeting suggestion skipped: timeout");
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), left);
    });
    try {
      const work = c.run();
      const r = await Promise.race([work, timeout]);
      if (r === "timeout") {
        work.catch(() => undefined);
        log("sk-shell.greeting suggestion skipped: timeout", c.source);
        return null;
      }
      if (r && !announced.has(r.id)) return r;
    } catch (e) {
      log("sk-shell.greeting suggestion skipped: error", `${c.source}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  try {
    return workflowSuggestion(ctx, input.workflow ?? [], announced);
  } catch (e) {
    log("sk-shell.greeting suggestion skipped: error", `workflow: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
