// Pure logic for the topic catalogue (Library portal, Phase 1 — taxonomy):
// the topic status machine, the candidate-resolution planner, coverage
// arithmetic and the list-page filters. No I/O anywhere in this module, so the
// route handlers and the pages share one answer and the rules are unit-tested
// without a database (topic-catalogue plan §7.2: "The status machine is one
// pure function so the same rules can be unit-tested and mirrored in SQL").

import { canonicalKey } from "./key";
import { pageCount as pageCountOf, pageRange as pageRangeOf } from "../visual-library";
import type {
  AliasSource,
  BankMaturity,
  CandidateSource,
  Coverage,
  TopicCandidate,
  TopicStatus,
} from "./types";

// ── Status machine ───────────────────────────────────────────────────────────

export const TOPIC_STATUSES = [
  "candidate",
  "approved",
  "article_approved",
  "generating",
  "in_review",
  "video_approved",
  "published",
  "retired",
] as const;

export function isTopicStatus(s: unknown): s is TopicStatus {
  return typeof s === "string" && (TOPIC_STATUSES as readonly string[]).includes(s);
}

/** The forward pipeline, one step at a time. */
const FORWARD: Partial<Record<TopicStatus, TopicStatus>> = {
  candidate: "approved",
  approved: "article_approved",
  article_approved: "generating",
  generating: "in_review",
  in_review: "video_approved",
  video_approved: "published",
};

/** Explicit reopenings — the only ways backwards. */
const REOPEN: Partial<Record<TopicStatus, TopicStatus>> = {
  retired: "candidate", // un-retire: back to the start, nothing is assumed
  in_review: "generating", // regenerate the kit
  video_approved: "in_review", // pull an approval
};

/**
 * May a topic move from `from` to `to`?
 *   - forward, one step, in pipeline order
 *   - anything → retired (except retired itself)
 *   - the three explicit reopenings above
 * Nothing else: no skipping, no self-transition.
 */
export function canTransition(from: TopicStatus, to: TopicStatus): boolean {
  if (!isTopicStatus(from) || !isTopicStatus(to)) return false;
  if (from === to) return false;
  if (to === "retired") return true;
  if (FORWARD[from] === to) return true;
  if (REOPEN[from] === to) return true;
  return false;
}

/** Every status reachable from `from`, for building an actions menu. */
export function nextStatuses(from: TopicStatus): TopicStatus[] {
  return TOPIC_STATUSES.filter((to) => canTransition(from, to));
}

/** The reopen target for a status, or null when it cannot be reopened. */
export function reopenTarget(from: TopicStatus): TopicStatus | null {
  return REOPEN[from] ?? null;
}

// ── Candidate resolution ─────────────────────────────────────────────────────
// The route handler executes this plan; the planner never touches the DB.

export type ResolveMode = "merge" | "create" | "dismiss";

export type NewTopicWrite = {
  canonical_key: string;
  title: string;
  subject: string | null;
  status: "candidate";
  created_by: string | null;
};

export type ResolvePlan = {
  mode: ResolveMode;
  /** The topic the aliases/mappings attach to: the merge target, or null for
   *  `create` (the id is only known after the insert) and `dismiss`. */
  topicId: string | null;
  /** The topic to insert (create mode only). */
  topic: NewTopicWrite | null;
  /** Aliases to attach to the (merged or created) topic. */
  aliases: { alias: string; normalized: string; source: AliasSource }[];
  /** Curriculum mappings to attach: a curriculum candidate's node, as `full`. */
  mappings: { node_id: string; coverage: Coverage }[];
  /** The candidate row update. */
  candidate: {
    id: string;
    status: "merged" | "created" | "dismissed";
    resolved_by: string;
    resolved_at: string;
    suggested_topic_id?: string;
  };
};

function aliasSourceFor(kind: CandidateSource): AliasSource {
  return kind === "book" ? "book" : "curriculum";
}

/**
 * Plan the writes that resolve one candidate. Throws on an impossible request
 * (merge without a target; create from a title with no key), so the route can
 * answer 400 before touching anything.
 */
