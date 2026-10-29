// SK S3 slice D — the student tutor's reads for the SK Shell (tutor.where,
// tutor.progress, the student greeting). Server only (it reaches kit-server).
//
// NOTHING HERE DUPLICATES THE KIT ROUTES. The kit is opened through their own
// order (kit-server.ts): resolveKit (book access → the chapter's mapped kits →
// canOpenKit) and readyManifest; the sections are kit-view's kitSegments; a
// section's items are kit-view's practiseItemIds; an item's objective key is
// the remediation bank's objectiveKeys (the same read the answer route makes);
// "what's next" is kit-player's nextMove. The tutor state the client sends
// only says WHICH kit the student is looking at — a kit the student may not
// open answers "refused" here exactly as /api/sk/kit would.
//
// THE STUDENT'S OWN ROWS ONLY. Mastery (sk_objective_mastery) and the open kit
// session (sk_sessions + item_attempts) are read through the USER-SESSION
// client — RLS lets a student read only her own rows (0157, 0170) — and every
// query also filters `student_id = me`, and the rows that come back are
// filtered once more, so a fake (or a policy mistake) can never surface
// another learner's data.

import { kitDeps, readyManifest, resolveKit, type KitDeps } from "./kit-server";
import { kitSessionProduct } from "./kit-answer";
import { nextMove, type KitSegmentView } from "./kit-player";
import { kitItemIds, kitSegments, practiseItemIds } from "./kit-view";
import type { KitManifest } from "./manifest/derive";
import { compareChapterRef } from "./product-kits";
import type { SkSessionDb } from "./shell/types";

export type MasteryStatus = "unknown" | "in_progress" | "mastered" | "provisional" | "needs_work";

/** One kit objective, named by the heading of the first section that practises it. */
export type KitObjective = { key: string; heading: string; index: number };

export type TutorKit = {
  product: string;
  chapter: string;
  generationId: string;
  title: string;
  manifest: KitManifest;
  sections: KitSegmentView[];
  objectives: KitObjective[];
};

export type TutorKitRef = { product: string; chapter: string; kit: string | null };

export type LoadedKit = { ok: true; kit: TutorKit } | { ok: false; reason: "refused" | "preparing" };

/** The kit as the kit routes open it, plus its objectives in section order. */
export async function loadTutorKit(userId: string, ref: TutorKitRef, deps: KitDeps = kitDeps()): Promise<LoadedKit> {
  const r = await resolveKit(deps, userId, { product: ref.product, chapter: ref.chapter, kit: ref.kit });
  if (!r.ok) return { ok: false, reason: "refused" };
  const ready = await readyManifest(deps, r);
  if (!ready) return { ok: false, reason: "preparing" };
  const manifest = ready.manifest;
  const sections = kitSegments(manifest);
  const ids = [...kitItemIds(manifest)];
  const keys = ids.length ? await deps.bank(ready.admin).objectiveKeys(ids) : {};
  const objectives: KitObjective[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    for (const id of practiseItemIds(manifest, s.key)) {
      const key = keys[id];
      if (!key || seen.has(key)) continue;
      seen.add(key);
      objectives.push({ key, heading: s.heading, index: s.index });
    }
  }
  return { ok: true, kit: { product: r.product.slug, chapter: r.kit.chapterRef, generationId: r.kit.generationId, title: r.kit.title, manifest, sections, objectives } };
}

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => {
  const d = (r as { data?: unknown; error?: unknown } | null)?.data;
  if ((r as { error?: unknown } | null)?.error) throw new Error("[sk tutor] read failed");
  return Array.isArray(d) ? (d as Row[]) : [];
};

/** The student's mastery on these objective keys — her own rows only. */
export async function readObjectiveMastery(session: SkSessionDb, studentId: string, keys: readonly string[]): Promise<Record<string, MasteryStatus>> {
  if (!keys.length) return {};
  const rows = rowsOf(await session.from("sk_objective_mastery").select("student_id, objective_key, status").eq("student_id", studentId).in("objective_key", [...keys]));
  const out: Record<string, MasteryStatus> = {};
  for (const r of rows) {
    if (r.student_id !== studentId) continue; // never another learner's row
    if (typeof r.objective_key === "string" && keys.includes(r.objective_key)) out[r.objective_key] = r.status as MasteryStatus;
  }
  return out;
}

