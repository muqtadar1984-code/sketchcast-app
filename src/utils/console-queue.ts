// /console/queue — pure aggregation over the live job queue (surge plan §4.1).
//
// Replaces the hand-run SQL from 2026-10-22, when one teacher's Generate all
// queued ~250 jobs and staff had to query prod to see who was waiting, how long
// it would take, and which rows were duplicates or parts the book no longer
// had. The page reads rows with the service role; everything that DECIDES what
// to show lives here so it can be tested without a database.

export type LiveJob = {
  id: string;
  type: string;
  status: "queued" | "processing";
  created_at: string;
  owner_id: string | null;
  book_id: string | null;
};

export type OwnerRow = {
  ownerId: string;
  queued: number;
  processing: number;
  errors2h: number;
  oldestQueuedAt: string | null;
  /** Minutes to drain this owner's queue at the measured system rate. An
   *  upper-ish bound under FIFO: the owner shares the rate with everyone. */
  drainMin: number;
  books: string[];
};

export type Strip = {
  queued: number;
  processing: number;
  ownersWaiting: number;
  oldestQueuedAt: string | null;
  byLane: { type: string; queued: number; processing: number }[];
};

export function summarise(jobs: readonly LiveJob[]): Strip {
  const lanes = new Map<string, { queued: number; processing: number }>();
  const waiting = new Set<string>();
  let oldest: string | null = null;
  let queued = 0;
  let processing = 0;
  for (const j of jobs) {
    const l = lanes.get(j.type) ?? { queued: 0, processing: 0 };
    l[j.status]++;
    lanes.set(j.type, l);
    if (j.status === "queued") {
      queued++;
      waiting.add(j.owner_id ?? "system");
      if (!oldest || j.created_at < oldest) oldest = j.created_at;
    } else processing++;
  }
  return {
    queued,
    processing,
    ownersWaiting: waiting.size,
    oldestQueuedAt: oldest,
    byLane: [...lanes].map(([type, c]) => ({ type, ...c })).sort((a, b) => b.queued + b.processing - (a.queued + a.processing)),
  };
}

export function byOwner(
  jobs: readonly LiveJob[],
  errors2h: ReadonlyMap<string, number>,
  ratePerMin: number,
): OwnerRow[] {
  const m = new Map<string, OwnerRow>();
  for (const j of jobs) {
    const id = j.owner_id ?? "system";
    const r =
      m.get(id) ??
      { ownerId: id, queued: 0, processing: 0, errors2h: errors2h.get(id) ?? 0, oldestQueuedAt: null, drainMin: 0, books: [] };
    r[j.status]++;
    if (j.status === "queued" && (!r.oldestQueuedAt || j.created_at < r.oldestQueuedAt)) r.oldestQueuedAt = j.created_at;
    if (j.book_id && !r.books.includes(j.book_id)) r.books.push(j.book_id);
    m.set(id, r);
  }
  // Owners with recent failures but nothing live still deserve a row: a burst
  // that has just finished failing is exactly what staff come here to see.
  for (const [id, n] of errors2h) if (!m.has(id) && n > 0)
    m.set(id, { ownerId: id, queued: 0, processing: 0, errors2h: n, oldestQueuedAt: null, drainMin: 0, books: [] });
  const rate = Math.max(0.2, ratePerMin);
  return [...m.values()]
    .map((r) => ({ ...r, drainMin: Math.ceil(r.queued / rate) }))
    .sort((a, b) => b.queued - a.queued || b.processing - a.processing || b.errors2h - a.errors2h);
}

// ── Per-book grid ───────────────────────────────────────────────────────────

export type GenRow = {
  id: string;
  kind: string;
  status: string;
  chapter_ref: string | null;
  part: number | null;
  created_at: string;
};

export type GridCell = {
  kind: string;
  rows: GenRow[];
  /** >1 non-error row for the same unit+kind — a re-click (2026-10-22: 4 kits). */
  duplicate: boolean;
};

export type GridUnit = {
  chapterRef: string | null;
  part: number | null;
  /** The chapter's stored part count no longer has this part (0152's rule). */
  orphan: boolean;
  cells: GridCell[];
};

export const GRID_KINDS = ["presentation", "deck", "lesson_plan", "worksheet", "exam_paper", "case_study", "activity"];

/** Units (chapter × part) × kinds for one book, newest generations considered.
 *  `partCounts` maps chapter num → stored part count (null/0 = no map). */
export function bookGrid(gens: readonly GenRow[], partCounts: ReadonlyMap<string, number>): GridUnit[] {
  const units = new Map<string, GridUnit>();
  for (const g of gens) {
    const key = `${g.chapter_ref ?? "-"}:${g.part ?? "-"}`;
    let u = units.get(key);
    if (!u) {
      const total = g.chapter_ref !== null ? partCounts.get(g.chapter_ref) ?? 0 : 0;
      u = {
        chapterRef: g.chapter_ref,
        part: g.part,
        orphan: g.part !== null && total > 0 && g.part > total,
        cells: [],
      };
      units.set(key, u);
    }
    let c = u.cells.find((x) => x.kind === g.kind);
    if (!c) {
      c = { kind: g.kind, rows: [], duplicate: false };
      u.cells.push(c);
    }
    c.rows.push(g);
    c.duplicate = c.rows.filter((r) => r.status !== "error").length > 1;
  }
  const num = (s: string | null) => (s === null ? -1 : Number(s));
  return [...units.values()].sort(
    (a, b) => num(a.chapterRef) - num(b.chapterRef) || (a.part ?? 0) - (b.part ?? 0),
  );
}

/** The generations "Cancel duplicates" removes: in every duplicate cell, keep
 *  the MOST ADVANCED kit (done, then building, then queued; oldest on a tie)
 *  and take the rest that are still QUEUED. A duplicate already building or
 *  built is left alone — cancelling it would waste the work, and the cancel
 *  RPC refunds only what never started. */
export function duplicatesToCancel(gens: readonly GenRow[]): string[] {
  const out: string[] = [];
  for (const u of bookGrid(gens, new Map()))
    for (const c of u.cells) {
      if (!c.duplicate) continue;
      const rank = (st: string) => (st === "done" ? 0 : st === "processing" ? 1 : 2);
      const live = c.rows
        .filter((r) => r.status !== "error")
        .sort((a, b) => rank(a.status) - rank(b.status) || a.created_at.localeCompare(b.created_at));
      for (const r of live.slice(1)) if (r.status === "queued") out.push(r.id);
    }
  return out;
}
