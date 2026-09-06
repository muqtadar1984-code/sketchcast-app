// Pure logic for the topic catalogue (Library portal, Phase 1 — taxonomy;
// Phase 2a — the catalogue layer): the topic status machine, node kinds and
// the curriculum tree, the candidate-resolution planner, coverage arithmetic
// and the list-page filters. No I/O anywhere in this module, so the route
// handlers and the pages share one answer and the rules are unit-tested
// without a database (topic-catalogue plan §7.2: "The status machine is one
// pure function so the same rules can be unit-tested and mirrored in SQL").

import { canonicalKey } from "./key";
import { pageCount as pageCountOf, pageRange as pageRangeOf } from "../visual-library";
import type {
  AliasSource,
  BankMaturity,
  CandidateSource,
  Coverage,
  NodeKind,
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

// ── Node kinds ───────────────────────────────────────────────────────────────
// 0113 made the level of a curriculum node a column (curriculum_nodes.kind).
// It is nullable — a seed may leave it unset — so the portal resolves it the
// way the 0113 backfill did: the column first, then the code's shape. Depth is
// never used to decide grouping: new curricula (IB, Pearson, ICSE…) will not
// share the shipped shapes, and a flat seed has no depth at all.

export const NODE_KINDS = ["strand", "sub_strand", "objective", "unit", "chapter", "topic"] as const;

export function isNodeKind(k: unknown): k is NodeKind {
  return typeof k === "string" && (NODE_KINDS as readonly string[]).includes(k);
}

/** The code shapes of the two shipped seeds — the same patterns 0113 backfills
 *  from, so a row the migration filled and a row it did not resolve alike. */
const CAMBRIDGE_OBJECTIVE = /^[0-9](Bs|Bp|Be|Cm|Cp|Cc|Pf|Pl|Ps|ESp|ESc|ESs|TWSm|TWSp|TWSc|TWSa|SIC)\.[0-9]{2}$/;
const CAMBRIDGE_GROUP = /^[0-9]\//;
const CBSE_CHAPTER = /^cbse:[0-9]+:ch[0-9]+$/;
const CBSE_UNIT = /^cbse:[0-9]+:U[0-9]+$/;
const CBSE_TOPIC = /^cbse:[0-9]+:U[0-9]+:[0-9]+$/;

/** A node's level: `kind` when set, else inferred from the code's shape (the
 *  0113 backfill rules), else null — the caller then falls back to "has
 *  children ⇒ group, otherwise leaf". */
export function nodeKind(n: { kind?: string | null; code: string; parent_id?: string | null }): NodeKind | null {
  if (isNodeKind(n.kind)) return n.kind;
  const code = (n.code ?? "").trim();
  if (CAMBRIDGE_OBJECTIVE.test(code)) return "objective";
  if (CAMBRIDGE_GROUP.test(code)) return n.parent_id ? "sub_strand" : "strand";
  if (CBSE_CHAPTER.test(code)) return "chapter";
  if (CBSE_UNIT.test(code)) return "unit";
  if (CBSE_TOPIC.test(code)) return "topic";
  return null;
}

/** Groups hold other nodes; leaves are the atoms a topic maps to. */
export function isGroupKind(k: NodeKind | null | undefined): boolean {
  return k === "strand" || k === "sub_strand" || k === "unit";
}

export const NODE_KIND_LABEL: Record<NodeKind, string> = {
  strand: "strand",
  sub_strand: "sub-strand",
  objective: "objective",
  unit: "unit",
  chapter: "chapter",
  topic: "topic",
};

// ── Curriculum tree ──────────────────────────────────────────────────────────
// parent_id links the nodes; the tree is built once per page and shared by the
// coverage arithmetic, the grouping and the create-from-node children list.

export type TreeNode = { id: string; parent_id: string | null };

export type NodeTree = {
  /** id → parent id (null for a root, or when the parent is not in the set). */
  parent: ReadonlyMap<string, string | null>;
  /** id → direct children, in the order the nodes were given. */
  children: ReadonlyMap<string, readonly string[]>;
};

export function nodeTree(nodes: readonly TreeNode[]): NodeTree {
  const ids = new Set(nodes.map((n) => n.id));
  const parent = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    const p = n.parent_id && ids.has(n.parent_id) && n.parent_id !== n.id ? n.parent_id : null;
    parent.set(n.id, p);
    if (p) {
      const list = children.get(p) ?? [];
      list.push(n.id);
      children.set(p, list);
    }
  }
  return { parent, children };
}

