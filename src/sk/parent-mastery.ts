// S4 — a parent's view of ONE child's SK mastery (design 2026-10-29,
// decision 6). sk_objective_mastery and mastery_state are read-own only (0157,
// 0170): a parent's session cannot read them, and S4 adds NO database policy.
// So this is the one place a parent capability touches the ADMIN client, and it
// is kept small on purpose:
//
//   childMastery(ctx, childId)  — the gate: the caller must be a parent and
//                                 childId one of ctx.children's VERIFIED links
//                                 (isVerifiedChild). Anything else returns null
//                                 WITHOUT creating the admin client or calling
//                                 the reader.
//   readChildMasteryAdmin(...)  — the read: every query is filtered by that one
//                                 student_id, and the rows are re-filtered in
//                                 code; labels come from the objective's own
//                                 article / teaching objective.
//
// child-mastery.test.ts proves the reader is never called for an unlinked,
// unverified or forged child.

import type { SkChild, SkContext } from "@/sk/shell/types";
import { isVerifiedChild } from "@/sk/capabilities/child-scope";
import { createAdminClient } from "@/utils/supabase/admin";

export type MasteryStatus = "unknown" | "in_progress" | "mastered" | "provisional" | "needs_work";

export type ChildMasteryRow = {
  /** sk_objective_mastery.objective_key, or the teaching_objective id. */
  key: string;
  status: MasteryStatus;
  updatedAt: string | null;
  /** The objective's own words ("Describe the cell as…"), trimmed. */
  label: string;
  /** The kit (article) title it belongs to, when known. */
  kit: string | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export type MasteryAdmin = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type MasteryReader = (admin: MasteryAdmin, childId: string) => Promise<ChildMasteryRow[]>;

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => {
  const x = r as { data?: unknown; error?: unknown } | null;
  if (x?.error) throw new Error("[sk parent] mastery read failed");
  return Array.isArray(x?.data) ? (x!.data as Row[]) : [];
};
const STATUSES: ReadonlySet<string> = new Set(["unknown", "in_progress", "mastered", "provisional", "needs_work"]);
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** The ADMIN read for one child. Exported for the tests; call childMastery. */
export const readChildMasteryAdmin: MasteryReader = async (admin, childId) => {
  const [kitQ, objQ] = await Promise.all([
    admin.from("sk_objective_mastery").select("student_id, objective_key, status, updated_at").eq("student_id", childId).limit(300),
    admin.from("mastery_state").select("student_id, teaching_objective_id, status, updated_at").eq("student_id", childId).limit(300),
  ]);
  const kitRows = rowsOf(await kitQ).filter((r) => r.student_id === childId && typeof r.objective_key === "string" && STATUSES.has(String(r.status)));
  const objRows = rowsOf(await objQ).filter((r) => r.student_id === childId && typeof r.teaching_objective_id === "string" && STATUSES.has(String(r.status)));

  // Labels: "<topic_articles.id>:<objective ref>" → the article's objective text.
  const articleIds = [...new Set(kitRows.map((r) => String(r.objective_key).split(":")[0]).filter(Boolean))];
  const objIds = [...new Set(objRows.map((r) => r.teaching_objective_id as string))];
  const [artQ, toQ] = await Promise.all([
    articleIds.length ? admin.from("topic_articles").select("id, title, objectives").in("id", articleIds) : Promise.resolve({ data: [] }),
    objIds.length ? admin.from("teaching_objectives").select("id, text").in("id", objIds) : Promise.resolve({ data: [] }),
  ]);
  const articles = new Map(rowsOf(artQ).map((a) => [a.id as string, a]));
  const objText = new Map(rowsOf(toQ).map((o) => [o.id as string, clip(o.text, 90)]));

  const out: ChildMasteryRow[] = [];
  for (const r of kitRows) {
    const key = r.objective_key as string;
    const idx = key.indexOf(":");
    const art = articles.get(key.slice(0, idx));
    const ref = key.slice(idx + 1);
    const objs = Array.isArray(art?.objectives) ? (art!.objectives as Array<{ id?: unknown; text?: unknown }>) : [];
    const label = clip(objs.find((o) => o?.id === ref)?.text, 90) || clip(art?.title, 90) || ref;
    out.push({ key, status: r.status as MasteryStatus, updatedAt: (r.updated_at as string) ?? null, label, kit: clip(art?.title, 80) || null });
  }
  for (const r of objRows) {
    const key = r.teaching_objective_id as string;
    out.push({ key, status: r.status as MasteryStatus, updatedAt: (r.updated_at as string) ?? null, label: objText.get(key) || "", kit: null });
  }
  return out.filter((r) => r.label);
};

// ── the gate ────────────────────────────────────────────────────────────────

type Wiring = { admin: () => MasteryAdmin | null; reader: MasteryReader };
let override: Partial<Wiring> | null = null;

/** Tests: replace the admin factory and/or the reader; null resets. */
export function __setParentMasteryForTests(w: Partial<Wiring> | null): void {
  override = w;
}

function realAdmin(): MasteryAdmin | null {
  try {
    return createAdminClient() as unknown as MasteryAdmin;
  } catch {
    return null; // no service key (local dev): no mastery, never an error
  }
}

/**
 * The child's mastery rows, or null when the caller may not have them or the
 * read is unavailable. The verified-link check runs FIRST: for any child that
 * is not one of this parent's verified children, neither the admin client nor
 * the reader is touched.
 */
export async function childMastery(ctx: SkContext, childId: string): Promise<ChildMasteryRow[] | null> {
  if (ctx.user.role !== "parent") return null;
  return linkedChildMastery(ctx.children, childId);
}

/**
 * S4 slice E: the same gate for the parent page's "This week" card, which has
 * the parent's own links (context.ts childrenFromLinks: rows of THIS parent
 * only) but no SK Context. The verified-link check (isVerifiedChild) runs
 * FIRST: for a child that is not a verified link, neither the admin client nor
 * the reader is touched.
 */
export async function linkedChildMastery(children: SkChild[] | undefined, childId: string): Promise<ChildMasteryRow[] | null> {
  if (!childId || !isVerifiedChild({ children }, childId)) return null;
  const admin = (override?.admin ?? realAdmin)();
  if (!admin) return null;
  const reader = override?.reader ?? readChildMasteryAdmin;
  try {
    return (await reader(admin, childId)).filter((r) => !!r.key);
  } catch {
    return null;
  }
}
