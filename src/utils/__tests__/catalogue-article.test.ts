/**
 * The knowledge article's pure logic (Phase 2b): the status machine, the Save
 * validator, the word count, the section diff and the latest-version
 * reduction. Nothing here can produce an 'approved' status — approval is the
 * approve_topic_article() RPC (plan §1.3), asserted in catalogue-routes.test.ts.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-article.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  ARTICLE_LIMITS,
  ARTICLE_STATUSES,
  articleBodyOf,
  articleCounts,
  articleStatusLabel,
  canApproveArticle,
  canEditArticle,
  canRejectArticle,
  canSubmitArticle,
  countWords,
  diffSummary,
  isArticleStatus,
  latestArticles,
  nextId,
  sectionDiff,
  sortVersions,
  topicAcceptsArticle,
  validateArticle,
  wordCount,
} from "../catalogue/article";
import type { ArticleSection } from "../catalogue/types";

/** A figure as the Save body carries it (style / notes optional, as the
 *  validator accepts them). Typed so the fixture can be reassigned freely. */
type FigureIn = { figure_key: string; caption: string | null; spec: { subject: string; parts: string[]; style?: string | null; notes?: string | null }; sort: number };

const good = () => ({
  title: "Cells",
  objectives: [
    { id: "o1", text: "Describe the parts of a cell" },
    { id: "o2", text: "Compare plant and animal cells" },
  ],
  figures: [
    { figure_key: "animal_cell", caption: "An animal cell", spec: { subject: "animal cell", parts: ["nucleus", "membrane"] }, sort: 0 },
    { figure_key: "plant_cell", caption: null, spec: { subject: "plant cell", parts: ["cell wall", "chloroplast"], style: "line" }, sort: 1 },
  ] as FigureIn[],
  sections: [
    { id: "s1", heading: "What a cell is", body_md: "Every living thing is made of cells.", figure_keys: ["animal_cell"], covers: ["o1"] },
    { id: "s2", heading: "Plant and animal cells", body_md: "Plant cells have a wall.", figure_keys: ["plant_cell"], covers: ["o2"] },
  ],
  glossary: [{ term: "nucleus", definition: "Controls the cell." }],
  misconceptions: [{ id: "m1", misconception: "Cells are flat.", correction: "Cells are three-dimensional." }],
  worked_examples: [{ id: "w1", problem: "Label the cell.", solution_md: "Nucleus, membrane." }],
  claims: [{ id: "c1", text: "All living things are made of cells.", section_id: "s1" }],
  depth_rationale: "Stage 7 depth.",
});

describe("the article status machine", () => {
  it("knows exactly the five statuses the CHECK constraint allows", () => {
    expect([...ARTICLE_STATUSES]).toEqual(["draft", "in_review", "approved", "superseded", "rejected"]);
    expect(isArticleStatus("in_review")).toBe(true);
    expect(isArticleStatus("Approved")).toBe(false);
    expect(articleStatusLabel("in_review")).toBe("in review");
  });

  it("only a draft or an in-review version is editable, approvable or rejectable; only a draft is submittable", () => {
    for (const s of ["draft", "in_review"]) {
      expect(canEditArticle(s), s).toBe(true);
      expect(canApproveArticle(s), s).toBe(true);
      expect(canRejectArticle(s), s).toBe(true);
    }
    for (const s of ["approved", "superseded", "rejected", "banana"]) {
      expect(canEditArticle(s), s).toBe(false);
      expect(canApproveArticle(s), s).toBe(false);
      expect(canRejectArticle(s), s).toBe(false);
      expect(canSubmitArticle(s), s).toBe(false);
    }
    expect(canSubmitArticle("draft")).toBe(true);
    expect(canSubmitArticle("in_review")).toBe(false);
  });

  it("an article may be written for any topic status but candidate and retired", () => {
    expect(topicAcceptsArticle("candidate")).toBe(false);
    expect(topicAcceptsArticle("retired")).toBe(false);
    for (const s of ["approved", "article_approved", "generating", "in_review", "video_approved", "published"]) {
      expect(topicAcceptsArticle(s), s).toBe(true);
    }
  });
});