export function childrenOf(tree: NodeTree, id: string): readonly string[] {
  return tree.children.get(id) ?? [];
}

/** Every node below `id` (not `id` itself), depth-first in sibling order. */
export function descendantsOf(tree: NodeTree, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const stack = [...childrenOf(tree, id)].reverse();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    const kids = childrenOf(tree, cur);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/** The atoms under a group: its descendants that have no children of their
 *  own — a sub-strand's objectives, a unit's topics. A leaf's own list is
 *  empty (it IS the atom). */
export function leafDescendants(tree: NodeTree, id: string): string[] {
  return descendantsOf(tree, id).filter((d) => childrenOf(tree, d).length === 0);
}

/** The children "Create topic from node" offers to map: the node's direct
 *  children that are objectives (by kind), or, when none is, the direct
 *  children that are leaves. A leaf node offers nothing (it maps itself). */
export function mappableChildren<T extends { id: string; kind?: string | null; code: string; parent_id?: string | null }>(
  tree: NodeTree,
  id: string,
  byId: ReadonlyMap<string, T>,
): T[] {
  const kids = childrenOf(tree, id)
    .map((k) => byId.get(k))
    .filter((k): k is T => !!k);
  const objectives = kids.filter((k) => nodeKind(k) === "objective");
  if (objectives.length) return objectives;
  return kids.filter((k) => childrenOf(tree, k.id).length === 0);
}

/** The nodes the topics list offers as a "sub-strand / unit" filter: kind
 *  sub_strand or unit, or — kind unresolvable — a node whose children are all
 *  leaves. Never a strand (too coarse) or a leaf (that is a mapping, not a filter). */
export function groupNodes<T extends { id: string; kind?: string | null; code: string; parent_id?: string | null }>(
  nodes: readonly T[],
  tree: NodeTree = nodeTree(nodes as readonly TreeNode[]),
): T[] {
  return nodes.filter((n) => {
    const k = nodeKind(n);
    if (k === "sub_strand" || k === "unit") return true;
    if (k !== null) return false;
    const kids = childrenOf(tree, n.id);
    return kids.length > 0 && kids.every((c) => childrenOf(tree, c).length === 0);
  });
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
  /** Curriculum mappings to attach, all `full`: a curriculum candidate's
   *  node_ids (the objectives a grouped candidate proposes), or its node_id
   *  when node_ids is empty. Deduplicated; a book candidate has none. */
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

/** The nodes a curriculum candidate maps when created or merged: node_ids
 *  (a grouped candidate's objectives) when it has any, else its anchor
 *  node_id. Order kept, duplicates and blanks dropped; a book candidate maps
 *  nothing. The anchor is NOT added alongside node_ids: the group is covered
 *  through its objectives (coverageOf), not by a mapping of its own. */
export function candidateMappingNodes(
  candidate: Pick<TopicCandidate, "source_kind" | "node_id"> & { node_ids?: readonly string[] | null },
): string[] {
  if (candidate.source_kind !== "curriculum") return [];
  const ids = (candidate.node_ids ?? []).map((v) => (v ?? "").trim()).filter(Boolean);
  const unique = [...new Set(ids)];
  if (unique.length) return unique;
  return candidate.node_id ? [candidate.node_id] : [];
}

/**
 * Plan the writes that resolve one candidate. Throws on an impossible request
 * (merge without a target; create from a title with no key), so the route can
 * answer 400 before touching anything.
 */
export function resolveCandidate(
  candidate: Pick<TopicCandidate, "id" | "source_kind" | "node_id" | "raw_title" | "suggested_topic_id" | "status"> & {
    node_ids?: readonly string[] | null;
  },
  opts: { mode: ResolveMode; topicId?: string | null; actorId: string; subject?: string | null; now?: string },
): ResolvePlan {
  if (candidate.status !== "open") {
    throw new Error(`Candidate is already ${candidate.status}.`);
  }
  const now = opts.now ?? new Date().toISOString();
  const title = (candidate.raw_title ?? "").trim();
  const normalized = canonicalKey(title);
  const source = aliasSourceFor(candidate.source_kind);
  const mappings: ResolvePlan["mappings"] = candidateMappingNodes(candidate).map((node_id) => ({ node_id, coverage: "full" }));

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
// Mappings may point at objectives OR at groups (a Phase 1 "create from node"
// on a sub-strand mapped the sub-strand itself; Phase 2 maps the objectives).
// With the tree, a node counts as covered when
//   • it has a mapping of its own, or
//   • an ancestor has one (a topic that covers the sub-strand covers each of
//     its objectives), or
//   • it has children and every one of them is covered (a sub-strand whose
//     five objectives are all mapped is covered — plan Phase 2a).
// Without the tree (no third argument) only the first rule applies, which is
// what the Phase 1 callers and tests expect.

/** Every node id the rules above cover. */
export function coveredSet(mappings: readonly { node_id: string }[], tree: NodeTree): Set<string> {
  const direct = new Set(mappings.map((m) => m.node_id));
  const memo = new Map<string, boolean>();
  const inheritedFromAbove = (id: string): boolean => {
    let p = tree.parent.get(id) ?? null;
    const seen = new Set<string>([id]);
    while (p && !seen.has(p)) {
      if (direct.has(p)) return true;
      seen.add(p);
      p = tree.parent.get(p) ?? null;
    }
    return false;
  };
  const covered = (id: string, path: Set<string>): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (direct.has(id) || inheritedFromAbove(id)) {
      memo.set(id, true);
      return true;
    }
    const kids = childrenOf(tree, id);
    let result = false;
    if (kids.length && !path.has(id)) {
      path.add(id);
      result = kids.every((k) => covered(k, path));
      path.delete(id);
    }
    memo.set(id, result);
    return result;
  };
  const out = new Set<string>();
  for (const id of tree.parent.keys()) if (covered(id, new Set())) out.add(id);
  // Mapped ids outside the tree (a node the page did not load) still count for themselves.
  for (const id of direct) out.add(id);
  return out;
}

/** How many of `nodes` are covered — by a mapping of their own, or (with
 *  `tree`) through the rules above. pct is a whole number. */
export function coverageOf(
  nodes: readonly { id: string }[],
  mappings: readonly { node_id: string }[],
  tree?: NodeTree,
): { covered: number; total: number; pct: number } {
  const ids = new Set(nodes.map((n) => n.id));
  const hit = new Set<string>();
  if (tree) {
    const all = coveredSet(mappings, tree);
    for (const id of ids) if (all.has(id)) hit.add(id);
  } else {
    for (const m of mappings) if (ids.has(m.node_id)) hit.add(m.node_id);
  }
  const total = ids.size;
  const covered = hit.size;
  return { covered, total, pct: total ? Math.round((covered / total) * 100) : 0 };
}

/** "4/5 objectives mapped" for a group: its leaf descendants, covered by the
 *  rules above. Null for a leaf (it has no objectives to count). */
export function objectiveCoverage(
  tree: NodeTree,
  groupId: string,
  mappings: readonly { node_id: string }[],
): { covered: number; total: number; pct: number } | null {
  const leaves = leafDescendants(tree, groupId);
  if (!leaves.length) return null;
  return coverageOf(
    leaves.map((id) => ({ id })),
    mappings,
    tree,
  );
}

// ── List filters ─────────────────────────────────────────────────────────────

export const TOPIC_PAGE_SIZE = 50;
const PAGE_SIZE_MIN = 10;
const PAGE_SIZE_MAX = 200;
/** A hand-typed ?page= beyond this is not a page anyone meant; it becomes the
 *  cap, and the list page then lands it on the last real page (clampPage). */
const PAGE_MAX = 100000;

export type TopicFilters = {
  subject: string;
  curriculum: string; // curricula.id
  grade: string;
  /** curriculum_nodes.id of a sub-strand / unit: topics mapped to it OR to any
   *  node under it (its objectives). Only meaningful with `curriculum`. */
  node: string;
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
  const curriculum = asText(sp.curriculum);
  return {
    subject: asText(sp.subject),
    curriculum,
    grade: asText(sp.grade),
    // a node filter without its curriculum is a stale querystring: dropped
    node: curriculum ? asText(sp.node) : "",
    status: isTopicStatus(sp.status) ? sp.status : "",
    q: asText(sp.q),
    page: Number.isFinite(rawPage) && rawPage > 0 ? Math.min(PAGE_MAX, rawPage) : 1,
    pageSize: Number.isFinite(rawSize)
      ? Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, rawSize))
      : TOPIC_PAGE_SIZE,
  };
}