export function resolveCandidate(
  candidate: Pick<TopicCandidate, "id" | "source_kind" | "node_id" | "raw_title" | "suggested_topic_id" | "status">,
  opts: { mode: ResolveMode; topicId?: string | null; actorId: string; subject?: string | null; now?: string },
): ResolvePlan {
  if (candidate.status !== "open") {
    throw new Error(`Candidate is already ${candidate.status}.`);
  }
  const now = opts.now ?? new Date().toISOString();
  const title = (candidate.raw_title ?? "").trim();
  const normalized = canonicalKey(title);
  const source = aliasSourceFor(candidate.source_kind);
  const mappings: ResolvePlan["mappings"] =
    candidate.source_kind === "curriculum" && candidate.node_id
      ? [{ node_id: candidate.node_id, coverage: "full" }]
      : [];

  if (opts.mode === "dismiss") {
    return {
      mode: "dismiss",
      topicId: null,
      topic: null,
      aliases: [],
      mappings: [],
      candidate: { id: candidate.id, status: "dismissed", resolved_by: opts.actorId, resolved_at: now },
    };
  }

  if (opts.mode === "merge") {
    const target = (opts.topicId ?? candidate.suggested_topic_id ?? "").trim();
    if (!target) throw new Error("Merge needs a target topic.");
    return {
      mode: "merge",
      topicId: target,
      topic: null,
      aliases: normalized ? [{ alias: title, normalized, source }] : [],
      mappings,
      candidate: {
        id: candidate.id,
        status: "merged",
        resolved_by: opts.actorId,
        resolved_at: now,
        suggested_topic_id: target,
      },
    };
  }

  // create
  if (!title) throw new Error("Candidate has no title.");
  if (!normalized) throw new Error("Title has no Latin letters or digits, so it has no canonical key.");
  return {
    mode: "create",
    topicId: null,
    topic: {
      canonical_key: normalized,
      title: title.slice(0, 120),
      subject: opts.subject?.trim() || null,
      status: "candidate",
      created_by: opts.actorId,
    },
    aliases: [{ alias: title, normalized, source }],
    mappings,
    candidate: { id: candidate.id, status: "created", resolved_by: opts.actorId, resolved_at: now },
  };
}

// ── Coverage ─────────────────────────────────────────────────────────────────

/** How many of `nodes` have at least one mapping. pct is a whole number. */
export function coverageOf(
  nodes: readonly { id: string }[],
  mappings: readonly { node_id: string }[],
): { covered: number; total: number; pct: number } {
  const ids = new Set(nodes.map((n) => n.id));
  const hit = new Set<string>();
  for (const m of mappings) if (ids.has(m.node_id)) hit.add(m.node_id);
  const total = ids.size;
  const covered = hit.size;
  return { covered, total, pct: total ? Math.round((covered / total) * 100) : 0 };
}

// ── List filters ─────────────────────────────────────────────────────────────

export const TOPIC_PAGE_SIZE = 50;
const PAGE_SIZE_MIN = 10;
const PAGE_SIZE_MAX = 200;

export type TopicFilters = {
  subject: string;
  curriculum: string; // curricula.id
  grade: string;
  status: TopicStatus | "";
  q: string;
  page: number;
  pageSize: number;
};

const asText = (v: string | undefined): string => (v ?? "").trim();

/** Normalise raw searchParams. Unknown values fall back rather than throwing —
 *  a hand-edited URL must not 500 an internal tool (same stance as
 *  visual-library.ts). */
export function parseTopicFilters(sp: Record<string, string | undefined>): TopicFilters {
  const rawPage = Number.parseInt(sp.page ?? "1", 10);
  const rawSize = Number.parseInt(sp.pageSize ?? String(TOPIC_PAGE_SIZE), 10);
  return {
    subject: asText(sp.subject),
    curriculum: asText(sp.curriculum),
    grade: asText(sp.grade),
    status: isTopicStatus(sp.status) ? sp.status : "",
    q: asText(sp.q),
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    pageSize: Number.isFinite(rawSize)
      ? Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, rawSize))
      : TOPIC_PAGE_SIZE,
  };
}

