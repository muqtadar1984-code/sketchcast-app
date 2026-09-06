/**
 * The topic catalogue's pure logic: the status machine, the candidate
 * resolution planner, coverage arithmetic and the list filters.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-status.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  TOPIC_PAGE_SIZE,
  TOPIC_STATUSES,
  canTransition,
  catalogueMissing,
  clampPage,
  coverageOf,
  escapeLike,
  hasTopicFilters,
  isTopicStatus,
  keyTakenMessage,
  nextStatuses,
  pageCount,
  pageRange,
  parseTopicFilters,
  pickKeyOwner,
  reopenTarget,
  resolveCandidate,
  searchOr,
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
    expect(f).toEqual({ subject: "", curriculum: "", grade: "", status: "", q: "", page: 1, pageSize: TOPIC_PAGE_SIZE });
    expect(hasTopicFilters(f)).toBe(false);
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
