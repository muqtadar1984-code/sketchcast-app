// SketchCast books as Library books — the pure planning behind the
// founder-only scripts/sk-product-kits.ts (kits, then the SK map).
//
// KITS. One FULL kit per chapter of the product's system book (0175): exactly
// the rows the Library's "Generate full kit" inserts (kitRows — presentation
// first, then deck, lesson plan, activity, worksheet, test paper, case study),
// owned by the book's owner (the catalogue system account), for the book's
// 0-based chapter num, with NO params.part — and params.single_part = true:
// the request that the chapter (≈3k words) be ONE part, one video, not split
// at the worker's MAX_PART_WORDS (1,950). ⚠️ The worker must honour it (and
// must read a PDF-less product book from chapter_grounding.source_text) —
// see docs/sk-product-books.md "Worker prerequisites"; the script refuses
// --apply until --worker-ready says so.
//
// MAP. Once the kits are done, sk_product_kits for the product is REPLACED by
// exactly one row per chapter: chapter_ref = the RELEASE chapter (num + 1, the
// key /sk/[product] and the old map use), the chapter's newest done master
// presentation, label = the final chapter title.
//
// Pure: rows in, decisions out. The script reads and writes; the tests pin this.

import { kitRows, type GenerationRow } from "@/app/dashboard/kit";

/**
 * Estimated cost of ONE full kit, USD. Sources: the worker's measured kit
 * (worker/process.py _book_prelude: "the Sonnet analysis DOMINATES a kit's
 * cost — $2.08"), and the 2026-10 unit-cost note (≈$1.5–1.8 on Gemini
 * credits, ≈$2.2–2.5 on Claude cash). The console's live average is
 * src/utils/kit-cost.ts over jobs.usage — check it before a large batch.
 */
export const KIT_COST_USD = { low: 1.5, point: 2.1, high: 2.5 } as const;

/** Off-peak window for batches (UTC hours [20, 24) ∪ [0, 5)): never in users' hours. */
export const OFF_PEAK_UTC = { from: 20, to: 5 } as const;

export type ProductBookRow = {
  id: string;
  title: string;
  owner_id: string;
  sk_product_id: string;
  storage_path: string | null;
  chapters: { num: number; title?: string | null }[] | null;
};

export type MasterGen = {
  id: string;
  kind: string;
  chapter_ref: string | null;
  status: string;
  params: Record<string, unknown> | null;
  created_at: string;
  removed_at?: string | null;
  withdrawn_at?: string | null;
};

export type ChapterState = "done" | "in_progress" | "failed" | "missing";

export type ChapterPlan = {
  /** books.chapters num (0-based) = generations.chapter_ref */
  num: number;
  /** the release chapter (num + 1) = sk_product_kits.chapter_ref */
  chapter: number;
  title: string;
  state: ChapterState;
  /** the chapter's newest done master presentation, when there is one */
  presentationId: string | null;
  /** what --apply would insert for this chapter ([] unless missing/failed) */
  rows: GenerationRow[];
};

export type KitPlan = {
  chapters: ChapterPlan[];
  toQueue: ChapterPlan[];
  cost: { perKit: typeof KIT_COST_USD; kits: number; low: number; point: number; high: number };
  /** reasons --apply must not run (an empty list = it may) */
  blockers: string[];
};

const live = (g: MasterGen) => !g.removed_at && !g.withdrawn_at;
const hasPart = (g: MasterGen) => g.params != null && g.params.part != null && String(g.params.part) !== "";
const newestFirst = (a: MasterGen, b: MasterGen) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);

export function chaptersOf(book: Pick<ProductBookRow, "chapters">): { num: number; title: string }[] {
  return (Array.isArray(book.chapters) ? book.chapters : [])
    .filter((c) => Number.isInteger(Number(c?.num)))
    .map((c) => ({ num: Number(c.num), title: (c.title ?? "").trim() || `Chapter ${Number(c.num) + 1}` }))
    .sort((a, b) => a.num - b.num);
}

/** The chapter's master presentations (whole chapter, live), newest first. */
function presentations(masters: MasterGen[], num: number): MasterGen[] {
  return masters.filter((g) => g.kind === "presentation" && g.chapter_ref === String(num) && live(g) && !hasPart(g)).sort(newestFirst);
}