describe("word count", () => {
  it("counts tokens that carry a letter or digit, so markdown furniture does not count", () => {
    expect(countWords("- one\n- two\n\n---\n\n**three** 4")).toBe(4);
    expect(countWords("")).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords("الخلية hi")).toBe(2);
  });

  it("sums title, objectives, sections, glossary, misconceptions and worked examples — not claims or figure specs", () => {
    const a = validateArticle(good());
    expect(a.ok).toBe(true);
    // title 1 + objectives 6+5 + s1 4+7 + s2 4+5 + glossary 1+3 + misconception 3+3 + worked 3+2 = 47
    expect(a.wordCount).toBe(47);
    // claims and figures carry no weight: the same body without them counts the same
    const withoutClaimsOrFigures = { ...good(), claims: [], figures: [] };
    expect(wordCount(withoutClaimsOrFigures)).toBe(47);
  });
});

describe("validateArticle", () => {
  it("accepts a well-formed body and normalises it", () => {
    const r = validateArticle({ ...good(), title: "  Cells  ", depth_rationale: "   " });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.errors).toEqual([]);
    expect(r.article.title).toBe("Cells");
    expect(r.article.depth_rationale).toBeNull();
    expect(r.article.figures.map((f) => [f.figure_key, f.sort])).toEqual([
      ["animal_cell", 0],
      ["plant_cell", 1],
    ]);
    expect(r.article.figures[1].spec).toEqual({ subject: "plant cell", parts: ["cell wall", "chloroplast"], style: "line", notes: null });
  });

  it("re-sorts figures by their sort, then key, and renumbers them", () => {
    const body = good();
    body.figures = [
      { figure_key: "zeta", caption: null, spec: { subject: "z", parts: [] }, sort: 5 },
      { figure_key: "alpha", caption: null, spec: { subject: "a", parts: [] }, sort: 5 },
      { figure_key: "first", caption: null, spec: { subject: "f", parts: [] }, sort: -1 },
    ];
    body.sections.forEach((s) => (s.figure_keys = []));
    const r = validateArticle(body);
    expect(r.ok).toBe(true);
    expect(r.article!.figures.map((f) => `${f.figure_key}:${f.sort}`)).toEqual(["first:0", "alpha:1", "zeta:2"]);
  });

  it("refuses a non-object, a blank title and an article with no section", () => {
    expect(validateArticle(null)).toEqual({ ok: false, errors: ["article must be an object."], wordCount: 0, article: null });
    const r = validateArticle({ ...good(), title: " ", sections: [] });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("title is required.");
    expect(r.errors).toContain("sections: an article needs at least one section.");
  });

  it("names every problem at once, not one per Save", () => {
    const body = good();
    body.title = "";
    body.sections[0].heading = "";
    body.glossary[0].definition = "";
    const r = validateArticle(body);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
    expect(r.errors).toContain("sections #1: heading is required.");
    expect(r.errors).toContain("glossary #1: definition is required.");
  });

  it("every cross-reference must resolve inside the article", () => {
    const body = good();
    body.sections[0].figure_keys = ["missing_figure"];
    body.sections[1].covers = ["o9"];
    body.claims[0].section_id = "s9";
    const r = validateArticle(body);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('sections #1: figure "missing_figure" is not one of the article\'s figures.');
    expect(r.errors).toContain('sections #2: covers names an unknown objective "o9".');
    expect(r.errors).toContain('claims #1: section "s9" is not one of the article\'s sections.');
  });

  it("ids are unique within each list; figure keys are snake_case and unique; glossary terms are defined once", () => {
    const body = good();
    body.objectives[1].id = "o1";
    body.figures[1].figure_key = "Plant Cell";
    body.figures.push({ figure_key: "animal_cell", caption: null, spec: { subject: "dup", parts: [] }, sort: 2 });
    body.glossary.push({ term: "Nucleus", definition: "Again." });
    body.sections[1].figure_keys = [];
    const r = validateArticle(body);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('objectives: duplicate id "o1".');
    expect(r.errors.some((e) => e.includes('figure_key "Plant Cell" must be snake_case'))).toBe(true);
    expect(r.errors).toContain('figures: duplicate figure_key "animal_cell".');
    expect(r.errors).toContain('glossary: "Nucleus" is defined twice.');
  });

  it("bounds every list and every string", () => {
    const body = good();
    body.objectives = Array.from({ length: ARTICLE_LIMITS.objectives + 1 }, (_, i) => ({ id: `o${i}`, text: "x" }));
    body.sections[0].body_md = "y".repeat(ARTICLE_LIMITS.body_md + 1);
    body.sections.forEach((s) => (s.covers = []));
    const r = validateArticle(body);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(`objectives: at most ${ARTICLE_LIMITS.objectives} entries (got ${ARTICLE_LIMITS.objectives + 1}).`);
    expect(r.errors).toContain(`sections #1: body_md is longer than ${ARTICLE_LIMITS.body_md} characters.`);
  });

  it("a figure spec needs a subject; parts are deduplicated and blanks dropped", () => {
    const body = good();
    body.figures[0].spec = { subject: "", parts: ["a", "a", " ", "b"] };
    const r = validateArticle(body);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("figures #1: subject is required.");
    const ok = validateArticle({ ...good(), figures: [{ figure_key: "animal_cell", spec: { subject: "s", parts: ["a", "a", " ", "b"] } }, good().figures[1]] });
    expect(ok.ok).toBe(true);
    expect(ok.article!.figures[0].spec.parts).toEqual(["a", "b"]);
    expect(ok.article!.figures[0].caption).toBeNull();
  });

  it("the word count is reported even when the body is refused (the editor shows it live)", () => {
    const r = validateArticle({ ...good(), title: "" });
    expect(r.ok).toBe(false);
    expect(r.wordCount).toBe(46);
  });

  it("normalises Windows line endings in a body and trims it", () => {
    const body = good();
    body.sections[0].body_md = "  a\r\nb  ";
    const r = validateArticle(body);
    expect(r.article!.sections[0].body_md).toBe("a\nb");
  });
});