export function hasTopicFilters(f: TopicFilters): boolean {
  return !!(f.subject || f.curriculum || f.grade || f.node || f.status || f.q);
}

/** Querystring for a filter change; resets to page 1 unless the patch sets a
 *  page (changing a filter on page 7 otherwise lands on an empty page). */
export function withTopicFilter(f: TopicFilters, patch: Partial<TopicFilters>): string {
  const next: TopicFilters = { ...f, ...patch };
  const p = new URLSearchParams();
  if (next.subject) p.set("subject", next.subject);
  if (next.curriculum) p.set("curriculum", next.curriculum);
  if (next.grade) p.set("grade", next.grade);
  if (next.curriculum && next.node) p.set("node", next.node);
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

/** The page to SHOW for a requested page once the total is known: past the end
 *  lands on the last page, never on an empty one or a 416 from PostgREST. */
export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(1, page), Math.max(1, pages));
}

/** Escape the LIKE metacharacters in a user value so `%`, `_` and `\` match
 *  themselves inside an ilike pattern (Postgres' default escape is `\`). */
export function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, "\\$&");
}

/** PostgREST `or=` expression for a free-text box over `cols`. Commas and
 *  parentheses are stripped because they are the separators of PostgREST's
 *  own or() grammar (see visual-library.ts searchExpression); `*` because
 *  PostgREST reads it as `%`. What is left is LIKE-escaped, so a typed `_` or
 *  `%` is looked for, not treated as a wildcard. Null when the query is blank. */
