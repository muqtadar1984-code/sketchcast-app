// SK S6 slice C — workflow facts in use (Final Plan §9.5: "pending tasks,
// preferences, recently used classes and kits", the adult's own, 12 months).
//
// RECORD (turn route): when a teacher's turn opens the Board with a class
// and/or a lesson (the navigate event's /present deep link) or resolves a
// class, the class becomes `recent_class` and the lesson `recent_kit` —
// through her OWN session client (facts.ts rememberWorkflow; RLS owner-only).
// PENDING (context route): a conversation that lapsed (the 4-hour gap) while
// SK was waiting on an answer leaves that `pending` as a `pending_task`
// fact, so the next visit can offer to carry on.
// RECALL (suggest.ts): the newest of these, as the greeting's ONE line, only
// when no other line was used.
//
// Students keep NO workflow facts (their memory is learning memory, consent-
// gated — facts.ts noteLearning). Nothing here ever throws or holds a reply:
// every write is time-boxed and a failure is logged and dropped.

import { rememberWorkflow, type FactsDb, type WorkflowFact } from "@/sk/facts";
import { openMemory, verifyMemory, type SkMemory } from "./memory";
import type { ResolvedEntity, SkContext } from "./types";

export const WORKFLOW_WRITE_TIMEOUT_MS = 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHAPTER_RE = /^[A-Za-z0-9._-]{1,20}$/;
/** book.activate's pending question lasts exactly one turn (turn route) and is
 *  about a book code: never carried to another visit. */
const NEVER_SAVED_TASKS = new Set(["book.activate"]);

export type RecentKitValue = { label: string; classId?: string; classLabel?: string; generationId?: string; bookId?: string; chapterRef?: string };
export type WorkflowNote =
  | { kind: "recent_class"; key: string; value: { label: string } }
  | { kind: "recent_kit"; key: string; value: RecentKitValue }
  | { kind: "pending_task"; key: string; value: { task: string; needs: string[] } };

/** The Board deep link's filters (navigate.ts navPath "board"), or null. */
export function boardLink(path: string | null | undefined): { classId?: string; generationId?: string; bookId?: string; chapterRef?: string } | null {
  if (!path || typeof path !== "string" || !path.startsWith("/present")) return null;
  let u: URL;
  try {
    u = new URL(path, "https://sk.invalid");
  } catch {
    return null;
  }
  if (u.pathname !== "/present") return null;
  const id = (k: string) => {
    const v = u.searchParams.get(k);
    return v && ID_RE.test(v) ? v : undefined;
  };
  const chapter = u.searchParams.get("chapter");
  return {
    ...(id("class") ? { classId: id("class") } : {}),
    ...(id("kit") ? { generationId: id("kit") } : {}),
    ...(id("book") ? { bookId: id("book") } : {}),
    ...(chapter && CHAPTER_RE.test(chapter) ? { chapterRef: chapter } : {}),
  };
}

const clean = (s: unknown, max = 120) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The lesson's name among the turn's entities: the kit itself, its chapter, or its book. */
function lessonLabel(entities: ResolvedEntity[], link: NonNullable<ReturnType<typeof boardLink>>): string {
  if (link.generationId) {
    const e = entities.find((x) => (x.kind === "kit" || x.kind === "generation") && x.id === link.generationId);
    if (e) return clean(e.label);
  }
  if (link.bookId) {
    const ch = entities.find((x) => x.kind === "chapter" && (x.ids ?? []).includes(link.bookId!) && (link.chapterRef === undefined || (x.ids ?? []).includes(link.chapterRef)));
    if (ch) return clean(ch.label);
    const b = entities.find((x) => x.kind === "book" && x.id === link.bookId);
    if (b) return clean(b.label);
  }
  return "";
}

/**
 * PURE: what this turn teaches SK about the adult's workflow. A Board deep
 * link → the class (when named) + the lesson (when its name is known); else
 * the first class the turn resolved (not one the greeting announced).
 */
