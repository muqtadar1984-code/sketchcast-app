/**
 * The topic catalogue's pure logic: the status machine, node kinds and the
 * curriculum tree, the candidate resolution planner (grouped candidates map
 * their node_ids), coverage arithmetic over the tree, the list filters and
 * the migration-missing detection for 0112 (tables) and 0113 (columns).
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-status.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  ARTICLE_JOBS_MIGRATION,
  CATALOGUE_LAYER_MIGRATION,
  CATALOGUE_MIGRATION,
  NODE_KINDS,
  TOPIC_PAGE_SIZE,
  TOPIC_STATUSES,
  bulkSkipUpdate,
  canTransition,
  candidateMappingNodes,
  catalogueColumnMissing,
  catalogueMissing,
  childrenOf,
  clampPage,
  coverageOf,
  coveredSet,
  descendantsOf,
  escapeLike,
  groupNodes,
  hasTopicFilters,
  isArticleFilter,
  isGroupKind,
  isLiveJobStatus,
  isNodeKind,
  isTopicStatus,
  keyTakenMessage,
  leafDescendants,
  mappableChildren,
  missingMigration,
  nextStatuses,
  nodeKind,
  nodeTree,
  objectiveCoverage,
  pageCount,
  pageRange,
  parseTopicFilters,
  pickKeyOwner,
  reopenTarget,
  resolveCandidate,
  searchOr,
  splitMappingNodes,
  stageLabel,
  withTopicFilter,
  type OwnerRow,
} from "../catalogue/status";
import type { TopicStatus } from "../catalogue/types";

const ALL = TOPIC_STATUSES as readonly TopicStatus[];

describe("the status machine", () => {
  it("knows exactly the eight statuses the CHECK constraint allows", () => {
    expect([...TOPIC_STATUSES]).toEqual([
      "candidate",
      "approved",
      "article_approved",
      "generating",
      "in_review",
      "video_approved",
      "published",
      "retired",
    ]);
    expect(isTopicStatus("approved")).toBe(true);
    expect(isTopicStatus("Approved")).toBe(false);
    expect(isTopicStatus("")).toBe(false);
    expect(isTopicStatus(undefined)).toBe(false);
  });

  it("walks the pipeline forward one step at a time, in order", () => {
    const chain: TopicStatus[] = [
      "candidate",
      "approved",
      "article_approved",
      "generating",
      "in_review",
      "video_approved",
      "published",
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(canTransition(chain[i], chain[i + 1]), `${chain[i]} → ${chain[i + 1]}`).toBe(true);
    }
  });

  it("never skips a step", () => {
    expect(canTransition("candidate", "article_approved")).toBe(false);
    expect(canTransition("candidate", "published")).toBe(false);
    expect(canTransition("approved", "generating")).toBe(false);
    expect(canTransition("article_approved", "in_review")).toBe(false);
    expect(canTransition("generating", "video_approved")).toBe(false);
    expect(canTransition("in_review", "published")).toBe(false);
  });

  it("lets any live status retire, but retired does not retire again", () => {
    for (const s of ALL) {
      expect(canTransition(s, "retired"), `${s} → retired`).toBe(s !== "retired");
    }
  });

  it("allows only the three explicit reopenings backwards", () => {
    expect(canTransition("retired", "candidate")).toBe(true);
    expect(canTransition("in_review", "generating")).toBe(true);
    expect(canTransition("video_approved", "in_review")).toBe(true);
    // and no other backward move
    expect(canTransition("approved", "candidate")).toBe(false);
    expect(canTransition("published", "video_approved")).toBe(false);
    expect(canTransition("published", "candidate")).toBe(false);
    expect(canTransition("retired", "approved")).toBe(false);
    expect(canTransition("retired", "published")).toBe(false);
    expect(canTransition("generating", "approved")).toBe(false);
    expect(canTransition("article_approved", "approved")).toBe(false);
  });

  it("never allows a self-transition or an unknown status", () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
    expect(canTransition("candidate", "banana" as TopicStatus)).toBe(false);
    expect(canTransition("banana" as TopicStatus, "candidate")).toBe(false);
  });

  it("the full transition table is exactly the forward step, retire, and the reopenings", () => {
    const expected: Record<TopicStatus, TopicStatus[]> = {
      candidate: ["approved", "retired"],
      approved: ["article_approved", "retired"],
      article_approved: ["generating", "retired"],
      generating: ["in_review", "retired"],
      in_review: ["generating", "video_approved", "retired"],
      video_approved: ["in_review", "published", "retired"],
      published: ["retired"],
      retired: ["candidate"],
    };
    for (const s of ALL) {
      expect({ [s]: nextStatuses(s).sort() }).toEqual({ [s]: [...expected[s]].sort() });
    }
  });

  it("names the reopen target, or null", () => {
    expect(reopenTarget("retired")).toBe("candidate");
    expect(reopenTarget("in_review")).toBe("generating");
    expect(reopenTarget("video_approved")).toBe("in_review");
    expect(reopenTarget("candidate")).toBeNull();
    expect(reopenTarget("published")).toBeNull();
  });
});

describe("resolveCandidate — the writes to make, and nothing else", () => {
  const now = "2026-09-06T10:00:00.000Z";
  const actor = "00000000-0000-0000-0000-00000000aaaa";
  const bookCand = {
    id: "c1",
    source_kind: "book" as const,
    node_id: null,
    raw_title: "Acids, Bases & Salts",
    suggested_topic_id: "t-suggested",
    status: "open" as const,
  };
  const currCand = {
    id: "c2",
    source_kind: "curriculum" as const,
    node_id: "n-7bs-01",
    raw_title: "Cells",
    suggested_topic_id: null,
    status: "open" as const,
  };

  it("merge attaches the raw title as an alias of the target and marks the candidate merged", () => {
    const plan = resolveCandidate(bookCand, { mode: "merge", topicId: "t-target", actorId: actor, now });
    expect(plan.mode).toBe("merge");
    expect(plan.topicId).toBe("t-target");
    expect(plan.topic).toBeNull();
    expect(plan.aliases).toEqual([
      { alias: "Acids, Bases & Salts", normalized: "acid_base_and_salt", source: "book" },
    ]);
    expect(plan.mappings).toEqual([]); // a book candidate has no node
    expect(plan.candidate).toEqual({
      id: "c1",
      status: "merged",
      resolved_by: actor,
      resolved_at: now,
      suggested_topic_id: "t-target",
    });
  });

  it("merge falls back to the suggested topic when no target is given, and refuses when neither exists", () => {
    expect(resolveCandidate(bookCand, { mode: "merge", actorId: actor, now }).topicId).toBe("t-suggested");
    expect(() => resolveCandidate(currCand, { mode: "merge", actorId: actor, now })).toThrow(/target/i);
    expect(() => resolveCandidate(currCand, { mode: "merge", topicId: "  ", actorId: actor, now })).toThrow(/target/i);
  });

  it("merging a curriculum candidate also maps its node to the target as full coverage", () => {
    const plan = resolveCandidate(currCand, { mode: "merge", topicId: "t-cell", actorId: actor, now });
    expect(plan.mappings).toEqual([{ node_id: "n-7bs-01", coverage: "full" }]);
    expect(plan.aliases[0]).toEqual({ alias: "Cells", normalized: "cell", source: "curriculum" });
  });

  it("create mints a candidate-status topic keyed by canonicalKey(raw_title), with alias and mapping", () => {
    const plan = resolveCandidate(currCand, { mode: "create", actorId: actor, now, subject: " Biology " });
    expect(plan.mode).toBe("create");
    expect(plan.topicId).toBeNull(); // known only after the insert
    expect(plan.topic).toEqual({
      canonical_key: "cell",
      title: "Cells",
      subject: "Biology",
      status: "candidate",
      created_by: actor,
    });
    expect(plan.aliases).toEqual([{ alias: "Cells", normalized: "cell", source: "curriculum" }]);
    expect(plan.mappings).toEqual([{ node_id: "n-7bs-01", coverage: "full" }]);
    expect(plan.candidate).toEqual({ id: "c2", status: "created", resolved_by: actor, resolved_at: now });
  });

  it("a GROUPED curriculum candidate maps every node in node_ids as full, never its anchor", () => {
    const grouped = { ...currCand, node_id: "n-7bs", node_ids: ["n-7bs-01", "n-7bs-02", "n-7bs-03"] };
    const create = resolveCandidate(grouped, { mode: "create", actorId: actor, now });
    expect(create.mappings).toEqual([
      { node_id: "n-7bs-01", coverage: "full" },
      { node_id: "n-7bs-02", coverage: "full" },
      { node_id: "n-7bs-03", coverage: "full" },
    ]);
    const merge = resolveCandidate(grouped, { mode: "merge", topicId: "t-cell", actorId: actor, now });
    expect(merge.mappings).toEqual(create.mappings);
    expect(merge.mappings.map((m) => m.node_id)).not.toContain("n-7bs");
    // dismiss still writes nothing
    expect(resolveCandidate(grouped, { mode: "dismiss", actorId: actor, now }).mappings).toEqual([]);
  });

  it("candidateMappingNodes: node_ids when present (deduplicated, blanks dropped), else node_id, nothing for a book", () => {
    expect(candidateMappingNodes({ source_kind: "curriculum", node_id: "anchor", node_ids: ["a", "b", "a", "", "c"] })).toEqual(["a", "b", "c"]);
    expect(candidateMappingNodes({ source_kind: "curriculum", node_id: "anchor", node_ids: [] })).toEqual(["anchor"]);
    expect(candidateMappingNodes({ source_kind: "curriculum", node_id: "anchor" })).toEqual(["anchor"]);
    expect(candidateMappingNodes({ source_kind: "curriculum", node_id: null, node_ids: [] })).toEqual([]);
    expect(candidateMappingNodes({ source_kind: "book", node_id: "n", node_ids: ["a"] })).toEqual([]);
  });

  it("create refuses a title with no canonical key (Arabic-only, or blank)", () => {
    expect(() =>
      resolveCandidate({ ...bookCand, raw_title: "الخلية" }, { mode: "create", actorId: actor, now }),
    ).toThrow(/canonical key/i);
    expect(() => resolveCandidate({ ...bookCand, raw_title: "   " }, { mode: "create", actorId: actor, now })).toThrow(
      /title/i,
    );
  });

  it("dismiss writes only the candidate row", () => {
    const plan = resolveCandidate(bookCand, { mode: "dismiss", actorId: actor, now });
    expect(plan).toEqual({
      mode: "dismiss",
      topicId: null,
      topic: null,
      aliases: [],
      mappings: [],
      candidate: { id: "c1", status: "dismissed", resolved_by: actor, resolved_at: now },
    });
  });

  it("refuses to resolve a candidate that is no longer open", () => {
    for (const status of ["merged", "created", "dismissed"] as const) {
      expect(() => resolveCandidate({ ...bookCand, status }, { mode: "dismiss", actorId: actor, now })).toThrow(
        new RegExp(status),
      );
    }
  });

  it("caps a created title at the column's 120 characters", () => {
    const long = "x".repeat(200);
    const plan = resolveCandidate({ ...bookCand, raw_title: long }, { mode: "create", actorId: actor, now });
    expect(plan.topic!.title.length).toBe(120);
  });
});

describe("splitMappingNodes — the objectives the database still has", () => {
  it("keeps the planned ids found in curriculum_nodes, in plan order, and lists the rest as dropped", () => {
    const existing = new Set(["n1", "n3"]);
    expect(splitMappingNodes(["n1", "n2", "n3", "n4"], existing)).toEqual({ keep: ["n1", "n3"], dropped: ["n2", "n4"] });
  });

  it("drops nothing when every id exists, and everything when none does", () => {
    expect(splitMappingNodes(["a", "b"], new Set(["a", "b", "c"]))).toEqual({ keep: ["a", "b"], dropped: [] });
    expect(splitMappingNodes(["a", "b"], new Set())).toEqual({ keep: [], dropped: ["a", "b"] });
    expect(splitMappingNodes([], new Set(["a"]))).toEqual({ keep: [], dropped: [] });
  });

  it("composes with candidateMappingNodes: a grouped candidate whose objective was deleted maps the others", () => {
    const planned = candidateMappingNodes({ source_kind: "curriculum", node_id: "anchor", node_ids: ["o1", "o2", "o3"] });
    const { keep, dropped } = splitMappingNodes(planned, new Set(["o1", "o3", "anchor"]));
    expect(keep).toEqual(["o1", "o3"]);
    expect(dropped).toEqual(["o2"]);
    // the anchor is not added back in place of the missing objective
    expect(keep).not.toContain("anchor");
  });
});

describe("bulkSkipUpdate — a skipped row is settled, never re-fetched", () => {
  const actor = "00000000-0000-0000-0000-00000000aaaa";
  const now = "2026-09-06T10:00:00.000Z";

  it("a key somebody holds makes that topic the row's suggestion (a one-click merge; the row leaves the unmatched set)", () => {
    expect(bulkSkipUpdate({ existingId: "t-holder" }, actor, now)).toEqual({
      outcome: "suggest",
      update: { suggested_topic_id: "t-holder" },
    });
  });

  it("no holder to name (no canonical key) dismisses the row by the member, like a single Dismiss", () => {
    expect(bulkSkipUpdate({ existingId: null }, actor, now)).toEqual({
      outcome: "dismiss",
      update: { status: "dismissed", resolved_by: actor, resolved_at: now },
    });
  });

  it("a suggestion never changes the row's status, and a dismissal never invents a suggestion", () => {
    const suggest = bulkSkipUpdate({ existingId: "t" }, actor, now);
    expect("status" in suggest.update).toBe(false);
    const dismiss = bulkSkipUpdate({ existingId: null }, actor, now);
    expect("suggested_topic_id" in dismiss.update).toBe(false);
  });
});

describe("coverageOf", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("counts nodes with at least one mapping, once each", () => {
    const r = coverageOf(nodes, [{ node_id: "a" }, { node_id: "a" }, { node_id: "c" }]);
    expect(r).toEqual({ covered: 2, total: 4, pct: 50 });
  });

  it("ignores mappings to nodes outside the group", () => {
    expect(coverageOf(nodes, [{ node_id: "zzz" }])).toEqual({ covered: 0, total: 4, pct: 0 });
  });

  it("is 0 % of nothing, not NaN", () => {
    expect(coverageOf([], [])).toEqual({ covered: 0, total: 0, pct: 0 });
  });

  it("rounds to a whole percent", () => {
    expect(coverageOf([{ id: "a" }, { id: "b" }, { id: "c" }], [{ node_id: "a" }]).pct).toBe(33);
    expect(coverageOf([{ id: "a" }, { id: "b" }, { id: "c" }], [{ node_id: "a" }, { node_id: "b" }]).pct).toBe(67);
  });
});

describe("parseTopicFilters", () => {
  it("defaults to an unfiltered first page of the default size", () => {
    const f = parseTopicFilters({});
    expect(f).toEqual({ subject: "", curriculum: "", grade: "", node: "", status: "", article: "", q: "", page: 1, pageSize: TOPIC_PAGE_SIZE });
    expect(hasTopicFilters(f)).toBe(false);
  });

  it("the article filter (the overview's review-queue link) accepts only the four states", () => {
    expect(parseTopicFilters({ article: "in_review" }).article).toBe("in_review");
    expect(parseTopicFilters({ article: "draft" }).article).toBe("draft");
    expect(parseTopicFilters({ article: "approved" }).article).toBe("approved");
    expect(parseTopicFilters({ article: "none" }).article).toBe("none");
    expect(parseTopicFilters({ article: "superseded" }).article).toBe("");
    expect(parseTopicFilters({ article: "banana" }).article).toBe("");
    expect(isArticleFilter("in_review")).toBe(true);
    expect(isArticleFilter("")).toBe(false);
    const f = parseTopicFilters({ article: "in_review" });
    expect(hasTopicFilters(f)).toBe(true);
    expect(withTopicFilter(f, {})).toBe("?article=in_review");
    expect(withTopicFilter(f, { article: "" })).toBe("");
  });

  it("keeps a sub-strand filter only with its curriculum (a stale ?node= alone is dropped)", () => {
    expect(parseTopicFilters({ curriculum: "c1", node: "n1" }).node).toBe("n1");
    expect(parseTopicFilters({ node: "n1" }).node).toBe("");
    expect(hasTopicFilters(parseTopicFilters({ curriculum: "c1", node: "n1" }))).toBe(true);
  });

  it("only accepts statuses the CHECK constraint allows", () => {
    expect(parseTopicFilters({ status: "approved" }).status).toBe("approved");
    expect(parseTopicFilters({ status: "banana" }).status).toBe("");
  });

  it("falls back rather than throwing on a hand-edited URL", () => {
    expect(parseTopicFilters({ page: "-4" }).page).toBe(1);
    expect(parseTopicFilters({ page: "abc" }).page).toBe(1);
    expect(parseTopicFilters({ pageSize: "abc" }).pageSize).toBe(TOPIC_PAGE_SIZE);
  });

  it("caps page at 100000 (a hand-typed number nobody meant), and keeps real pages", () => {
    expect(parseTopicFilters({ page: "999999999" }).page).toBe(100000);
    expect(parseTopicFilters({ page: "100001" }).page).toBe(100000);
    expect(parseTopicFilters({ page: "100000" }).page).toBe(100000);
    expect(parseTopicFilters({ page: "7" }).page).toBe(7);
  });

  it("clamps pageSize to a sane range", () => {
    expect(parseTopicFilters({ pageSize: "1" }).pageSize).toBe(10);
    expect(parseTopicFilters({ pageSize: "9999" }).pageSize).toBe(200);
    expect(parseTopicFilters({ pageSize: "25" }).pageSize).toBe(25);
  });

  it("trims text filters", () => {
    const f = parseTopicFilters({ subject: " Biology ", q: "  cell " });
    expect(f.subject).toBe("Biology");
    expect(f.q).toBe("cell");
    expect(hasTopicFilters(f)).toBe(true);
  });
});

describe("withTopicFilter", () => {
  const base = parseTopicFilters({ subject: "Biology", page: "7" });

  it("resets to page 1 when a filter changes", () => {
    expect(withTopicFilter(base, { status: "approved" })).toBe("?subject=Biology&status=approved");
  });

  it("keeps an explicit page", () => {
    expect(withTopicFilter(base, { page: 3 })).toBe("?subject=Biology&page=3");
  });

  it("omits defaults and is empty when nothing is set", () => {
    expect(withTopicFilter(parseTopicFilters({}), {})).toBe("");
    expect(withTopicFilter(parseTopicFilters({ pageSize: "25" }), {})).toBe("?pageSize=25");
  });

  it("carries the node filter with its curriculum, and drops it when the curriculum is cleared", () => {
    const f = parseTopicFilters({ curriculum: "c1", node: "n1" });
    expect(withTopicFilter(f, {})).toBe("?curriculum=c1&node=n1");
    expect(withTopicFilter(f, { curriculum: "" })).toBe("");
  });
});

describe("node kinds — the 0113 column, else the code's shape, never depth", () => {
  it("knows the six kinds", () => {
    expect([...NODE_KINDS].sort()).toEqual(["chapter", "objective", "strand", "sub_strand", "topic", "unit"]);
    expect(isNodeKind("unit")).toBe(true);
    expect(isNodeKind("Unit")).toBe(false);
    expect(isNodeKind(null)).toBe(false);
  });

  it("a set kind wins over the code", () => {
    expect(nodeKind({ kind: "unit", code: "7Bs.01", parent_id: null })).toBe("unit");
  });

  it("infers the Cambridge shapes the way the backfill does", () => {
    expect(nodeKind({ kind: null, code: "7Bs.01", parent_id: "p" })).toBe("objective");
    expect(nodeKind({ kind: null, code: "9TWSa.03", parent_id: "p" })).toBe("objective");
    expect(nodeKind({ kind: null, code: "7/Biology", parent_id: null })).toBe("strand");
    expect(nodeKind({ kind: null, code: "7/Bs", parent_id: "strand" })).toBe("sub_strand");
  });

  it("infers the CBSE shapes", () => {
    expect(nodeKind({ kind: null, code: "cbse:9:U1", parent_id: null })).toBe("unit");
    expect(nodeKind({ kind: null, code: "cbse:9:U1:01", parent_id: "u" })).toBe("topic");
    expect(nodeKind({ kind: null, code: "cbse:6:ch01", parent_id: null })).toBe("chapter");
  });

  it("is null for a shape it does not know (a new curriculum), leaving the caller to use the children", () => {
    expect(nodeKind({ kind: null, code: "IB-4.2", parent_id: null })).toBeNull();
    expect(nodeKind({ code: "" })).toBeNull();
  });

  it("strand, sub-strand and unit are groups; objective, topic and chapter are leaves", () => {
    for (const k of ["strand", "sub_strand", "unit"] as const) expect(isGroupKind(k), k).toBe(true);
    for (const k of ["objective", "topic", "chapter"] as const) expect(isGroupKind(k), k).toBe(false);
    expect(isGroupKind(null)).toBe(false);
  });
});

describe("the curriculum tree", () => {
  // strand → two sub-strands → objectives; one orphan whose parent is not loaded
  const nodes = [
    { id: "s", parent_id: null, code: "7/Biology", kind: "strand" as const },
    { id: "bs", parent_id: "s", code: "7/Bs", kind: "sub_strand" as const },
    { id: "bs1", parent_id: "bs", code: "7Bs.01", kind: "objective" as const },
    { id: "bs2", parent_id: "bs", code: "7Bs.02", kind: "objective" as const },
    { id: "bp", parent_id: "s", code: "7/Bp", kind: null },
    { id: "bp1", parent_id: "bp", code: "7Bp.01", kind: null },
    { id: "orphan", parent_id: "missing", code: "x", kind: null },
  ];
  const tree = nodeTree(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  it("links children to parents that are in the set, and treats the rest as roots", () => {
    expect(childrenOf(tree, "s")).toEqual(["bs", "bp"]);
    expect(childrenOf(tree, "bs")).toEqual(["bs1", "bs2"]);
    expect(childrenOf(tree, "bs1")).toEqual([]);
    expect(tree.parent.get("orphan")).toBeNull();
    expect(tree.parent.get("bs1")).toBe("bs");
  });

  it("ignores a node that names itself as its parent", () => {
    const t = nodeTree([{ id: "a", parent_id: "a" }]);
    expect(t.parent.get("a")).toBeNull();
    expect(childrenOf(t, "a")).toEqual([]);
  });

  it("walks descendants depth-first in sibling order, and picks out the leaves", () => {
    expect(descendantsOf(tree, "s")).toEqual(["bs", "bs1", "bs2", "bp", "bp1"]);
    expect(leafDescendants(tree, "s")).toEqual(["bs1", "bs2", "bp1"]);
    expect(leafDescendants(tree, "bs")).toEqual(["bs1", "bs2"]);
    expect(leafDescendants(tree, "bs1")).toEqual([]);
  });

  it("mappableChildren offers a group's objectives (by kind), else its leaf children, and nothing for a leaf", () => {
    expect(mappableChildren(tree, "bs", byId).map((n) => n.id)).toEqual(["bs1", "bs2"]);
    // 7Bp.01 has no kind set but its code shape says objective
    expect(mappableChildren(tree, "bp", byId).map((n) => n.id)).toEqual(["bp1"]);
    // a strand's children are sub-strands (groups): not objectives, not leaves → nothing to tick
    expect(mappableChildren(tree, "s", byId)).toEqual([]);
    expect(mappableChildren(tree, "bs1", byId)).toEqual([]);
    // unknown shapes: leaf children are offered
    const t2 = nodeTree([
      { id: "g", parent_id: null },
      { id: "l1", parent_id: "g" },
      { id: "l2", parent_id: "g" },
    ]);
    const b2 = new Map([
      ["g", { id: "g", code: "G", kind: null, parent_id: null }],
      ["l1", { id: "l1", code: "L1", kind: null, parent_id: "g" }],
      ["l2", { id: "l2", code: "L2", kind: null, parent_id: "g" }],
    ]);
    expect(mappableChildren(t2, "g", b2).map((n) => n.id)).toEqual(["l1", "l2"]);
  });

  it("groupNodes picks the sub-strands and units (never the strand, never a leaf), and a kind-less node whose children are all leaves", () => {
    expect(groupNodes(nodes, tree).map((n) => n.id)).toEqual(["bs", "bp"]);
    const t2 = [
      { id: "g", parent_id: null, code: "G", kind: null },
      { id: "l1", parent_id: "g", code: "L1", kind: null },
      { id: "solo", parent_id: null, code: "S", kind: null },
    ];
    expect(groupNodes(t2).map((n) => n.id)).toEqual(["g"]);
  });
});

describe("coverage over the tree", () => {
  const nodes = [
    { id: "s", parent_id: null },
    { id: "bs", parent_id: "s" },
    { id: "bs1", parent_id: "bs" },
    { id: "bs2", parent_id: "bs" },
    { id: "bs3", parent_id: "bs" },
    { id: "bp", parent_id: "s" },
    { id: "bp1", parent_id: "bp" },
  ];
  const tree = nodeTree(nodes);
  const leaves = ["bs1", "bs2", "bs3", "bp1"].map((id) => ({ id }));

  it("a group is covered when ALL its objectives are mapped, and not before", () => {
    const two = coveredSet([{ node_id: "bs1" }, { node_id: "bs2" }], tree);
    expect(two.has("bs")).toBe(false);
    const three = coveredSet([{ node_id: "bs1" }, { node_id: "bs2" }, { node_id: "bs3" }], tree);
    expect(three.has("bs")).toBe(true);
    expect(three.has("s")).toBe(false); // 7/Bp is still open
    const all = coveredSet([{ node_id: "bs1" }, { node_id: "bs2" }, { node_id: "bs3" }, { node_id: "bp1" }], tree);
    expect(all.has("s")).toBe(true);
  });

  it("a mapping ON the group covers each of its objectives (Phase 1 mapped groups directly)", () => {
    const c = coveredSet([{ node_id: "bs" }], tree);
    expect(c.has("bs")).toBe(true);
    expect(c.has("bs1")).toBe(true);
    expect(c.has("bs3")).toBe(true);
    expect(c.has("bp1")).toBe(false);
    expect(c.has("s")).toBe(false);
  });

  it("coverageOf with the tree counts objectives covered either way; without it, only direct mappings (Phase 1 behaviour)", () => {
    const mappings = [{ node_id: "bs" }, { node_id: "bp1" }];
    expect(coverageOf(leaves, mappings, tree)).toEqual({ covered: 4, total: 4, pct: 100 });
    expect(coverageOf(leaves, mappings)).toEqual({ covered: 1, total: 4, pct: 25 });
  });

  it("objectiveCoverage reads 'n/m objectives mapped' for a group, and null for a leaf", () => {
    expect(objectiveCoverage(tree, "bs", [{ node_id: "bs1" }, { node_id: "bs3" }])).toEqual({ covered: 2, total: 3, pct: 67 });
    expect(objectiveCoverage(tree, "s", [{ node_id: "bs" }])).toEqual({ covered: 3, total: 4, pct: 75 });
    expect(objectiveCoverage(tree, "bs1", [{ node_id: "bs1" }])).toBeNull();
  });

  it("a mapped id outside the loaded tree still counts for itself, and a cycle does not hang", () => {
    expect(coveredSet([{ node_id: "elsewhere" }], tree).has("elsewhere")).toBe(true);
    const cyclic = nodeTree([
      { id: "a", parent_id: "b" },
      { id: "b", parent_id: "a" },
    ]);
    expect(coveredSet([], cyclic).size).toBe(0);
    expect(coveredSet([{ node_id: "a" }], cyclic).has("b")).toBe(true);
  });
});

describe("catalogueColumnMissing / missingMigration — 0113 not applied", () => {
  it("recognises a missing column (42703, PGRST204) and names 0113", () => {
    const pg = { code: "42703", message: 'column topic_candidates.node_ids does not exist' };
    const rest = { code: "PGRST204", message: "Could not find the 'params' column of 'jobs' in the schema cache" };
    for (const e of [pg, rest]) {
      expect(catalogueColumnMissing(e)).toBe(true);
      expect(catalogueMissing(e)).toBe(false); // not mistaken for a missing table
      expect(missingMigration(e)).toBe(CATALOGUE_LAYER_MIGRATION);
    }
  });

  it("a missing table still names 0112, and other errors name nothing", () => {
    expect(missingMigration({ code: "42P01", message: 'relation "public.topics" does not exist' })).toBe(CATALOGUE_MIGRATION);
    expect(missingMigration({ code: "23505", message: "duplicate key" })).toBeNull();
    expect(missingMigration(null)).toBeNull();
    expect(catalogueColumnMissing(null)).toBe(false);
  });

  it("a missing article_figures.render_error column names 0114 (the only column that migration adds)", () => {
    const pg = { code: "42703", message: "column article_figures.render_error does not exist" };
    const rest = { code: "PGRST204", message: "Could not find the 'render_error' column of 'article_figures' in the schema cache" };
    for (const e of [pg, rest]) {
      expect(catalogueColumnMissing(e)).toBe(true);
      expect(missingMigration(e)).toBe(ARTICLE_JOBS_MIGRATION);
    }
    // any other missing column is still 0113's
    expect(missingMigration({ code: "42703", message: "column jobs.params does not exist" })).toBe(CATALOGUE_LAYER_MIGRATION);
  });
});

describe("observer-job presentation", () => {
  it("queued and processing are live", () => {
    expect(isLiveJobStatus("queued")).toBe(true);
    expect(isLiveJobStatus("processing")).toBe(true);
    expect(isLiveJobStatus("done")).toBe(false);
    expect(isLiveJobStatus(undefined)).toBe(false);
  });

  it("stageLabel reads the 0053 shape, an observer's label, a bare string, and nothing else", () => {
    expect(stageLabel({ phase: "analysis", part: 2, total: 4, part_pct: 35 })).toBe("analysis · 2/4 · 35%");
    expect(stageLabel({ label: "grouping 7/Bs", done: 3, total: 12 })).toBe("grouping 7/Bs · 3/12");
    expect(stageLabel({ message: "reading nodes" })).toBe("reading nodes");
    expect(stageLabel("finishing")).toBe("finishing");
    expect(stageLabel("   ")).toBeNull();
    expect(stageLabel(null)).toBeNull();
    expect(stageLabel({})).toBeNull();
    expect(stageLabel(42)).toBeNull();
  });
});

describe("paging and search helpers", () => {
  it("pageRange is zero-based and inclusive, as .range() wants", () => {
    expect(pageRange(1, 50)).toEqual([0, 49]);
    expect(pageRange(3, 50)).toEqual([100, 149]);
    expect(pageRange(0, 50)).toEqual([0, 49]);
  });

  it("pageCount never drops below 1", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
  });

  it("clampPage lands a page past the end on the last page, and never below 1", () => {
    expect(clampPage(7, 3)).toBe(3);
    expect(clampPage(3, 3)).toBe(3);
    expect(clampPage(2, 3)).toBe(2);
    expect(clampPage(100000, 1)).toBe(1);
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(5, 0)).toBe(1); // an empty list has one (empty) page
  });

  it("searchOr builds an ilike disjunction and strips PostgREST separators", () => {
    expect(searchOr("cell", ["title", "canonical_key"])).toBe("title.ilike.%cell%,canonical_key.ilike.%cell%");
    const e = searchOr("a,b(c)*", ["title"])!;
    expect(e).not.toMatch(/[(),*].*ilike|ilike.*[()*]/);
    expect(e.split(",").length).toBe(1); // no injected extra clause
    expect(searchOr("   ", ["title"])).toBeNull();
  });

  it("escapeLike makes %, _ and backslash match themselves", () => {
    expect(escapeLike("acid_base")).toBe("acid\\_base");
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("plain")).toBe("plain");
  });

  it("searchOr LIKE-escapes the typed value, so `_` is not a one-character wildcard", () => {
    expect(searchOr("acid_base", ["canonical_key"])).toBe("canonical_key.ilike.%acid\\_base%");
    expect(searchOr("50%", ["title"])).toBe("title.ilike.%50\\%%");
    // the wildcards the pattern itself adds are the only bare ones
    const e = searchOr("a_b%c", ["title"])!;
    expect(e.match(/(?<!\\)%/g)?.length).toBe(2);
    expect(e).not.toMatch(/(?<!\\)_b/);
  });
});

describe("pickKeyOwner — who a 409 should name", () => {
  const row = (id: string, status: TopicStatus, title = id): OwnerRow => ({ id, title, status });

  it("nobody holds the key → null", () => {
    expect(pickKeyOwner(null, null)).toBeNull();
    expect(pickKeyOwner(undefined, undefined, undefined)).toBeNull();
  });

  it("a live canonical_key holder wins, even over a live alias holder", () => {
    const o = pickKeyOwner(row("t1", "approved", "Cells"), row("t2", "candidate"));
    expect(o).toEqual({ topicId: "t1", title: "Cells", status: "approved", via: "canonical_key", retired: false });
  });

  it("with no canonical holder, the alias owner is named as an alias", () => {
    const o = pickKeyOwner(null, row("t2", "candidate", "The Cell"));
    expect(o).toMatchObject({ topicId: "t2", via: "alias", retired: false });
  });

  it("a key holder merged away is followed to the live topic that now has its alias", () => {
    // t1 (key 'cell') merged into t2: merge step 1 moved t1's aliases to t2, t1 retired.
    const o = pickKeyOwner(row("t1", "retired", "Cells"), row("t2", "approved", "The Cell"));
    expect(o).toMatchObject({ topicId: "t2", via: "alias", retired: false });
  });

  it("when the key alias is gone too, the retired holder's TITLE alias leads to the live topic", () => {
    const o = pickKeyOwner(row("t1", "retired", "Cell Biology"), null, row("t3", "published", "Cells"));
    expect(o).toMatchObject({ topicId: "t3", via: "alias", retired: false });
  });

  it("the title alias is never followed when there is no retired key holder to follow it from", () => {
    // byTitleAlias is only ever fetched for a retired byKey; guard the contract anyway.
    expect(pickKeyOwner(null, null, row("t3", "published"))).toBeNull();
  });

  it("nothing live: the alias owner is reported over the retired key holder, flagged retired", () => {
    const o = pickKeyOwner(row("t1", "retired"), row("t2", "retired", "Old"));
    expect(o).toMatchObject({ topicId: "t2", via: "alias", retired: true });
  });

  it("a retired key holder alone is still the answer (the key is taken — reopen it)", () => {
    const o = pickKeyOwner(row("t1", "retired", "Cells"), null, null);
    expect(o).toEqual({ topicId: "t1", title: "Cells", status: "retired", via: "canonical_key", retired: true });
  });

  it("the 409 text names the holder and how, and says when it is retired", () => {
    const live = pickKeyOwner(row("t1", "approved", "Cells"), null)!;
    expect(keyTakenMessage("cell", live, "merge into it instead.")).toBe('A topic with the key "cell" already exists — merge into it instead.');
    const viaAlias = pickKeyOwner(null, row("t2", "approved", "The Cell"))!;
    expect(keyTakenMessage("cell", viaAlias, "")).toBe('The key "cell" is already an alias of "The Cell".');
    const retired = pickKeyOwner(row("t1", "retired", "Cells"), null)!;
    expect(keyTakenMessage("cell", retired, "open it, or pick another title.")).toMatch(/retired — reopen it/);
    expect(keyTakenMessage("cell", retired, "open it, or pick another title.")).toMatch(/— open it, or pick another title\.$/);
  });
});

describe("catalogueMissing — 0112 not applied", () => {
  it("recognises the relation-missing shapes", () => {
    expect(catalogueMissing({ code: "42P01", message: "relation \"public.topics\" does not exist" })).toBe(true);
    expect(catalogueMissing({ code: "PGRST205", message: "Could not find the table 'public.topics' in the schema cache" })).toBe(true);
    expect(catalogueMissing({ message: "relation topics does not exist" })).toBe(true);
  });

  it("does not swallow other errors", () => {
    expect(catalogueMissing({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe(false);
    expect(catalogueMissing(null)).toBe(false);
    expect(catalogueMissing(undefined)).toBe(false);
  });
});
