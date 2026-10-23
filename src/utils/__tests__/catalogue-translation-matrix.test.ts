/**
 * The Translations tab's matrix (/library/translations): each (topic,
 * language) cell's state from the raw rows, one test per precedence rule, plus
 * the totals and filters above the matrix. Pure — the page reads the rows.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-translation-matrix.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  TRANSLATION_ORDER,
  buildTranslationMatrix,
  filterMatrixRows,
  matrixHref,
  shownLanguages,
  statusCounts,
  isMissing,
  parseMatrixFilters,
  totalsByLanguage,
  translationLanguages,
  type CellState,
  type MatrixFixCase,
  type MatrixRow,
  type MatrixInput,
  type MatrixJob,
} from "@/utils/catalogue/translation-matrix";
import type { SweepKit, SweepPublication } from "@/utils/catalogue/translate-sweep";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const EN1 = "e1e1e1e1-0000-4000-8000-000000000001";

const topic = (id: string, title: string, subject: string | null = "Mathematics") => ({ id, title, subject, status: "video_approved", bank_maturity: "good" });
const kit = (id: string, topic_id: string, over: Partial<SweepKit> = {}): SweepKit => ({
  id,
  topic_id,
  language: "en",
  status: "approved",
  source_kit_id: null,
  translation_status: null,
  supersede_reason: null,
  judge_score: null,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});
const ar = (id: string, over: Partial<SweepKit> = {}) => kit(id, T1, { language: "ar", source_kit_id: EN1, created_at: "2026-10-10T00:00:00Z", ...over });
const pub = (topic_kit_id: string, over: Partial<SweepPublication> = {}): SweepPublication => ({ topic_kit_id, part: 1, privacy: "public", youtube_video_id: "yt-1", superseded_by: null, ...over });
const job = (status: string, created_at: string, over: Partial<MatrixJob> = {}): MatrixJob => ({
  status,
  params: { topic_id: T1, language: "ar", source_kit_id: EN1 },
  error: null,
  created_at,
  ...over,
});

/** T1 has a current, posted English kit; extra rows per test. */
const input = (over: Partial<MatrixInput> = {}): MatrixInput => ({
  current: [{ topic_id: T1, language: "en", topic_kit_id: EN1 }],
  topics: [topic(T1, "Fractions")],
  kits: [kit(EN1, T1), ...(over.kits ?? [])],
  publications: [pub(EN1), ...(over.publications ?? [])],
  jobs: over.jobs ?? [],
  fixCases: over.fixCases ?? [],
});

const arCell = (i: MatrixInput) => {
  const row = buildTranslationMatrix(i, ["ar"]).find((r) => r.topicId === T1)!;
  return row.cells[0];
};

