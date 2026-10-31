// The RECOMMENDED PLAN — its shape, its state machine, who may decide it, and
// how SK drafts it (SK student Board plan 2026-10-31, phase 4). PURE except
// `polishPlan`, whose model call is injected. No Supabase here (plan-store.ts).
//
// WHAT A PLAN HOLDS — at most 6 items, three kinds:
//   reteach   a concept of a kit that is not secure: SK teaches it again
//             (on approval it becomes an sk_learn_focus row SK's learner
//             turns read);
//   practice  a worksheet to practise again (on approval: assigned, unless
//             she already has it);
//   next      the next topic: an assigned kit she has not started, else the
//             approver's own next chapter of the same book (on approval:
//             assigned to her — or to the class).
// THE DECISIONS ARE SK'S RULES, NOT THE MODEL'S: which concepts (the weakest
// non-secure ones), which worksheet, which next kit are picked here from the
// mastery data (planSkeleton). The model only WORDS it — a two-sentence
// summary and a short reason per item — and a reply that changes the items
// is thrown away (the deterministic wording stands). Haiku 5.5, not Sonnet:
// the task is short structured wording over decided facts, a person approves
// every plan before anything happens, and it is ~10× cheaper (≈ $0.0003 a plan).
//
// STATE MACHINE:
//   draft ──(drafter: worded)──▶ pending_approval
//   pending_approval ──approve──▶ approved      (terminal; assigns + focus)
//   pending_approval ──decline──▶ declined      (terminal)
//   pending_approval ──edit─────▶ pending_approval (reworded / fewer items)
//   draft | pending_approval ──(a newer weekly plan)──▶ superseded
// WHO DECIDES (mirrors sk_learn_plan_decide, 0179 — the database is the
// authority; this copy drives the UI and the tests):
//   approver_role "teacher": the teacher of plan.class_id, the student
//                            enrolled in it. Her parent reads, read-only.
//   approver_role "parent":  a linked parent (a home student: no class).
//   Never the student; never another teacher; "whole class" is teacher-only.

import type { ConceptMastery } from "./mastery";
import type { HelpModelCall, HelpUsage } from "./help";

export const PLAN_MODEL = "claude-haiku-5-5";
const PRICE_IN = 0.1 / 1e6;
const PRICE_OUT = 0.5 / 1e6;
export const PLAN_MAX_TOKENS = 700;
export const PLAN_MAX_ITEMS = 6;
export const PLAN_MAX_RETEACH = 3;
export const TITLE_MAX = 160;
export const REASON_MAX = 300;
export const SUMMARY_MAX = 600;

export type PlanItemKind = "reteach" | "practice" | "next";
export type PlanItem = {
  kind: PlanItemKind;
  title: string;
  reason: string;
  concept_key?: string;
  concept_name?: string;
  kit_id?: string;
  generation_id?: string;
};
export type PlanStatus = "draft" | "pending_approval" | "approved" | "declined" | "superseded";
export type PlanDecision = "approve" | "decline" | "edit";
export type ApproverRole = "teacher" | "parent";

export type PlanRow = {
  id: string;
  student_id: string;
  kit_id: string | null;
  trigger: "kit_done" | "weekly";
  approver_role: ApproverRole;
  class_id: string | null;
  approver_id: string | null;
  status: PlanStatus;
  summary: string | null;
  items: PlanItem[];
  mastery: MasterySnap[];
  edited: boolean;
  decided_by: string | null;
  decided_role: ApproverRole | null;
  decided_at: string | null;
  decline_note: string | null;
  applied: { shares?: string[]; already?: string[]; skipped?: unknown[]; focus?: number; whole_class?: boolean } | null;
  created_at: string;
};

/** The mastery rows a plan's reasons rest on (stored with the plan). */
export type MasterySnap = { kit_id: string; key: string; name: string; score: number; band: string; evidence: number };

// ── the state machine ───────────────────────────────────────────────────────

export function nextStatus(from: PlanStatus, decision: PlanDecision): PlanStatus | null {
  if (from !== "pending_approval") return null;
  return decision === "approve" ? "approved" : decision === "decline" ? "declined" : "pending_approval";
}

export const isOpen = (s: PlanStatus): boolean => s === "draft" || s === "pending_approval";

// ── who may decide / read (the 0179 rules, for the UI and the tests) ────────

export type PlanViewer = {
  id: string;
  role: string;
  /** Classes this viewer TEACHES that have the plan's student enrolled. */
  teachesClasses: ReadonlySet<string>;
  /** Children this viewer is linked to as a parent. */
  children: ReadonlySet<string>;
};