describe("articleBodyOf — a stored row back into the editable shape", () => {
  it("tolerates jsonb that is not the expected shape and sorts the figures", () => {
    const body = articleBodyOf(
      {
        title: "T",
        objectives: "not a list" as unknown as [],
        sections: [{ id: "s1", heading: "H" }] as unknown as ArticleSection[],
        glossary: null as unknown as [],
        misconceptions: [],
        worked_examples: [],
        claims: [],
        depth_rationale: null,
      },
      [
        { figure_key: "b", caption: null, spec: { subject: "b", parts: [], style: null, notes: null }, sort: 1 },
        { figure_key: "a", caption: "A", spec: { subject: "a", parts: ["x"], style: null, notes: null }, sort: 0 },
      ],
    );
    expect(body.objectives).toEqual([]);
    expect(body.sections).toEqual([{ id: "s1", heading: "H", body_md: "", figure_keys: [], covers: [] }]);
    expect(body.glossary).toEqual([]);
    expect(body.figures.map((f) => f.figure_key)).toEqual(["a", "b"]);
  });

  it("nextId picks the first free <prefix>_<n>", () => {
    expect(nextId("s", [])).toBe("s_1");
    expect(nextId("s", [{ id: "s_1" }, { id: "s_2" }])).toBe("s_3");
    expect(nextId("s", [{ id: "s_2" }])).toBe("s_1");
  });
});