describe("translation cell precedence", () => {
  it("a live job beats a failed kit: processing reads translating", () => {
    const c = arCell(input({ kits: [ar("k-ar", { status: "failed", translation_status: "failed" })], jobs: [job("processing", "2026-10-12T00:00:00Z")] }));
    expect(c.state).toBe("translating");
    expect(c.kitId).toBe("k-ar");
  });

  it("a queued job reads queued, even over a newer error", () => {
    const c = arCell(input({ jobs: [job("error", "2026-10-13T00:00:00Z", { error: "boom" }), job("queued", "2026-10-12T00:00:00Z")] }));
    expect(c.state).toBe("queued");
  });

  it("a generating or staged kit reads translating", () => {
    expect(arCell(input({ kits: [ar("k-ar", { status: "generating", translation_status: "staged" })] })).state).toBe("translating");
    expect(arCell(input({ kits: [ar("k-ar", { status: "in_review", translation_status: "staged" })] })).state).toBe("translating");
  });

  it("a kit in review reads in review", () => {
    const c = arCell(input({ kits: [ar("k-ar", { status: "in_review", translation_status: "in_review" })] }));
    expect(c.state).toBe("in_review");
    expect(c.label).toBe("In review");
  });

  it("an approved kit with a publication video id reads posted; without one, approved", () => {
    const approved = ar("k-ar", { status: "approved", translation_status: "approved" });
    expect(arCell(input({ kits: [approved] })).state).toBe("approved");
    expect(arCell(input({ kits: [approved], publications: [pub("k-ar", { youtube_video_id: "yt-ar" })] })).state).toBe("posted");
    // a publication row with no video id yet is not posted
    expect(arCell(input({ kits: [approved], publications: [pub("k-ar", { youtube_video_id: null })] })).state).toBe("approved");
  });

  it("a live kit beats an older failed kit and a newer error job", () => {
    const c = arCell(
      input({
        kits: [ar("k-old", { status: "rejected", translation_status: "failed", created_at: "2026-10-05T00:00:00Z" }), ar("k-new", { status: "approved", translation_status: "approved" })],
        jobs: [job("error", "2026-10-15T00:00:00Z", { error: "late failure" })],
      }),
    );
    expect(c.state).toBe("approved");
    expect(c.kitId).toBe("k-new");
  });

  it("an error job newer than the newest kit reads failed, with the job error as the hover", () => {
    const c = arCell(
      input({
        kits: [ar("k-ar", { status: "approved", translation_status: "stale", created_at: "2026-10-05T00:00:00Z" })],
        jobs: [job("error", "2026-10-12T00:00:00Z", { error: "translation of part 1 failed pre-check A: numbers differ" }), job("done", "2026-10-04T00:00:00Z")],
      }),
    );
    expect(c.state).toBe("failed");
    expect(c.detail).toBe("translation of part 1 failed pre-check A: numbers differ");
  });

  it("an error job with no kit at all reads failed", () => {
    const c = arCell(input({ jobs: [job("error", "2026-10-12T00:00:00Z", { error: "6 scene asset(s) cannot be found" })] }));
    expect(c.state).toBe("failed");
    expect(c.detail).toMatch(/scene asset/);
  });

  it("a done job after the error clears it: the kit it made decides", () => {
    const c = arCell(
      input({
        kits: [ar("k-ar", { status: "in_review", translation_status: "in_review", created_at: "2026-10-12T00:05:00Z" })],
        jobs: [job("done", "2026-10-12T00:00:00Z"), job("error", "2026-10-11T00:00:00Z", { error: "old" })],
      }),
    );
    expect(c.state).toBe("in_review");
  });

  it("a stale or blocked kit reads stale / blocked", () => {
    expect(arCell(input({ kits: [ar("k-ar", { translation_status: "stale" })] })).state).toBe("stale");
    expect(arCell(input({ kits: [ar("k-ar", { translation_status: "blocked" })] })).state).toBe("blocked");
  });

  it("a failed or rejected kit reads failed; the newest error job explains it", () => {
    const c = arCell(
      input({
        kits: [ar("k-ar", { status: "failed", translation_status: "staged", created_at: "2026-10-12T00:00:00Z" })],
        jobs: [job("error", "2026-10-11T00:00:00Z", { error: "numbers differ" }), job("done", "2026-10-11T12:00:00Z")],
      }),
    );
    expect(c.state).toBe("failed");
    expect(c.detail).toBe("numbers differ");
    const rejected = arCell(input({ kits: [ar("k-ar", { status: "rejected", translation_status: "failed" })] }));
    expect(rejected.state).toBe("failed");
    expect(rejected.label).toBe("Rejected");
  });

  it("nothing yet and the sweep would take it reads not started", () => {
    const c = arCell(input());
    expect(c.state).toBe("none");
    expect(c.detail).toMatch(/Ready/);
  });

  it("nothing yet and the sweep holds it back reads not ready with the sweep's reason", () => {
    const notPublic = arCell({ ...input(), publications: [pub(EN1, { privacy: "unlisted" })] });
    expect(notPublic.state).toBe("not_ready");
    expect(notPublic.detail).toBe("The part-1 video is unlisted, not public.");
    // no current English kit at all
    const none = buildTranslationMatrix({ current: [], topics: [topic(T2, "Cells", "Science")], kits: [], publications: [], jobs: [] }, ["ar"])[0].cells[0];
    expect(none.state).toBe("not_ready");
    expect(none.detail).toMatch(/No current English kit/);
  });

  it("a job that names only its source kit still lands on the kit's topic", () => {
    const c = arCell(input({ jobs: [job("queued", "2026-10-12T00:00:00Z", { params: { language: "ar", source_kit_id: EN1 } })] }));
    expect(c.state).toBe("queued");
  });

  it("jobs and kits of another language do not leak into the cell", () => {
    const i = input({ kits: [kit("k-ms", T1, { language: "ms", translation_status: "approved" })], jobs: [job("processing", "2026-10-12T00:00:00Z", { params: { topic_id: T1, language: "ms" } })] });
    expect(arCell(i).state).toBe("none");
  });

  it("every cell links to the review inbox for that topic and language", () => {
    expect(arCell(input()).href).toBe(`/library/topics/${T1}?lang=ar`);
  });
});