/** The student's kit session(s) for this kit: the items she has answered, newest last. */
export async function readKitAttempts(session: SkSessionDb, studentId: string, generationId: string): Promise<Array<{ itemId: string; at: string }>> {
  const sessions = rowsOf(await session.from("sk_sessions").select("id, student_id").eq("student_id", studentId).eq("product_id", kitSessionProduct(generationId)));
  const ids = sessions.filter((s) => s.student_id === studentId && typeof s.id === "string").map((s) => s.id as string);
  if (!ids.length) return [];
  const rows = rowsOf(await session.from("item_attempts").select("student_id, item_id, at").eq("student_id", studentId).in("session_id", ids));
  return rows
    .filter((r) => r.student_id === studentId && typeof r.item_id === "string")
    .map((r) => ({ itemId: r.item_id as string, at: String(r.at ?? "") }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Kit-wide indices of the sections whose items she has answered. */
export function practisedSections(kit: Pick<TutorKit, "manifest" | "sections">, answered: readonly string[]): number[] {
  const done = new Set(answered);
  return kit.sections.filter((s) => practiseItemIds(kit.manifest, s.key).some((id) => done.has(id))).map((s) => s.index);
}

// ── tutor.where: deterministic ──────────────────────────────────────────────

export type WhereNext =
  | { kind: "weak"; index: number; heading: string; key: string }
  | { kind: "watch" | "practise"; index: number; heading: string }
  | { kind: "done" };

/**
 * What's next, the same answer for the same inputs:
 *   1. the first kit objective (in section order) whose mastery is needs_work
 *      → go over its section again;
 *   2. else kit-player's nextMove over the sections — the current section
 *      unwatched, then onwards (wrapping), then the unpractised ones;
 *   3. else done.
 * `current` is the player's position (an index into `sections`).
 */
export function whereNext(input: {
  sections: readonly KitSegmentView[];
  objectives: readonly KitObjective[];
  mastery: Readonly<Record<string, MasteryStatus>>;
  current: number;
  watched: readonly number[];
  practised: readonly number[];
}): WhereNext {
  const weak = input.objectives.find((o) => input.mastery[o.key] === "needs_work");
  if (weak) return { kind: "weak", index: weak.index, heading: weak.heading, key: weak.key };
  const m = nextMove({ segments: input.sections, current: input.current, watched: input.watched, practised: input.practised });
  if (m.kind === "done") return m;
  const s = input.sections[m.index];
  return { kind: m.kind, index: m.index, heading: s?.heading ?? "" };
}

// ── tutor.progress ──────────────────────────────────────────────────────────

export type ProgressGroups = { mastered: string[]; provisional: string[]; needs_work: string[] };

/** The kit's objectives by mastery status, named by section heading, in kit order (each once). */
export function progressGroups(objectives: readonly KitObjective[], mastery: Readonly<Record<string, MasteryStatus>>): ProgressGroups {
  const out: ProgressGroups = { mastered: [], provisional: [], needs_work: [] };
  for (const o of objectives) {
    const st = mastery[o.key];
    if (st !== "mastered" && st !== "provisional" && st !== "needs_work") continue;
    const list = out[st];
    const name = o.heading || o.key;
    if (!list.includes(name)) list.push(name);
  }
  return out;
}

// ── the student's chapters (greeting fallback, tutor.where without a kit) ───

export type StudentChapter = { product: string; chapterRef: string; title: string; generationId: string };

/** Every mapped kit chapter on the products she has book access to (one entry
 *  per chapter, its first kit), in book then chapter order. `products` are the
 *  slugs she can see (sk_book_products through RLS). */
export async function studentChapters(userId: string, products: readonly string[], deps: KitDeps = kitDeps(), max = 12): Promise<StudentChapter[]> {
  const out: StudentChapter[] = [];
  for (const slug of products) {
    const e = await deps.kits.entitled(userId, slug);
    if (!e.ok) continue;
    const kits = await deps.kits.kitsForProduct(e.product.id);
    const byChapter = new Map<string, StudentChapter>();
    for (const k of kits) if (!byChapter.has(k.chapterRef)) byChapter.set(k.chapterRef, { product: e.product.slug, chapterRef: k.chapterRef, title: k.label || k.title, generationId: k.generationId });
    out.push(...[...byChapter.values()].sort((a, b) => compareChapterRef(a.chapterRef, b.chapterRef)));
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/** The product slugs she can see (approved products, through RLS). */
export async function visibleProducts(session: SkSessionDb): Promise<string[]> {
  const rows = rowsOf(await session.from("sk_book_products").select("slug"));
  return rows.map((r) => r.slug).filter((s): s is string => typeof s === "string").sort();
}

/** Where a kit sits in her books: the first entitled product that maps it. */
export async function findKitChapter(userId: string, products: readonly string[], generationId: string, deps: KitDeps = kitDeps()): Promise<{ product: string; chapter: string } | null> {
  for (const slug of products) {
    const e = await deps.kits.entitled(userId, slug);
    if (!e.ok) continue;
    const hit = (await deps.kits.kitsForProduct(e.product.id)).find((k) => k.generationId === generationId);
    if (hit) return { product: e.product.slug, chapter: hit.chapterRef };
  }
  return null;
}

/** The kit she last answered a question in: its generation and the item. */
export async function lastKitSession(session: SkSessionDb, studentId: string): Promise<{ generationId: string } | null> {
  const rows = rowsOf(await session.from("sk_sessions").select("student_id, product_id, updated_at").eq("student_id", studentId).order("updated_at", { ascending: false }).limit(20));
  for (const r of rows) {
    if (r.student_id !== studentId || typeof r.product_id !== "string") continue;
    const m = /^kit:([0-9a-f-]{36})$/i.exec(r.product_id);
    if (m) return { generationId: m[1]!.toLowerCase() };
  }
  return null;
}
