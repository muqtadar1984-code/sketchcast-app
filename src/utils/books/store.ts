import "server-only";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createAdminClient } from "@/utils/supabase/admin";
import type {
  Annotation,
  Approval,
  Artifact,
  BookRevision,
  ChapterRevision,
  ChapterSummary,
  CostLine,
  Finding,
  OpenItem,
  Run,
  Stage,
  Work,
} from "./types";

// Read-only access to the book app's store (0161, pub_* tables). Service role
// only — callers have already passed requireBookMember()/isBookMemberRequest().
//
// Development fixture: with BOOKS_FIXTURE=<path to an importer bundle> and
// NODE_ENV !== "production", every read comes from that bundle instead of the
// database — the SAME rows the importer would load — so the screens can be
// checked locally without touching production. Never honoured in production.

type Row = Record<string, unknown>;
type Filters = Record<string, string | number | null>;
type Bundle = { tables: Record<string, Row[]>; uploads: { path: string; key: string }[] };

let bundleCache: { path: string; mtime: number; bundle: Bundle } | null = null;

export function fixturePath(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  return process.env.BOOKS_FIXTURE || null;
}

function fixture(): Bundle | null {
  const path = fixturePath();
  if (!path) return null;
  const mtime = statSync(/*turbopackIgnore: true*/ path).mtimeMs;
  if (bundleCache?.path !== path || bundleCache.mtime !== mtime) {
    const bundle = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf-8")) as Bundle;
    // bundles carry no database ids: number the rows the way serial ids would
    for (const rows of Object.values(bundle.tables)) rows.forEach((r, i) => (r.id ??= i + 1));
    bundleCache = { path, mtime, bundle };
  }
  return bundleCache.bundle;
}

/**
 * Development only: what the app wrote locally (BOOKS_RUNS_FILE — in-app approvals, finding rulings) on top of the
 * importer bundle's rows, so the triage and approval screens can be exercised without production.
 */
function overlay(table: string, rows: Row[]): Row[] {
  const path = process.env.BOOKS_RUNS_FILE;
  if (!path || !existsSync(/*turbopackIgnore: true*/ path)) return rows;
  const d = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf-8")) as Record<string, Row[] | Record<string, Row>>;
  if (table === "pub_works") {
    const patch = (d.pub_works_patch ?? {}) as Record<string, Row>;
    return rows.map((r) => (patch[String(r.uid)] ? { ...r, ...patch[String(r.uid)] } : r));
  }
  if (table === "pub_findings") {
    const patch = (d.pub_findings_patch ?? {}) as Record<string, Row>;
    return rows.map((r) => (patch[String(r.id)] ? { ...r, ...patch[String(r.id)] } : r));
  }
  const extra = d[table];
  return Array.isArray(extra) ? [...rows, ...extra] : rows;
}

/** The local file behind an S3 key, from the fixture's upload list (development only). */
export function fixtureFileFor(key: string): string | null {
  const b = fixture();
  return b?.uploads.find((u) => u.key === key)?.path ?? null;
}

async function select<T>(
  table: string,
  filters: Filters,
  opts: { columns?: string[]; order?: [string, boolean][]; limit?: number } = {},
): Promise<T[]> {
  const fx = fixture();
  if (fx) {
    let rows = overlay(table, fx.tables[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    for (const [col, asc] of [...(opts.order ?? [])].reverse()) {
      rows = [...rows].sort((a, b) => cmp(a[col], b[col]) * (asc ? 1 : -1));
    }
    if (opts.limit) rows = rows.slice(0, opts.limit);
    if (opts.columns) rows = rows.map((r) => Object.fromEntries(opts.columns!.map((c) => [c, r[c]])));
    return rows as T[];
  }
  const admin = createAdminClient();
  let q = admin.from(table).select(opts.columns ? opts.columns.join(",") : "*");
  for (const [k, v] of Object.entries(filters)) q = v === null ? q.is(k, null) : q.eq(k, v);
  for (const [col, asc] of opts.order ?? []) q = q.order(col, { ascending: asc, nullsFirst: false });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
}

// ── reads ───────────────────────────────────────────────────────────────────

export function listWorks(): Promise<Work[]> {
  return select<Work>("pub_works", {}, { order: [["title", true]] });
}

export async function getWork(slug: string): Promise<Work | null> {
  return (await select<Work>("pub_works", { slug }, { limit: 1 }))[0] ?? null;
}

export function listRevisions(workUid: string): Promise<BookRevision[]> {
  return select<BookRevision>("pub_book_revisions", { work_uid: workUid }, { order: [["ordinal", true]] });
}

const SUMMARY_COLUMNS = ["id", "revision_key", "chapter", "title", "content_sha256", "figure_refs", "words", "questions", "source_path"];

/** Every chapter of every revision, without the text (for the chapter list and the "what changed" grid). */
export function listChapterSummaries(workUid: string): Promise<ChapterSummary[]> {
  return select<ChapterSummary>("pub_chapter_revisions", { work_uid: workUid }, {
    columns: SUMMARY_COLUMNS,
    order: [["chapter", true]],
  });
}

export async function getChapter(workUid: string, revisionKey: string, chapter: number): Promise<ChapterRevision | null> {
  const rows = await select<ChapterRevision>("pub_chapter_revisions", {
    work_uid: workUid,
    revision_key: revisionKey,
    chapter,
  }, { limit: 1 });
  return rows[0] ?? null;
}

export function listStages(workUid: string): Promise<Stage[]> {
  return select<Stage>("pub_stages", { work_uid: workUid }, { order: [["ordinal", true]] });
}

export function listApprovals(workUid: string): Promise<Approval[]> {
  return select<Approval>("pub_approvals", { work_uid: workUid }, { order: [["approved_on", true], ["id", true]] });
}

export function listRuns(workUid: string): Promise<Run[]> {
  return select<Run>("pub_runs", { work_uid: workUid }, { order: [["id", true]] });
}

export function listFindings(workUid: string): Promise<Finding[]> {
  return select<Finding>("pub_findings", { work_uid: workUid }, { order: [["chapter", true], ["finding_key", true]] });
}

export function listArtifacts(workUid: string): Promise<Artifact[]> {
  return select<Artifact>("pub_artifacts", { work_uid: workUid }, { order: [["rel_path", true]] });
}

export async function getArtifact(workUid: string, id: number): Promise<Artifact | null> {
  return (await select<Artifact>("pub_artifacts", { work_uid: workUid, id }, { limit: 1 }))[0] ?? null;
}

export function listCostLines(workUid: string): Promise<CostLine[]> {
  return select<CostLine>("pub_cost_lines", { work_uid: workUid }, {
    columns: ["stage_key", "revision_key", "chapter", "model", "role", "usd", "run_id"],
  });
}

export function listOpenItems(workUid: string): Promise<OpenItem[]> {
  return select<OpenItem>("pub_open_items", { work_uid: workUid }, { order: [["id", true]] });
}

export function listAnnotations(workUid: string): Promise<Annotation[]> {
  return select<Annotation>("pub_annotations", { work_uid: workUid });
}