describe("the English source column", () => {
  const en = (i: MatrixInput) => buildTranslationMatrix(i, ["ar"]).find((r) => r.topicId === T1)!.english;
  it("the current kit reads posted", () => {
    expect(en(input()).state).toBe("posted");
    expect(en(input()).href).toBe(`/library/topics/${T1}`);
  });
  it("an approved kit not yet current reads approved; generating reads Generating; no kit reads No kit", () => {
    expect(en({ ...input(), current: [] }).state).toBe("approved");
    expect(en({ ...input(), current: [], kits: [kit(EN1, T1, { status: "generating" })] }).label).toBe("Generating");
    expect(en({ ...input(), current: [], kits: [] }).label).toBe("No kit");
  });
});

describe("rows, totals and filters", () => {
  const two = (): MatrixInput => ({
    ...input({ kits: [ar("k-ar", { status: "approved", translation_status: "approved" })] }),
    topics: [topic(T2, "Cells", "Science"), topic(T1, "Fractions", "Mathematics"), topic("33333333-3333-4333-8333-333333333333", "Algebra", "Mathematics"), topic("44444444-4444-4444-8444-444444444444", "Misc", null)],
  });

  it("sorts by subject then title, a missing subject last", () => {
    expect(buildTranslationMatrix(two(), ["ar"]).map((r) => r.title)).toEqual(["Algebra", "Fractions", "Cells", "Misc"]);
  });

  it("totals count approved + posted, in review, translating + queued, failed, not started", () => {
    const rows = buildTranslationMatrix(two(), ["ar", "ms"]);
    const [arT, msT] = totalsByLanguage(rows, ["ar", "ms"]);
    expect(arT).toMatchObject({ language: "ar", approved: 1, inReview: 0, translating: 0, failed: 0, notStarted: 3 });
    expect(msT).toMatchObject({ language: "ms", approved: 0, notStarted: 4 });
  });

  it("filters by subject and by a missing language", () => {
    const rows = buildTranslationMatrix(two(), ["ar"]);
    expect(filterMatrixRows(rows, { subject: "Mathematics", missing: "" }).map((r) => r.title)).toEqual(["Algebra", "Fractions"]);
    expect(filterMatrixRows(rows, { subject: "", missing: "ar" }).map((r) => r.title)).toEqual(["Algebra", "Cells", "Misc"]);
    expect(filterMatrixRows(rows, { subject: "Mathematics", missing: "any" }).map((r) => r.title)).toEqual(["Algebra"]);
  });

  it("missing = nothing done and nothing in flight", () => {
    expect(["none", "not_ready", "failed", "stale", "blocked"].every((s) => isMissing(s as never))).toBe(true);
    expect(["queued", "translating", "in_review", "approved", "posted"].some((s) => isMissing(s as never))).toBe(false);
  });

  it("parses the filters, dropping an unknown language", () => {
    expect(parseMatrixFilters({ subject: " Science ", missing: "ar" }, ["ar"])).toEqual({ subject: "Science", missing: "ar", status: "", lang: "" });
    expect(parseMatrixFilters({ missing: "xx" }, ["ar"]).missing).toBe("");
    expect(parseMatrixFilters({ missing: "any" }, ["ar"]).missing).toBe("any");
  });

  it("columns follow the translation order, Arabic first, only registry languages", () => {
    const cols = translationLanguages();
    expect(cols[0]).toBe("ar");
    expect(cols).not.toContain("en");
    expect(cols.every((c, i) => i === 0 || TRANSLATION_ORDER.indexOf(c) > TRANSLATION_ORDER.indexOf(cols[i - 1]))).toBe(true);
  });
});