export function searchOr(q: string, cols: readonly string[]): string | null {
  const safe = q.replace(/[(),*]/g, " ").trim();
  if (!safe) return null;
  const pattern = `%${escapeLike(safe)}%`;
  return cols.map((c) => `${c}.ilike.${pattern}`).join(",");
}

// ── Key ownership ────────────────────────────────────────────────────────────
// Who holds a canonical key: the topic whose canonical_key it is, or the topic
// one of whose aliases normalizes to it (`topic_aliases.normalized` is unique
// across the table). The route fetches the rows; this decides.

export type OwnerRow = { id: string; title: string; status: TopicStatus };

export type KeyOwner = {
  topicId: string;
  title: string;
  status: TopicStatus;
  /** How the key is held: the topic's own canonical_key, or one of its aliases. */
  via: "canonical_key" | "alias";
  retired: boolean;
};

const live = (r: OwnerRow | null | undefined): r is OwnerRow => !!r && r.status !== "retired";
const own = (r: OwnerRow, via: KeyOwner["via"]): KeyOwner => ({
  topicId: r.id,
  title: r.title,
  status: r.status,
  via,
  retired: r.status === "retired",
});

/**
 * Pick the owner to name in a 409 from the rows a route fetched for one key:
 *   byKey        — topics.canonical_key = key
 *   byAlias      — the topic of topic_aliases.normalized = key
 *   byTitleAlias — the topic of topic_aliases.normalized = canonicalKey(byKey.title),
 *                  fetched only when byKey is retired (see below)
 *
 * A LIVE owner is always preferred. A topic merged away keeps its canonical_key
 * (the column is unique, the row stays for history) but is retired, and merge
 * step 1 moved its aliases — its title alias among them — to the merge target:
 * following the alias reaches the topic that owns the name today, and that is
 * the one to merge into. When nothing live holds the key, the alias owner is
 * reported over the retired key holder; the retired holder itself is the answer
 * only when it is all there is (the key is still taken — reopen it, or pick
 * another title). Null when nobody holds the key.
 */
export function pickKeyOwner(
  byKey: OwnerRow | null | undefined,
  byAlias: OwnerRow | null | undefined,
  byTitleAlias: OwnerRow | null | undefined = null,
): KeyOwner | null {
  if (live(byKey)) return own(byKey, "canonical_key");
  if (live(byAlias)) return own(byAlias, "alias");
  if (byKey && live(byTitleAlias)) return own(byTitleAlias, "alias");
  if (byAlias) return own(byAlias, "alias");
  if (byKey) return own(byKey, "canonical_key");
  return null;
}