export function workflowFromTurn(input: { role: string | null; navigatePath?: string | null; entities: ResolvedEntity[] }): WorkflowNote[] {
  if (!input.role || input.role === "student") return [];
  const entities = input.entities ?? [];
  const classLabel = (id: string) => clean(entities.find((e) => e.kind === "class" && e.id === id)?.label);
  const out: WorkflowNote[] = [];
  const link = boardLink(input.navigatePath);
  if (link) {
    const cl = link.classId ? classLabel(link.classId) : "";
    if (link.classId && cl) out.push({ kind: "recent_class", key: link.classId, value: { label: cl } });
    const label = lessonLabel(entities, link);
    const key = link.generationId ? `kit:${link.generationId}` : link.bookId && link.chapterRef !== undefined ? `book:${link.bookId}:${link.chapterRef}` : "";
    if (label && key) {
      out.push({
        kind: "recent_kit",
        key,
        value: {
          label,
          ...(link.classId ? { classId: link.classId } : {}),
          ...(cl ? { classLabel: cl } : {}),
          ...(link.generationId ? { generationId: link.generationId } : { bookId: link.bookId, chapterRef: link.chapterRef }),
        },
      });
    }
    return out;
  }
  const c = entities.find((e) => e.kind === "class" && e.via !== "greeting" && ID_RE.test(e.id) && clean(e.label));
  if (c) out.push({ kind: "recent_class", key: c.id, value: { label: clean(c.label) } });
  return out;
}

/**
 * PURE: the pending task to keep when the carried conversation has LAPSED
 * (openMemory's 4-hour gap) — signed by us, the same context (hat / school /
 * role), waiting on an answer. Anything else → null.
 */
export function pendingToSave(blob: string | null | undefined, ctx: SkContext, now: Date): WorkflowNote | null {
  if (!blob) return null;
  const m = verifyMemory(blob);
  if (!m?.pending || typeof m.pending.task !== "string" || NEVER_SAVED_TASKS.has(m.pending.task)) return null;
  if (m.contextHash !== ctx.contextHash) return null;
  if (openMemory(blob, ctx, now).reason !== "gap") return null;
  const task = m.pending.task.slice(0, 60);
  if (!/^[a-z][a-z0-9_.]{1,59}$/.test(task)) return null;
  const needs = (Array.isArray(m.pending.needs) ? m.pending.needs : []).filter((n): n is string => typeof n === "string").map((n) => n.slice(0, 40)).slice(0, 6);
  return { kind: "pending_task", key: task, value: { task, needs } };
}

/** The pending task a fact restores into a fresh conversation. */
export function pendingFromFact(f: WorkflowFact): SkMemory["pending"] | null {
  const v = f.value as { task?: unknown; needs?: unknown } | null;
  if (f.kind !== "pending_task" || !v || typeof v.task !== "string" || NEVER_SAVED_TASKS.has(v.task)) return null;
  return { task: v.task, needs: Array.isArray(v.needs) ? v.needs.filter((n): n is string => typeof n === "string").slice(0, 6) : [] };
}

/** Write the notes through the owner's session; time-boxed, never throws. */
export async function recordWorkflow(session: FactsDb, ownerId: string, notes: WorkflowNote[], opts: { now?: Date; timeoutMs?: number; log?: (m: string, d?: unknown) => void } = {}): Promise<number> {
  if (!notes.length || !ownerId) return 0;
  const log = opts.log ?? ((m: string, d?: unknown) => console.warn(m, d ?? ""));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? WORKFLOW_WRITE_TIMEOUT_MS);
  });
  try {
    const work = Promise.all(notes.map((n) => rememberWorkflow(session, ownerId, n.kind, n.key, n.value, opts.now ?? new Date()).catch(() => false)));
    const r = await Promise.race([work, timeout]);
    if (r === "timeout") {
      work.catch(() => undefined);
      log("sk-shell workflow facts skipped: timeout");
      return 0;
    }
    return r.filter(Boolean).length;
  } catch (e) {
    log("sk-shell workflow facts skipped: error", e instanceof Error ? e.message : String(e));
    return 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