describe("the clock a translation cell carries (translation-eta.ts)", () => {
  it("a queued job counts from its creation and names itself for its place on the lane", () => {
    const c = arCell(input({ jobs: [job("queued", "2026-10-12T00:00:00Z", { id: "j-q" })] }));
    expect(c.clock).toEqual({ phase: "queued", since: "2026-10-12T00:00:00Z", jobId: "j-q" });
  });

  it("a running job counts from its claim, else its creation", () => {
    const claimed = arCell(input({ jobs: [job("processing", "2026-10-12T00:00:00Z", { id: "j-p", claimed_at: "2026-10-12T00:05:00Z" })] }));
    expect(claimed.clock).toEqual({ phase: "translating", since: "2026-10-12T00:05:00Z", jobId: "j-p" });
    expect(arCell(input({ jobs: [job("processing", "2026-10-12T00:00:00Z")] })).clock?.since).toBe("2026-10-12T00:00:00Z");
  });

  it("a generating kit counts from its kit row; a staged kit already in review has no clock", () => {
    expect(arCell(input({ kits: [ar("k-ar", { status: "generating", translation_status: "staged", created_at: "2026-10-12T01:00:00Z" })] })).clock).toEqual({
      phase: "building",
      since: "2026-10-12T01:00:00Z",
      jobId: null,
    });
    expect(arCell(input({ kits: [ar("k-ar", { status: "in_review", translation_status: "staged" })] })).clock).toBeNull();
  });

  it("nothing in flight carries no clock", () => {
    expect(arCell(input({ kits: [ar("k-ar", { status: "in_review", translation_status: "in_review" })] })).clock).toBeNull();
    expect(arCell(input()).clock).toBeNull();
  });
});