export function hasTopicFilters(f: TopicFilters): boolean {
  return !!(f.subject || f.curriculum || f.grade || f.status || f.q);
}

/** Querystring for a filter change; resets to page 1 unless the patch sets a
 *  page (changing a filter on page 7 otherwise lands on an empty page). */
export function withTopicFilter(f: TopicFilters, patch: Partial<TopicFilters>): string {
  const next: TopicFilters = { ...f, ...patch };
  const p = new URLSearchParams();
  if (next.subject) p.set("subject", next.subject);
  if (next.curriculum) p.set("curriculum", next.curriculum);
  if (next.grade) p.set("grade", next.grade);
  if (next.status) p.set("status", next.status);
  if (next.q) p.set("q", next.q);
  if (next.pageSize !== TOPIC_PAGE_SIZE) p.set("pageSize", String(next.pageSize));
  const page = patch.page ?? 1;
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function pageRange(page: number, size: number = TOPIC_PAGE_SIZE): [number, number] {
  return pageRangeOf(page, size);
}

export function pageCount(total: number, size: number = TOPIC_PAGE_SIZE): number {
  return pageCountOf(total, size);
}

/** PostgREST `or=` expression for a free-text box over `cols`. Commas and
 *  parentheses are stripped because they are the separators of PostgREST's
 *  own or() grammar (see visual-library.ts searchExpression). Null when the
 *  query is blank. */
export function searchOr(q: string, cols: readonly string[]): string | null {
  const safe = q.replace(/[(),*]/g, " ").trim();
  if (!safe) return null;
  return cols.map((c) => `${c}.ilike.%${safe}%`).join(",");
}

// ── Migration-missing detection ──────────────────────────────────────────────

export const CATALOGUE_MIGRATION = "supabase/migrations/0112_topic_catalogue.sql";

/** Postgres "relation does not exist" (42P01) and PostgREST's schema-cache
 *  equivalents: 0112 is not applied. Pages show a banner, routes answer 409
 *  with a hint, like the ops route does for 0110. */
export function catalogueMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "PGRST205" || err.code === "PGRST106") return true;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("could not find the table") || m.includes("schema cache");
}

export const CATALOGUE_MISSING_ERROR = `The topic-catalogue tables are not in this database yet — apply ${CATALOGUE_MIGRATION}.`;

// ── Presentation tones (shared by server and client, so they live here) ─────

export const TOPIC_STATUS_TONE: Record<TopicStatus, string> = {
  candidate: "bg-[#FFF1D6] text-[#9A6400]",
  approved: "bg-[#E6F1FB] text-[#1F5B99]",
  article_approved: "bg-[#E6F1FB] text-[#1F5B99]",
  generating: "bg-[#EDE7FB] text-[#5B3FBF]",
  in_review: "bg-[#EDE7FB] text-[#5B3FBF]",
  video_approved: "bg-[#E6F6F2] text-[#0F7A68]",
  published: "bg-[#E6F6F2] text-[#0F7A68]",
  retired: "bg-[#EEF0EC] text-[#5B6470]",
};

export const MATURITY_TONE: Record<BankMaturity, string> = {
  none: "bg-[#EEF0EC] text-[#5B6470]",
  basic: "bg-[#FFF1D6] text-[#9A6400]",
  good: "bg-[#E6F1FB] text-[#1F5B99]",
  strong: "bg-[#E6F6F2] text-[#0F7A68]",
  assessment: "bg-[#E6F6F2] text-[#0F7A68]",
  exam_ready: "bg-[#E6F6F2] text-[#0F7A68]",
};

/** Roster ids the renderer knows for the persistent teacher
 *  (spike/scene_engine/whiteboard.py: teacher_avatar_for_voice). Empty means
 *  "cast from the voice", as ordinary lessons do. */
export const TEACHER_AVATARS = ["avatar_teacher", "avatar_teacher_female"] as const;