/** The 409 text for a taken key. `hint` is the route's own "…instead" clause. */
export function keyTakenMessage(key: string, owner: KeyOwner, hint: string): string {
  const head =
    owner.via === "canonical_key"
      ? `A topic with the key "${key}" already exists`
      : `The key "${key}" is already an alias of "${owner.title}"`;
  const state = owner.retired ? " (that topic is retired — reopen it, or pick another title)" : "";
  return `${head}${state}${hint ? ` — ${hint}` : "."}`;
}

// ── Migration-missing detection ──────────────────────────────────────────────

export const CATALOGUE_MIGRATION = "supabase/migrations/0112_topic_catalogue.sql";
/** 0113: curriculum_nodes.kind, topic_candidates.node_ids/rationale, jobs.params. */
export const CATALOGUE_LAYER_MIGRATION = "supabase/migrations/0113_catalogue_layer.sql";

/** Postgres "column does not exist" (42703) and PostgREST's schema-cache
 *  equivalent (PGRST204, "Could not find the 'x' column of 'y'"): the tables
 *  are there but 0113 is not applied. Checked BEFORE catalogueMissing, whose
 *  message test ("does not exist") would otherwise claim a column error. */
export function catalogueColumnMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("column") && (m.includes("does not exist") || m.includes("schema cache") || m.includes("could not find"));
}

/** Postgres "relation does not exist" (42P01) and PostgREST's schema-cache
 *  equivalents: 0112 is not applied. Pages show a banner, routes answer 409
 *  with a hint, like the ops route does for 0110. A missing COLUMN is not
 *  this (see catalogueColumnMissing). */
export function catalogueMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (catalogueColumnMissing(err)) return false;
  if (err.code === "42P01" || err.code === "PGRST205" || err.code === "PGRST106") return true;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("could not find the table") || m.includes("schema cache");
}

/** Which migration a database error says is missing, or null when it is some
 *  other error. Routes answer 409 with the hint; pages show the banner. */
export function missingMigration(err: { code?: string; message?: string } | null | undefined): string | null {
  if (catalogueColumnMissing(err)) return CATALOGUE_LAYER_MIGRATION;
  if (catalogueMissing(err)) return CATALOGUE_MIGRATION;
  return null;
}

export function migrationMissingMessage(migration: string): string {
  return migration === CATALOGUE_LAYER_MIGRATION
    ? `The catalogue-layer columns (node kinds, grouped candidates, job inputs) are not in this database yet — apply ${migration}.`
    : `The topic-catalogue tables are not in this database yet — apply ${migration}.`;
}

export const CATALOGUE_MISSING_ERROR = migrationMissingMessage(CATALOGUE_MIGRATION);
export const CATALOGUE_LAYER_MISSING_ERROR = migrationMissingMessage(CATALOGUE_LAYER_MIGRATION);

// ── Observer-job presentation ────────────────────────────────────────────────

export function isLiveJobStatus(s: unknown): boolean {
  return s === "queued" || s === "processing";
}

/** A one-line reading of jobs.stage for a derive / harvest row. The 0053
 *  shape ({phase, part, total, part_pct}) reads "phase · k/n · p%"; a worker
 *  that writes {label} / {message} / {step} (the observer jobs) reads that; a
 *  bare string reads as itself; anything else is null (progress alone shows). */
export function stageLabel(stage: unknown): string | null {
  if (stage === null || stage === undefined) return null;
  if (typeof stage === "string") return stage.trim() || null;
  if (typeof stage !== "object") return null;
  const s = stage as Record<string, unknown>;
  const str = (k: string) => (typeof s[k] === "string" && (s[k] as string).trim() ? (s[k] as string).trim() : null);
  const num = (k: string) => (typeof s[k] === "number" && Number.isFinite(s[k] as number) ? (s[k] as number) : null);
  const label = str("label") ?? str("message") ?? str("step") ?? str("phase");
  const part = num("part") ?? num("done");
  const total = num("total");
  const pct = num("part_pct") ?? num("pct");
  const parts: string[] = [];
  if (label) parts.push(label);
  if (part !== null && total !== null) parts.push(`${part}/${total}`);
  if (pct !== null) parts.push(`${Math.round(pct)}%`);
  return parts.length ? parts.join(" · ") : null;
}

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