describe("fix queued: a failure with an approved fix (Fix Agent, 0151)", () => {
  const fix = (status: string, over: Partial<MatrixFixCase> = {}): MatrixFixCase => ({ topic_id: T1, language: "ar", status, ...over });
  const failedJob = () => job("error", "2026-10-12T00:00:00Z", { error: "numbers differ" });
  const failedKit = () => ar("k-ar", { status: "failed", translation_status: "staged", created_at: "2026-10-12T00:00:00Z" });

  it("a failed job with an approved fix reads fix queued, keeping the failure in the hover", () => {
    const c = arCell(input({ jobs: [failedJob()], fixCases: [fix("approved")] }));
    expect(c.state).toBe("fix_queued");
    expect(c.label).toBe("Fix queued");
    expect(c.fixStatus).toBe("approved");
    expect(c.detail).toMatch(/waits for the translation lane/);
    expect(c.detail).toMatch(/numbers differ/);
  });

  it("a failed or rejected kit with an applied fix reads fix queued (retrying)", () => {
    expect(arCell(input({ kits: [failedKit()], fixCases: [fix("applied")] }))).toMatchObject({ state: "fix_queued", fixStatus: "applied" });
    const rejected = ar("k-ar", { status: "rejected", translation_status: "failed" });
    expect(arCell(input({ kits: [rejected], fixCases: [fix("approved")] })).state).toBe("fix_queued");
  });

  it("a fix still proposed, needing the founder, closed, or absent leaves the cell failed", () => {
    for (const status of ["new", "diagnosing", "proposed", "needs_founder", "resolved", "rejected"]) {
      expect(arCell(input({ jobs: [failedJob()], fixCases: [fix(status)] })).state).toBe("failed");
    }
    expect(arCell(input({ jobs: [failedJob()] })).state).toBe("failed");
    expect(arCell({ ...input({ jobs: [failedJob()] }), fixCases: undefined }).state).toBe("failed");
  });

  it("a fix of another language or topic does not move the cell", () => {
    expect(arCell(input({ jobs: [failedJob()], fixCases: [fix("approved", { language: "ms" })] })).state).toBe("failed");
    expect(arCell(input({ jobs: [failedJob()], fixCases: [fix("approved", { topic_id: T2 })] })).state).toBe("failed");
    expect(arCell(input({ jobs: [failedJob()], fixCases: [fix("approved", { topic_id: null })] })).state).toBe("failed");
  });

  it("a newer successful translation still wins over the old failure; a live retry job reads queued / translating", () => {
    const c = arCell(
      input({
        kits: [
          ar("k-old", { status: "failed", translation_status: "failed", created_at: "2026-10-05T00:00:00Z" }),
          ar("k-new", { status: "in_review", translation_status: "in_review", created_at: "2026-10-14T00:00:00Z" }),
        ],
        jobs: [job("error", "2026-10-15T00:00:00Z", { error: "late failure" })],
        fixCases: [fix("approved")],
      }),
    );
    expect(c.state).toBe("in_review");
    expect(arCell(input({ jobs: [job("queued", "2026-10-13T00:00:00Z"), failedJob()], fixCases: [fix("applied")] })).state).toBe("queued");
    expect(arCell(input({ jobs: [job("processing", "2026-10-13T00:00:00Z"), failedJob()], fixCases: [fix("applied")] })).state).toBe("translating");
  });

  it("stale and blocked cells are not failures, so a fix does not move them", () => {
    expect(arCell(input({ kits: [ar("k-ar", { translation_status: "stale" })], fixCases: [fix("approved")] })).state).toBe("stale");
  });

  it("is in flight, not missing", () => {
    expect(isMissing("fix_queued")).toBe(false);
  });

  it("totals: Failed counts only the failures still needing action; Fix queued the rest, retrying among them", () => {
    const T3 = "33333333-3333-4333-8333-333333333333";
    const T4 = "44444444-4444-4444-8444-444444444444";
    const i: MatrixInput = {
      ...input({
        jobs: [
          job("error", "2026-10-12T00:00:00Z", { params: { topic_id: T1, language: "ar" } }),
          job("error", "2026-10-12T00:00:00Z", { params: { topic_id: T2, language: "ar" } }),
          job("error", "2026-10-12T00:00:00Z", { params: { topic_id: T3, language: "ar" } }),
          job("error", "2026-10-12T00:00:00Z", { params: { topic_id: T4, language: "ar" } }),
        ],
        fixCases: [fix("approved"), fix("applied", { topic_id: T2 }), fix("proposed", { topic_id: T3 })],
      }),
      topics: [topic(T1, "Fractions"), topic(T2, "Cells", "Science"), topic(T3, "Algebra"), topic(T4, "Misc")],
    };
    const [t] = totalsByLanguage(buildTranslationMatrix(i, ["ar"]), ["ar"]);
    expect(t).toMatchObject({ failed: 2, fixQueued: 2, fixRetrying: 1 });
  });
});

describe("the job progress a running cell carries (the Totals bar)", () => {
  it("a running job's progress rides on its clock, clamped; a number string reads as its number", () => {
    expect(arCell(input({ jobs: [job("processing", "2026-10-12T00:00:00Z", { progress: 62 })] })).clock?.progress).toBe(62);
    expect(arCell(input({ jobs: [job("processing", "2026-10-12T00:00:00Z", { progress: "40" })] })).clock?.progress).toBe(40);
    expect(arCell(input({ jobs: [job("processing", "2026-10-12T00:00:00Z", { progress: 140 })] })).clock?.progress).toBe(100);
  });

  it("no progress reported leaves it out", () => {
    expect(arCell(input({ jobs: [job("processing", "2026-10-12T00:00:00Z")] })).clock).not.toHaveProperty("progress");
    expect(arCell(input({ jobs: [job("processing", "2026-10-12T00:00:00Z", { progress: null })] })).clock).not.toHaveProperty("progress");
  });
});