describe("sectionDiff — two versions side by side", () => {
  const sec = (id: string, heading: string, body_md = "", figure_keys: string[] = [], covers: string[] = []): ArticleSection => ({
    id,
    heading,
    body_md,
    figure_keys,
    covers,
  });

  it("pairs sections by id and reports which fields changed", () => {
    const left = [sec("s1", "Intro", "a"), sec("s2", "Parts", "b", ["f1"])];
    const right = [sec("s1", "Intro", "a"), sec("s2", "The parts", "b", ["f1", "f2"], ["o1"])];
    const rows = sectionDiff(left, right);
    expect(rows.map((r) => r.change)).toEqual(["same", "changed"]);
    expect(rows[1].fields).toEqual(["heading", "figure_keys", "covers"]);
    expect(diffSummary(rows)).toEqual({ same: 1, changed: 1, added: 0, removed: 0 });
  });

  it("pairs the sections left over on each side by ORDER (a regenerated draft re-keys everything)", () => {
    const left = [sec("a1", "One", "1"), sec("a2", "Two", "2"), sec("a3", "Three", "3")];
    const right = [sec("b1", "One", "1"), sec("b2", "Two", "2 more"), sec("b3", "Three", "3")];
    const rows = sectionDiff(left, right);
    expect(rows.map((r) => r.change)).toEqual(["same", "changed", "same"]);
    expect(rows[1].fields).toEqual(["body_md"]);
    expect(rows[1].left?.id).toBe("a2");
    expect(rows[1].right?.id).toBe("b2");
  });

  it("id matches win over order matches, and what is left is removed or added", () => {
    const left = [sec("s1", "One"), sec("s2", "Two"), sec("s3", "Three")];
    const right = [sec("s3", "Three"), sec("s9", "Nine"), sec("s1", "One")];
    const rows = sectionDiff(left, right);
    // s1↔s1, s3↔s3 by id; s2 (loose left) ↔ s9 (loose right) by order
    expect(rows.map((r) => [r.left?.id ?? null, r.right?.id ?? null, r.change])).toEqual([
      ["s1", "s1", "same"],
      ["s2", "s9", "changed"],
      ["s3", "s3", "same"],
    ]);
    const more = sectionDiff(left, [sec("s1", "One"), sec("s2", "Two"), sec("s3", "Three"), sec("s4", "Four"), sec("s5", "Five")]);
    expect(more.map((r) => r.change)).toEqual(["same", "same", "same", "added", "added"]);
    const fewer = sectionDiff(left, [sec("s2", "Two")]);
    expect(fewer.map((r) => [r.key, r.change])).toEqual([
      ["s1", "removed"],
      ["s2", "same"],
      ["s3", "removed"],
    ]);
  });

  it("places an added section after the paired section that precedes it in the new version", () => {
    const left = [sec("s1", "One"), sec("s2", "Two")];
    const right = [sec("s1", "One"), sec("new", "One and a half"), sec("s2", "Two")];
    const rows = sectionDiff(left, right);
    expect(rows.map((r) => r.key)).toEqual(["s1", "new", "s2"]);
    expect(rows[1].change).toBe("added");
    // an added section before everything else lands first
    const first = sectionDiff(left, [sec("zero", "Zero"), sec("s1", "One"), sec("s2", "Two")]);
    expect(first.map((r) => r.key)).toEqual(["zero", "s1", "s2"]);
  });

  it("ignores surrounding whitespace when deciding whether a field changed, and handles empty versions", () => {
    expect(sectionDiff([sec("s1", "A ", " b ")], [sec("s1", "A", "b")])[0].change).toBe("same");
    expect(sectionDiff([], [])).toEqual([]);
    expect(sectionDiff([], [sec("s1", "A")]).map((r) => r.change)).toEqual(["added"]);
    expect(sectionDiff([sec("s1", "A")], []).map((r) => r.change)).toEqual(["removed"]);
  });
});

describe("latest version per topic", () => {
  it("reduces a flat list to the highest version of each topic, whatever the order", () => {
    const rows = [
      { topic_id: "t1", version: 1, status: "approved" },
      { topic_id: "t1", version: 3, status: "draft" },
      { topic_id: "t1", version: 2, status: "superseded" },
      { topic_id: "t2", version: 1, status: "in_review" },
    ];
    const latest = latestArticles(rows);
    expect(latest.get("t1")).toEqual({ topic_id: "t1", version: 3, status: "draft" });
    expect(latest.get("t2")?.status).toBe("in_review");
    expect(latest.has("t3")).toBe(false);
    expect(sortVersions(rows.filter((r) => r.topic_id === "t1")).map((r) => r.version)).toEqual([3, 2, 1]);
  });

  it("articleCounts tallies per status and ignores unknown values", () => {
    expect(articleCounts([{ status: "draft" }, { status: "in_review" }, { status: "in_review" }, { status: "weird" }])).toEqual({
      draft: 1,
      in_review: 2,
      approved: 0,
      superseded: 0,
      rejected: 0,
    });
  });
});