export function canDecide(plan: Pick<PlanRow, "student_id" | "approver_role" | "class_id" | "status">, v: PlanViewer): boolean {
  if (plan.status !== "pending_approval") return false;
  if (v.id === plan.student_id) return false;
  if (plan.approver_role === "teacher") return !!plan.class_id && v.teachesClasses.has(plan.class_id);
  return v.children.has(plan.student_id);
}

/** The plan's read rule (RLS of 0179): the student her APPROVED plans; her teachers and parent all of hers. */
export function canRead(plan: Pick<PlanRow, "student_id" | "status">, v: PlanViewer & { teachesStudent?: boolean }): boolean {
  if (v.id === plan.student_id) return plan.status === "approved";
  return !!v.teachesStudent || v.children.has(plan.student_id);
}

/** "whole class" is a teacher's option on a teacher plan only. */
export const canApplyToClass = (plan: Pick<PlanRow, "approver_role" | "class_id">): boolean => plan.approver_role === "teacher" && !!plan.class_id;

// ── edit before approve (mirrors the function's check) ──────────────────────

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const sameItem = (a: PlanItem, b: Partial<PlanItem>) =>
  a.kind === b.kind && (a.generation_id ?? "") === (b.generation_id ?? "") && (a.kit_id ?? "") === (b.kit_id ?? "") && (a.concept_key ?? "") === (b.concept_key ?? "");

/**
 * An approver's edited list against SK's: each item must be one SK proposed
 * (same kind, kit, concept, generation) — only its title and reason may
 * change, and items may be dropped. Null = refused.
 */
export function checkEdit(original: readonly PlanItem[], edited: unknown): PlanItem[] | null {
  if (!Array.isArray(edited) || edited.length < 1 || edited.length > 8) return null;
  const out: PlanItem[] = [];
  for (const raw of edited) {
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Partial<PlanItem>;
    if (e.kind !== "reteach" && e.kind !== "practice" && e.kind !== "next") return null;
    const title = clip(e.title, 10_000);
    const reason = clip(e.reason, 10_000);
    if (!title || title.length > TITLE_MAX || reason.length > REASON_MAX) return null;
    const orig = original.find((o) => sameItem(o, e));
    if (!orig) return null;
    const keep: PlanItem = { kind: orig.kind, title, reason };
    for (const k of ["concept_key", "concept_name", "kit_id", "generation_id"] as const) {
      const v = orig[k];
      if (typeof v === "string" && v) keep[k] = v.slice(0, k === "concept_name" ? 200 : 120);
    }
    out.push(keep);
  }
  return out;
}

// ── drafting: SK's rules ────────────────────────────────────────────────────

export type NextKit = { generationId: string; title: string; assigned: boolean };

export type SkeletonInput = {
  /** THIS student's mastery rows (one kit for a kit plan, all for the weekly). */
  mastery: readonly ConceptMastery[];
  /** kit id → the worksheet(s) she practised in it (practice items). */
  worksheets: ReadonlyMap<string, { id: string; title: string }>;
  kitNames: ReadonlyMap<string, string>;
  next: NextKit | null;
};

/** The weakest non-secure concepts first; a score of 0–100 → plain reasons. */
export function planSkeleton(input: SkeletonInput): PlanItem[] {
  const weak = input.mastery.filter((m) => m.band !== "secure").sort((a, b) => a.score - b.score || b.evidence - a.evidence).slice(0, PLAN_MAX_RETEACH);
  const items: PlanItem[] = weak.map((m) => ({
    kind: "reteach",
    title: clip(m.name, TITLE_MAX),
    reason: clip(
      m.band === "new"
        ? `Only ${m.evidence} question so far — not enough to be sure (score ${m.score}/100).`
        : `Score ${m.score}/100 over ${m.evidence} questions; ${m.firstTry} right first time.`,
      REASON_MAX,
    ),
    concept_key: m.key,
    concept_name: clip(m.name, 200),
    kit_id: m.kitId,
  }));
  const kitsToPractise = [...new Set(weak.map((m) => m.kitId))];
  for (const k of kitsToPractise) {
    const ws = input.worksheets.get(k);
    if (!ws || items.length >= PLAN_MAX_ITEMS - 1) continue;
    const n = weak.filter((m) => m.kitId === k).length;
    items.push({
      kind: "practice",
      title: clip(`Practise again: ${ws.title || input.kitNames.get(k) || "the worksheet"}`, TITLE_MAX),
      reason: clip(`${n} idea${n === 1 ? "" : "s"} in this lesson still need practice.`, REASON_MAX),
      generation_id: ws.id,
      kit_id: k,
    });
  }
  if (input.next && items.length < PLAN_MAX_ITEMS) {
    items.push({
      kind: "next",
      title: clip(input.next.title || "Next lesson", TITLE_MAX),
      reason: input.next.assigned ? "Already assigned and not started yet." : weak.length ? "The next chapter, once the ideas above are practised." : "Every idea here is secure — ready for the next chapter.",
      generation_id: input.next.generationId,
    });
  }
  return items.slice(0, PLAN_MAX_ITEMS);
}