describe("status and language filters (founder, 2026-10-23)", () => {
  const row = (title: string, states: Record<string, CellState>) =>
    ({ topicId: title, title, subject: "Mathematics", english: { language: "en", state: "posted" },
       cells: Object.entries(states).map(([language, state]) => ({ language, state })) }) as unknown as MatrixRow;
  const rows = [
    row("A", { ar: "approved", ms: "failed" }),
    row("B", { ar: "failed", ms: "approved" }),
    row("C", { ar: "approved", ms: "approved" }),
  ];
  const base = { subject: "", missing: "" };

  it("parses status and lang, dropping unknown values", () => {
    expect(parseMatrixFilters({ status: "failed", lang: "ms" }, ["ar", "ms"])).toMatchObject({ status: "failed", lang: "ms" });
    expect(parseMatrixFilters({ status: "nonsense", lang: "xx" }, ["ar", "ms"])).toMatchObject({ status: "", lang: "" });
  });

  it("a status keeps topics with a cell in that state, in any language or the chosen one", () => {
    expect(filterMatrixRows(rows, { ...base, status: "failed" }).map((r) => r.title)).toEqual(["A", "B"]);
    expect(filterMatrixRows(rows, { ...base, status: "failed", lang: "ms" }).map((r) => r.title)).toEqual(["A"]);
    expect(filterMatrixRows(rows, { ...base, status: "approved", lang: "ar" }).map((r) => r.title)).toEqual(["A", "C"]);
  });

  it("'missing any' reads the chosen language when one is set", () => {
    expect(filterMatrixRows(rows, { ...base, missing: "any", lang: "ar" }).map((r) => r.title)).toEqual(["B"]);
  });

  it("the legend counts topics per state, once each, in the same scope", () => {
    expect(statusCounts(rows).failed).toBe(2);
    expect(statusCounts(rows).approved).toBe(3);
    expect(statusCounts(rows, "ms").failed).toBe(1);
  });

  it("links keep the other filters and drop empty ones", () => {
    expect(matrixHref({ subject: "Mathematics", missing: "", lang: "ms", status: "" }, { status: "failed" }))
      .toBe("/library/translations?subject=Mathematics&lang=ms&status=failed");
    expect(matrixHref({ subject: "", missing: "", status: "failed" }, { status: "" })).toBe("/library/translations");
  });
});

describe("the columns follow the filters (founder, 2026-10-23)", () => {
  const row = (title: string, states: Record<string, CellState>) =>
    ({ topicId: title, title, subject: "Mathematics", english: { language: "en", state: "posted" },
       cells: Object.entries(states).map(([language, state]) => ({ language, state })) }) as unknown as MatrixRow;
  const langs = ["ar", "ms", "mr"];
  const rows = [row("A", { ar: "approved", ms: "approved", mr: "in_review" }), row("B", { ar: "approved", ms: "failed", mr: "none" })];
  const base = { subject: "", missing: "" };

  it("a status shows only the languages with a cell in that state", () => {
    expect(shownLanguages(rows, { ...base, status: "in_review" }, langs)).toEqual(["mr"]);
    expect(shownLanguages(rows, { ...base, status: "approved" }, langs)).toEqual(["ar", "ms"]);
    expect(shownLanguages([], { ...base, status: "failed" }, langs)).toEqual([]);
  });

  it("the chosen language wins; missing narrows too; no filter shows all, in order", () => {
    expect(shownLanguages(rows, { ...base, status: "approved", lang: "ms" }, langs)).toEqual(["ms"]);
    expect(shownLanguages(rows, { ...base, missing: "any" }, langs)).toEqual(["ms", "mr"]);
    expect(shownLanguages(rows, { ...base, missing: "ar" }, langs)).toEqual(["ar"]);
    expect(shownLanguages(rows, base, langs)).toEqual(langs);
  });
});