export function chapterState(masters: MasterGen[], num: number): { state: ChapterState; presentationId: string | null } {
  const mine = masters.filter((g) => g.chapter_ref === String(num) && live(g));
  const done = presentations(masters, num).find((g) => g.status === "done") ?? null;
  if (done) return { state: "done", presentationId: done.id };
  if (mine.some((g) => g.status === "queued" || g.status === "processing")) return { state: "in_progress", presentationId: null };
  if (presentations(masters, num).some((g) => g.status === "error")) return { state: "failed", presentationId: null };
  return { state: "missing", presentationId: null };
}

/** The rows one chapter's kit inserts: the Library's own kit, single-part, owned by the book's owner. */
export function productKitRows(book: Pick<ProductBookRow, "id" | "owner_id" | "sk_product_id">, num: number): GenerationRow[] {
  return kitRows({ bookId: book.id, schoolId: null, userId: book.owner_id, chapterNum: num }).map((r) => ({
    ...r,
    params: { ...r.params, single_part: true, sk_product: { product_id: book.sk_product_id } },
  }));
}

export function planProductKits(input: { book: ProductBookRow; ownerId: string; masters: MasterGen[]; workerReady: boolean }): KitPlan {
  const { book } = input;
  const chapters = chaptersOf(book).map<ChapterPlan>((c) => {
    const s = chapterState(input.masters, c.num);
    const queue = s.state === "missing" || s.state === "failed";
    return { num: c.num, chapter: c.num + 1, title: c.title, state: s.state, presentationId: s.presentationId, rows: queue ? productKitRows(book, c.num) : [] };
  });
  const toQueue = chapters.filter((c) => c.rows.length > 0);
  const blockers: string[] = [];
  if (book.owner_id !== input.ownerId) blockers.push(`the product book is owned by ${book.owner_id}, not CATALOGUE_OWNER_ID`);
  if (!chapters.length) blockers.push("the product book has no chapters (re-import the release)");
  if (!book.storage_path && !input.workerReady)
    blockers.push("the worker cannot build a PDF-less product book yet: deploy the worker change (docs/sk-product-books.md) and pass --worker-ready");
  if (chapters.some((c) => c.state === "in_progress")) blockers.push("a chapter's kit is still being made; wait for it");
  const n = toQueue.length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    chapters,
    toQueue,
    cost: { perKit: KIT_COST_USD, kits: n, low: r2(n * KIT_COST_USD.low), point: r2(n * KIT_COST_USD.point), high: r2(n * KIT_COST_USD.high) },
    blockers,
  };
}

/** Production rule: never start (or continue) while anyone's job is waiting or running. */
export function busyJobs(jobs: { status: string }[]): number {
  return jobs.filter((j) => j.status === "queued" || j.status === "processing").length;
}

export function offPeak(now: Date): boolean {
  const h = now.getUTCHours();
  return h >= OFF_PEAK_UTC.from || h < OFF_PEAK_UTC.to;
}

/** A queued kit is finished when every row is done or error; failed when its lesson errored. */
export function kitOutcome(rows: { kind: string; status: string }[]): "running" | "done" | "failed" {
  if (rows.some((r) => r.status !== "done" && r.status !== "error")) return "running";
  return rows.find((r) => r.kind === "presentation")?.status === "done" ? "done" : "failed";
}

// ── the SK map ──────────────────────────────────────────────────────────────

export type MapRow = { product_id: string; chapter_ref: string; sort: number; generation_id: string; label: string | null };

export type MapPlan = { before: MapRow[]; after: MapRow[]; missing: { chapter: number; title: string }[] };

export function planProductKitMap(input: { book: ProductBookRow; masters: MasterGen[]; current: MapRow[] }): MapPlan {
  const after: MapRow[] = [];
  const missing: MapPlan["missing"] = [];
  for (const c of chaptersOf(input.book)) {
    const s = chapterState(input.masters, c.num);
    if (s.state === "done" && s.presentationId) {
      after.push({ product_id: input.book.sk_product_id, chapter_ref: String(c.num + 1), sort: 0, generation_id: s.presentationId, label: c.title });
    } else missing.push({ chapter: c.num + 1, title: c.title });
  }
  const before = input.current
    .filter((r) => r.product_id === input.book.sk_product_id)
    .slice()
    .sort((a, b) => Number(a.chapter_ref) - Number(b.chapter_ref) || a.sort - b.sort);
  return { before, after, missing };
}

/** The map rows to delete once `after` is written: everything of the product that is not in `after`. */
export function staleMapRows(plan: MapPlan): MapRow[] {
  const keep = new Set(plan.after.map((r) => `${r.chapter_ref}|${r.generation_id}`));
  return plan.before.filter((r) => !keep.has(`${r.chapter_ref}|${r.generation_id}`));
}