export function masterySnapshot(rows: readonly ConceptMastery[]): MasterySnap[] {
  return rows.slice(0, 30).map((m) => ({ kit_id: m.kitId, key: m.key, name: clip(m.name, 200), score: m.score, band: m.band, evidence: m.evidence }));
}

/** The deterministic summary (used when the model is off or its reply is refused). */
export function fallbackSummary(items: readonly PlanItem[]): string {
  const re = items.filter((i) => i.kind === "reteach").map((i) => i.title);
  const next = items.find((i) => i.kind === "next");
  const parts: string[] = [];
  if (re.length) parts.push(`Go over ${re.join(", ")} again with SK and practise the worksheet.`);
  else parts.push("Every idea practised so far is secure.");
  if (next) parts.push(`Then move on to ${next.title}.`);
  return clip(parts.join(" "), SUMMARY_MAX);
}

// ── the model's wording ─────────────────────────────────────────────────────

export function planPrompt(items: readonly PlanItem[], snap: readonly MasterySnap[], language: string): { system: string; user: string } {
  const system = [
    "You write a short learning plan for a school student, for her teacher or parent to approve.",
    "The plan's items are FIXED: keep their number and order; for each, write a short title (≤ 12 words) and a one-sentence reason grounded ONLY in the mastery data given (scores are 0–100).",
    `Write in this language: ${language}. Warm, plain, no jargon, no markdown.`,
    'Reply with JSON only: {"summary": "<at most 2 sentences>", "items": [{"title": "...", "reason": "..."}, ...]}',
  ].join(" ");
  const user = JSON.stringify({
    mastery: snap.map((m) => ({ concept: m.name, score: m.score, band: m.band, questions: m.evidence })),
    items: items.map((i) => ({ kind: i.kind, title: i.title, reason: i.reason })),
  });
  return { system, user };
}

export const planCost = (u: HelpUsage): number => Math.round((u.input_tokens * PRICE_IN + u.output_tokens * PRICE_OUT) * 1e6) / 1e6;

/** The model's reply → the SAME items reworded, plus a summary. Null = refused (wrong count, empty, too long). */
export function parsePlanReply(text: string, items: readonly PlanItem[]): { summary: string; items: PlanItem[] } | null {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ""));
  if (!m) return null;
  let obj: { summary?: unknown; items?: unknown };
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const summary = clip(obj?.summary, 10_000);
  if (!summary || summary.length > SUMMARY_MAX) return null;
  if (!Array.isArray(obj.items) || obj.items.length !== items.length) return null;
  const out: PlanItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = obj.items[i] as { title?: unknown; reason?: unknown } | null;
    const title = clip(r?.title, 10_000);
    const reason = clip(r?.reason, 10_000);
    if (!title || title.length > TITLE_MAX || !reason || reason.length > REASON_MAX) return null;
    out.push({ ...items[i], title, reason });
  }
  return { summary, items: out };
}

/** Word the plan with the model; the skeleton's own words when it is off or refused. */
export async function polishPlan(
  call: HelpModelCall | null,
  items: PlanItem[],
  snap: MasterySnap[],
  language = "English",
): Promise<{ summary: string; items: PlanItem[]; model: string | null; cost: number }> {
  const plain = { summary: fallbackSummary(items), items, model: null, cost: 0 };
  if (!call || !items.length) return plain;
  try {
    const p = planPrompt(items, snap, language);
    const res = await call({ model: PLAN_MODEL, system: p.system, user: p.user, maxTokens: PLAN_MAX_TOKENS });
    const got = parsePlanReply(res.text, items);
    return got ? { ...got, model: PLAN_MODEL, cost: planCost(res.usage) } : { ...plain, cost: planCost(res.usage) };
  } catch {
    return plain;
  }
}
