/**
 * Guard: every /api/library/* route handler is shaped the way the portal's
 * access model needs (topic-catalogue plan §7.1–7.2).
 *
 *   1. `export const runtime = "nodejs"` — the service-role client and the
 *      membership RPC run on Node, never the edge.
 *   2. The FIRST await in every exported handler is isLibraryMemberRequest( —
 *      the layout does not guard route handlers, so each one must, before it
 *      reads a body, opens a client, or touches a table.
 *   3. `generations` is touched ONLY by the kit route (topics/[id]/kit) and the
 *      compose route (topics/[id]/compose) — Phase 3 — and inserted as
 *      CATALOGUE rows: owner CATALOGUE_OWNER_ID, book_id / chapter_ref NULL,
 *      params.catalogue true (kitGenerationRows), behind
 *      catalogueGenerateEnabled(). Neither inserter also inserts `jobs`
 *      (pipeline-universal.test.ts' invariant: the on_generation_created
 *      trigger owns a generation's job) — the kit's bank job lives in
 *      kit/questions-job.ts.
 *   4. `jobs` is inserted by exactly the harvest, derive, article and questions
 *      routes plus kit/questions-job.ts — all OBSERVER jobs (generation_id
 *      NULL; all but harvest also book_id NULL, their input in jobs.params)
 *      with a live-job pre-check keyed like their partial unique index and a
 *      23505 read back as the same answer. No route writes topic_kits.status
 *      or topic_articles.status = 'approved' (nor a kit's 'rejected'): an
 *      article is approved only through approve_topic_article(), a kit only
 *      through approve_topic_kit() / reject_topic_kit() (0115).
 *   5. Every POST handler writes platform_audit_log.
 *   6. Phase 2a: a grouped candidate maps its node_ids; create-from-node maps
 *      the ticked children; the bulk create checks every key ONCE (insertTopic's
 *      own check), skips a taken one instead of answering 200 with a half-made
 *      topic, and settles the skipped row so it is not re-fetched.
 *   7. node_ids has no foreign key: both candidate create paths look the
 *      planned nodes up first (existingNodeIds) and take a topic they could not
 *      map back out (rollbackTopic after the mapping write), so a stale id is a
 *      dropped mapping, never a 23503 that orphans a half-made topic.
 *   8. Phase 2b (the article): the article route checks the role per action
 *      (edit_article to generate / save / submit / render, approve to approve /
 *      reject) BEFORE it opens a client; a version is approved ONLY through
 *      approve_topic_article() with the reviewer's id — no route writes
 *      topic_articles.status = 'approved' itself (plan §1.3); both article jobs
 *      are observers with a live-job check keyed like their 0114 index and a
 *      23505 read back as the same 409; every status transition — save,
 *      submit, reject — is a guarded UPDATE read back with .select("id") whose
 *      zero rows are a 409 (a Save landing after an approve never overwrites
 *      the approved version); reject needs notes; a rendered figure whose
 *      spec changed is reset to draft (figureNeedsReset) so it re-renders;
 *      figures are rendered only for a draft / in-review / approved version;
 *      an article is not approved while its topic is still a candidate; every
 *      action is audited on the topic — only when it happened.
 *   9. Phase 3 (the kit): the kit route checks the role per action (generate
 *      to generate / retry / regenerate / save_clips, approve to approve /
 *      reject) BEFORE it opens a client; a kit id is reachable only through
 *      its topic; the two env locks (catalogueGenerateEnabled,
 *      CATALOGUE_OWNER_ID) and kitAcceptsGenerate run before any insert; the
 *      topic move article_approved → generating is a guarded UPDATE read back
 *      whose zero rows take the new kit row out and answer 409 (the race
 *      lock); the generations rows come from kitGenerationRows; a 42501 from
 *      0112's guard is its own 409; the bank job is enqueued AFTER the
 *      generations (through questions-job.ts, a live one reused) and is
 *      best-effort once the kit exists (audited, a warning on the 200); retry
 *      re-inserts only a generation whose status is 'error' — taken
 *      EXCLUSIVELY first by a compare-and-swap on params.retried (two Retry
 *      clicks queue one build), after a guarded kit update read back, with the
 *      row's whitelisted params (retryParamsOf), and repoints the kit ONLY
 *      through repoint_kit_generation() (0115: a jsonb merge with a CAS on the
 *      replaced id — never a read-modify-write of doc_generation_ids);
 *      save_clips validates (validateClips) before a guarded write; approve /
 *      reject go through the two RPCs with the reviewer's id and never touch
 *      topic_kits.status, after kitAcceptsApprove (kit + TOPIC + the kit's
 *      ARTICLE) / kitAcceptsReject (kit + topic); reject needs a listed reason
 *      and notes; every action is audited on the topic — approve and reject by
 *      the RPCs.
 *  10. The owner lock is read through ONE helper, flags.ts catalogueOwnerId()
 *      (trim, lower-case, uuid) — the routes and both pages; nothing under
 *      /api/library reads process.env.CATALOGUE_OWNER_ID itself, so a
 *      malformed value cannot enable a button the route then refuses.
 *  11. Every catalogue generations insert asks for the `generate` action —
 *      the kit route's four writes, compose, and the questions job (model
 *      calls) — while editing items stays edit_article; LibraryAction's
 *      comment and the routes agree.
 *
 * A2's Phase 3 routes (questions, compose, blueprints) are listed by name and
 * asserted when present: the rules below are exact once the files exist and
 * tolerate their absence while the two Phase 3 agents build concurrently.
 *
 * Source scan, like server-client-boundary.test.ts: nothing static in the
 * toolchain checks any of this, and a forgotten guard is a public write path.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-routes.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const API_LIBRARY = resolve(__dirname, "..", "..", "app", "api", "library");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const norm = (p: string) => p.replace(/\\/g, "/");
const files = walk(API_LIBRARY);
const routes = files.filter((f) => /[\\/]route\.ts$/.test(f));
const source = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const rel = (f: string) => norm(f.slice(API_LIBRARY.length + 1));

/** The body of each exported handler, keyed by method. Split on the next
 *  `export async function` so a file with GET and POST yields both. */
function handlers(text: string): { method: string; body: string }[] {
  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
  const starts = [...text.matchAll(re)].map((m) => ({ method: m[1], at: m.index! }));
  return starts.map((s, i) => ({ method: s.method, body: text.slice(s.at, starts[i + 1]?.at ?? text.length) }));
}

/** A2's Phase 3 routes: asserted when present (see the header). */
const A2_ROUTES = ["topics/[id]/questions/route.ts", "topics/[id]/compose/route.ts", "blueprints/route.ts"];
const has = (name: string) => files.some((f) => rel(f) === name);
const present = (names: readonly string[]) => names.filter(has);
const text = (name: string) => source.get(files.find((f) => rel(f) === name)!)!;

const KIT = "topics/[id]/kit/route.ts";
const KIT_QUESTIONS_JOB = "topics/[id]/kit/questions-job.ts";
const COMPOSE = "topics/[id]/compose/route.ts";
const QUESTIONS = "topics/[id]/questions/route.ts";

describe("the /api/library routes exist and are scanned", () => {
  it("has the Phase 1 + 2a + 2b + 3 routes", () => {
    const names = routes.map(rel).sort();
    expect(names).toEqual(
      [
        "candidates/bulk/route.ts",
        "candidates/route.ts",
        "curricula/[id]/nodes/route.ts",
        "curricula/route.ts",
        "derive/route.ts",
        "harvest/route.ts",
        "topics/[id]/article/route.ts",
        KIT,
        "topics/[id]/route.ts",
        "topics/route.ts",
        ...present(A2_ROUTES),
      ].sort(),
    );
    // the kit's bank-job helper is the one non-route, non-lib file
    expect(files.map(rel).filter((n) => !/[\\/]route\.ts$/.test(n) && n !== "lib.ts")).toEqual([KIT_QUESTIONS_JOB]);
  });
});

describe("every /api/library route", () => {
  it("runs on the Node runtime", () => {
    for (const f of routes) {
      expect(source.get(f), rel(f)).toMatch(/export\s+const\s+runtime\s*=\s*["']nodejs["']/);
    }
  });

  it("guards with isLibraryMemberRequest( as the FIRST await of every handler", () => {
    for (const f of routes) {
      const hs = handlers(source.get(f)!);
      expect(hs.length, `${rel(f)} exports at least one handler`).toBeGreaterThan(0);
      for (const h of hs) {
        const firstAwait = h.body.match(/await\s+([A-Za-z_$][\w$.]*)\s*\(/);
        expect(firstAwait?.[1], `${rel(f)} ${h.method}: first await must be the member guard`).toBe("isLibraryMemberRequest");
        // …and the null branch answers 404, so the portal is not probeable.
        expect(h.body, `${rel(f)} ${h.method}: non-member → 404`).toMatch(/if\s*\(\s*!m\s*\)\s*return\s+notFound\(\)/);
      }
    }
  });

  it("touches `generations` ONLY from the kit and compose routes, as catalogue rows, behind the two locks, and never next to a `jobs` insert", () => {
    const touches = [...source].filter(([, t]) => /\.from\(\s*["']generations["']\s*\)/.test(t)).map(([f]) => rel(f)).sort();
    expect(touches).toEqual([KIT, ...present([COMPOSE])].sort());
    const genInsert = /\.from\(\s*["']generations["']\s*\)\s*\.insert\(/;
    const jobInsert = /\.from\(\s*["']jobs["']\s*\)[\s\S]{0,200}?\.insert\(/;
    for (const name of [KIT, ...present([COMPOSE])]) {
      const t = text(name);
      expect(t, `${name} inserts generations`).toMatch(genInsert);
      // pipeline-universal: a generations inserter never hand-rolls a job
      expect(t, `${name} must not also insert jobs`).not.toMatch(jobInsert);
      expect(t, `${name} reads the two locks`).toMatch(/catalogueGenerateEnabled\(\)/);
      expect(t, name).toMatch(/\bcatalogueOwnerId\(\)/);
      // …and both locks run BEFORE any generations insert
      const firstInsert = t.search(genInsert);
      expect(t.indexOf("catalogueGenerateEnabled()"), `${name}: flag before insert`).toBeLessThan(firstInsert);
      expect(t.indexOf("catalogueOwnerId()"), `${name}: owner before insert`).toBeLessThan(firstInsert);
      // 0112's guard (owner not a platform admin) is answered as its own 409
      expect(t, name).toMatch(/42501/);
    }
    // Rule 10: the owner id has ONE reader. No file under /api/library (or
    // either portal page that shows the button) reads the variable itself…
    for (const [f, t] of source) expect(t, `${rel(f)} reads the owner through catalogueOwnerId()`).not.toMatch(/process\.env\.CATALOGUE_OWNER_ID/);
    const PAGES = resolve(__dirname, "..", "..", "app", "library", "topics", "[id]");
    for (const page of [join(PAGES, "page.tsx"), join(PAGES, "questions", "page.tsx")]) {
      const p = readFileSync(page, "utf8");
      expect(p, page).not.toMatch(/process\.env\.CATALOGUE_OWNER_ID/);
      expect(p, page).toMatch(/ownerConfigured=\{catalogueOwnerId\(\) !== null\}/);
    }
    // …and the helper applies the routes' uuid rule: trim, lower-case, uuid.
    const flags = readFileSync(resolve(__dirname, "..", "flags.ts"), "utf8");
    const helper = flags.slice(flags.indexOf("export function catalogueOwnerId"));
    expect(helper).toMatch(/process\.env\.CATALOGUE_OWNER_ID \?\? ""\)\.trim\(\)\.toLowerCase\(\)/);
    expect(helper).toMatch(/UUID\.test\(s\) \? s : null/);
    // the kit's rows are built by the pure module (book_id / chapter_ref
    // NULL, params.catalogue true — asserted in catalogue-kit.test.ts), so the
    // route never spells the trigger flag by hand…
    expect(text(KIT)).toMatch(/\bkitGenerationRows\(/);
    // (an object literal carrying the flag — the header comment may name it)
    expect(text(KIT)).not.toMatch(/[{,]\s*catalogue:\s*true/);
    // …while the compose route's single row (its own payload — a rendered
    // question set, not a kit) must carry the same catalogue shape.
    if (has(COMPOSE)) {
      const c = text(COMPOSE);
      const payload = c.slice(c.search(genInsert));
      expect(payload).toMatch(/catalogue:\s*true/);
      expect(payload).toMatch(/book_id:\s*null/);
      expect(payload).toMatch(/chapter_ref:\s*null/);
      expect(payload).toMatch(/question_set_id:/);
      expect(payload).toMatch(/curriculum_header:/);
    }
  });

  it("inserts into `jobs` from exactly the harvest, derive, article and questions routes plus the kit's bank-job helper, and nowhere else", () => {
    const jobInsert = /\.from\(\s*["']jobs["']\s*\)[\s\S]{0,200}?\.insert\(/;
    const inserters = [...source].filter(([, text]) => jobInsert.test(text)).map(([f]) => rel(f)).sort();
    expect(inserters).toEqual(["derive/route.ts", "harvest/route.ts", "topics/[id]/article/route.ts", KIT_QUESTIONS_JOB, ...present([QUESTIONS])].sort());
    // The kit's bank job (0115 jobs_one_live_questions) is an observer too: no
    // generation, no book, its input in params; the live check is keyed like
    // the index and runs BEFORE the insert; its 23505 is "the bank job already
    // runs" (existing: true), never a failure of the kit.
    const qj = text(KIT_QUESTIONS_JOB);
    expect(qj).toMatch(/const\s+QUESTIONS_JOB_TYPE\s*=\s*["']topic_questions["']/);
    expect(qj).toMatch(/type:\s*QUESTIONS_JOB_TYPE/);
    expect(qj).toMatch(/params:\s*\{\s*topic_id:\s*opts\.topicId,\s*article_id:\s*opts\.articleId,\s*language:\s*opts\.language\s*\}/);
    expect(qj).toMatch(/generation_id:\s*null/);
    expect(qj).toMatch(/book_id:\s*null/);
    expect(qj).toMatch(/status:\s*["']queued["']/);
    const qCheck = qj.indexOf('.in("status", ["queued", "processing"])');
    const qInsert = qj.search(/\.from\(\s*["']jobs["']\s*\)\s*\.insert\(/);
    expect(qCheck).toBeGreaterThan(-1);
    expect(qInsert).toBeGreaterThan(qCheck);
    expect(qj).toMatch(/\.eq\(\s*["']params->>topic_id["']\s*,\s*opts\.topicId\s*\)/);
    expect(qj).toMatch(/\.eq\(\s*["']params->>language["']\s*,\s*opts\.language\s*\)/);
    const race = qj.slice(qj.indexOf('jErr.code === "23505"'));
    expect(race).toMatch(/existing:\s*true/);
    expect(race.indexOf("existing: true")).toBeLessThan(race.indexOf("return { ok: false"));
    // The harvest job is an observer: it owns no generation.
    const harvest = source.get(routes.find((f) => rel(f) === "harvest/route.ts")!)!;
    expect(harvest).toMatch(/type:\s*HARVEST_JOB_TYPE|type:\s*["']topic_harvest["']/);
    expect(harvest).toMatch(/generation_id:\s*null/);
    expect(harvest).toMatch(/status:\s*["']queued["']/);
    // The derive job is an observer too — no generation AND no book; its one
    // input (the curriculum) travels in jobs.params (0113).
    const derive = source.get(routes.find((f) => rel(f) === "derive/route.ts")!)!;
    expect(derive).toMatch(/type:\s*DERIVE_JOB_TYPE|type:\s*["']topic_derive["']/);
    expect(derive).toMatch(/generation_id:\s*null/);
    expect(derive).toMatch(/book_id:\s*null/);
    expect(derive).toMatch(/status:\s*["']queued["']/);
    expect(derive).toMatch(/params:\s*\{\s*curriculum_id:\s*curriculumId\s*\}/);
    // The article route's two jobs are observers too (0114): the article job
    // carries the topic, the language, the hints and the source version; the
    // figure job carries the article. Neither owns a generation or a book.
    const article = source.get(routes.find((f) => rel(f) === "topics/[id]/article/route.ts")!)!;
    expect(article).toMatch(/const\s+ARTICLE_JOB_TYPE\s*=\s*["']topic_article["']/);
    expect(article).toMatch(/const\s+FIGURE_JOB_TYPE\s*=\s*["']figure_render["']/);
    expect(article).toMatch(/type:\s*ARTICLE_JOB_TYPE/);
    expect(article).toMatch(/type:\s*FIGURE_JOB_TYPE/);
    expect(article).toMatch(/params:\s*\{\s*topic_id:\s*id,\s*language:\s*LANGUAGE,\s*hints,\s*source_article_id:\s*sourceArticleId\s*\}/);
    expect(article).toMatch(/params:\s*\{\s*article_id:\s*article\.id\s*\}/);
    const inserts = [...article.matchAll(/\.from\(\s*["']jobs["']\s*\)\s*\.insert\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
    expect(inserts).toHaveLength(2);
    for (const payload of inserts) {
      expect(payload).toMatch(/generation_id:\s*null/);
      expect(payload).toMatch(/book_id:\s*null/);
      expect(payload).toMatch(/status:\s*["']queued["']/);
    }
  });

  it("audits every mutation (each POST handler writes platform_audit_log)", () => {
    for (const f of routes) {
      for (const h of handlers(source.get(f)!)) {
        if (h.method === "GET") continue;
        // The audit helper lives in lib.ts; the handler must call it.
        expect(h.body, `${rel(f)} ${h.method}`).toMatch(/\baudit\(/);
      }
    }
    const lib = source.get(files.find((f) => rel(f) === "lib.ts")!)!;
    expect(lib).toMatch(/\.from\(\s*["']platform_audit_log["']\s*\)\s*\.insert\(/);
    expect(lib).toMatch(/action:\s*`library_\$\{verb\}`/);
  });

  it("the topic route requires the right role per action: approve for approvals, curate for edits", () => {
    const text = source.get(routes.find((f) => rel(f) === "topics/[id]/route.ts")!)!;
    expect(text).toMatch(/approve:\s*"approve"/);
    for (const a of ["update", "alias_add", "alias_remove", "mapping_add", "mapping_remove", "prereq_add", "prereq_remove", "set_depth", "retire", "reopen", "merge"]) {
      expect(text, a).toMatch(new RegExp(`${a}:\\s*"curate"`));
    }
    expect(text).toMatch(/if\s*\(\s*!libraryAllows\(m\.role,\s*NEEDS\[action\]\)\s*\)\s*return\s+notFound\(\)/);
  });

  it("a route that inserts a topic checks who holds the key FIRST, and never answers 200 for an alias conflict", () => {
    const lib = source.get(files.find((f) => rel(f) === "lib.ts")!)!;
    // insertTopic: keyOwner( runs before .from("topics").insert(
    const insertTopic = lib.slice(lib.indexOf("export async function insertTopic"));
    const check = insertTopic.indexOf("keyOwner(");
    const insert = insertTopic.search(/\.from\(\s*["']topics["']\s*\)\s*\.insert\(/);
    expect(check).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(check);
    // keyOwner reads both holders: topics.canonical_key and topic_aliases.normalized
    const keyOwner = lib.slice(lib.indexOf("export async function keyOwner"), lib.indexOf("export async function insertTopic"));
    expect(keyOwner).toMatch(/\.eq\(\s*["']canonical_key["']/);
    expect(lib).toMatch(/\.from\(\s*["']topic_aliases["']\s*\)[\s\S]{0,120}\.eq\(\s*["']normalized["']/);
    for (const name of ["topics/route.ts", "curricula/route.ts", "candidates/route.ts"]) {
      const text = source.get(routes.find((f) => rel(f) === name)!)!;
      expect(text, `${name} answers a taken key with keyTaken(`).toMatch(/\bkeyTaken\(/);
      expect(text, `${name} takes a half-made topic back out on a lost race`).toMatch(/\brollbackTopic\(/);
      // The old shape: the alias conflict recorded in the audit row of a 200.
      expect(text, `${name} never records alias: "conflict"`).not.toMatch(/alias:\s*[^,\n]*"conflict"/);
    }
  });

  it("the merge reports the failed step and audits it, and checks every dependant update", () => {
    const text = source.get(routes.find((f) => rel(f) === "topics/[id]/route.ts")!)!;
    const merge = text.slice(text.indexOf('if (action === "merge")'));
    expect(merge).toMatch(/"topic_merge_failed"/);
    for (const step of ["aliases", "mappings", "candidates", "prerequisites", "title_alias", "retire"]) {
      expect(merge, step).toMatch(new RegExp(`failed\\(\\s*"${step}"`));
    }
    // the per-dependant prerequisites update reads its error
    expect(merge).toMatch(/const\s*\{\s*error\s*\}\s*=\s*await\s+admin\.from\(\s*["']topics["']\s*\)\.update\(\s*\{\s*prerequisites:\s*next/);
    // no bare dbError( left inside the steps: every failure goes through failed(
    const steps = merge.slice(merge.indexOf("// 1."));
    expect(steps.match(/\bdbError\(/g) ?? []).toHaveLength(0);
  });

  it("the harvest, derive and article routes map a lost race on their one-live index (23505) to the 409", () => {
    for (const name of ["harvest/route.ts", "derive/route.ts", "topics/[id]/article/route.ts"]) {
      const text = source.get(routes.find((f) => rel(f) === name)!)!;
      expect(text, name).toMatch(/jErr\.code\s*===\s*["']23505["']/);
      // every 23505 branch answers conflict( before any dbError( that follows it
      for (const m of text.matchAll(/jErr\.code\s*===\s*["']23505["']/g)) {
        const branch = text.slice(m.index!);
        expect(branch.indexOf("conflict("), name).toBeGreaterThan(-1);
        expect(branch.indexOf("conflict("), name).toBeLessThan(branch.indexOf("dbError("));
      }
    }
    // …and both check for a live job BEFORE inserting (the friendly 409 that names it).
    const derive = source.get(routes.find((f) => rel(f) === "derive/route.ts")!)!;
    const check = derive.indexOf('.in("status", ["queued", "processing"])');
    const insert = derive.search(/\.from\(\s*["']jobs["']\s*\)\s*\.insert\(/);
    expect(check).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(check);
    // the live check keys on the same expression as the index: params->>'curriculum_id'
    expect(derive).toMatch(/\.eq\(\s*["']params->>curriculum_id["']\s*,\s*curriculumId\s*\)/);
  });

  it("Phase 2a: grouped candidates map node_ids, create-from-node maps the ticked children, mapping_add can map a group's children", () => {
    const candidates = source.get(routes.find((f) => rel(f) === "candidates/route.ts")!)!;
    expect(candidates).toMatch(/node_ids/);
    expect(candidates).toMatch(/\battachMappings\(/);
    const curricula = source.get(routes.find((f) => rel(f) === "curricula/route.ts")!)!;
    expect(curricula).toMatch(/childIds/);
    expect(curricula).toMatch(/\.eq\(\s*["']parent_id["']\s*,\s*nodeId\s*\)/);
    expect(curricula).toMatch(/\battachMappings\(/);
    // the mapping count lands in the audit row
    expect(curricula).toMatch(/mappings:\s*targets\.length/);
    const topic = source.get(routes.find((f) => rel(f) === "topics/[id]/route.ts")!)!;
    expect(topic).toMatch(/mapChildren/);
    expect(topic).toMatch(/\battachMappings\(/);
  });

  it("the bulk create checks every key ONCE (insertTopic's own check), skips a taken one, settles the skipped row, and takes a raced topic back out", () => {
    const text = source.get(routes.find((f) => rel(f) === "candidates/bulk/route.ts")!)!;
    const loop = text.slice(text.indexOf("for (const candidate of rows)"));
    // insertTopic runs keyOwner itself (asserted on lib.ts above); a second
    // keyOwner( per row was a redundant round trip.
    expect(loop).toMatch(/\binsertTopic\(/);
    expect(text.match(/\bkeyOwner\(/g) ?? []).toHaveLength(0);
    expect(loop).toMatch(/\bsettle\(/);
    expect(loop).toMatch(/\brollbackTopic\(/);
    // a skip is settled through the pure bulkSkipUpdate(): the holder becomes
    // the row's suggestion, or the row is dismissed — and audited either way
    expect(text).toMatch(/\bbulkSkipUpdate\(/);
    expect(text).toMatch(/\.from\(\s*["']topic_candidates["']\s*\)\s*\.update\(\s*plan\.update\s*\)/);
    expect(text).toMatch(/"candidate_suggest"/);
    expect(text).toMatch(/"candidate_dismiss"/);
    // the batch is small and the function budget says so
    expect(text).toMatch(/const\s+BATCH\s*=\s*25\b/);
    expect(text).toMatch(/export\s+const\s+maxDuration\s*=\s*60\b/);
    // the mappings of one row go in ONE upsert (lib.upsertMappings), after the
    // planned nodes were looked up once for the whole batch
    const lookup = text.indexOf("existingNodeIds(");
    expect(lookup).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(text.indexOf("for (const candidate of rows)"));
    expect(loop).toMatch(/\bsplitMappingNodes\(/);
    expect(loop).toMatch(/\bupsertMappings\(/);
    expect(loop).not.toMatch(/\battachMappings\(/);
    expect(text).toMatch(/dropped_missing_nodes/);
    // only OPEN, curriculum-source, unmatched rows of THIS curriculum
    expect(text).toMatch(/\.eq\(\s*["']status["']\s*,\s*["']open["']\s*\)/);
    expect(text).toMatch(/\.eq\(\s*["']source_kind["']\s*,\s*["']curriculum["']\s*\)/);
    expect(text).toMatch(/\.is\(\s*["']suggested_topic_id["']\s*,\s*null\s*\)/);
    expect(text).toMatch(/\.eq\(\s*["']curriculum_nodes\.curriculum_id["']\s*,\s*curriculumId\s*\)/);
    // the batch itself is audited on the curriculum
    expect(text).toMatch(/audit\(admin,\s*m\.id,\s*"candidates_bulk_create",\s*"curriculum",\s*curriculumId/);
  });

  it("both candidate create paths look the planned nodes up first and take a topic they could not map back out", () => {
    const lib = source.get(files.find((f) => rel(f) === "lib.ts")!)!;
    // lib: the lookup is chunked at IN_CHUNK over curriculum_nodes; the one-shot
    // upsert keys on unique(topic_id, node_id) and leaves an existing pair alone;
    // a vanished node under attachMapping is `missing`, not an error
    expect(lib).toMatch(/export\s+const\s+IN_CHUNK\s*=\s*150\b/);
    const lookup = lib.slice(lib.indexOf("export async function existingNodeIds"), lib.indexOf("export async function upsertMappings"));
    expect(lookup).toMatch(/\.from\(\s*["']curriculum_nodes["']\s*\)\s*\.select\(\s*["']id["']\s*\)\s*\.in\(\s*["']id["']/);
    expect(lookup).toMatch(/i\s*\+=\s*IN_CHUNK/);
    const upsert = lib.slice(lib.indexOf("export async function upsertMappings"), lib.indexOf("/** Every mutation lands in platform_audit_log"));
    expect(upsert).toMatch(/\.upsert\(/);
    expect(upsert).toMatch(/onConflict:\s*["']topic_id,node_id["']/);
    expect(upsert).toMatch(/ignoreDuplicates:\s*true/);
    expect(upsert).toMatch(/23503/);
    const attach = lib.slice(lib.indexOf("export async function attachMapping("));
    expect(attach).toMatch(/error\.code\s*===\s*["']23503["']\s*\)\s*return\s*\{\s*ok:\s*true,\s*created:\s*false,\s*missing:\s*true\s*\}/);

    // single route: existingNodeIds( before any write; after the mapping write
    // a failure rolls the created topic back and answers the step
    const single = source.get(routes.find((f) => rel(f) === "candidates/route.ts")!)!;
    const lookupAt = single.indexOf("existingNodeIds(");
    expect(lookupAt).toBeGreaterThan(-1);
    expect(lookupAt).toBeLessThan(single.indexOf("insertTopic("));
    expect(single).toMatch(/\bsplitMappingNodes\(/);
    const afterMap = single.slice(single.indexOf("attachMappings("));
    const rollback = afterMap.indexOf("rollbackTopic(");
    expect(rollback).toBeGreaterThan(-1);
    expect(rollback).toBeLessThan(afterMap.indexOf("return"));
    expect(afterMap).toMatch(/step:\s*["']mappings["']/);
    expect(single).toMatch(/dropped_missing_nodes/);

    // bulk route: the same after its one-shot upsert
    const bulk = source.get(routes.find((f) => rel(f) === "candidates/bulk/route.ts")!)!;
    const afterUpsert = bulk.slice(bulk.indexOf("upsertMappings("));
    const bulkRollback = afterUpsert.indexOf("rollbackTopic(");
    expect(bulkRollback).toBeGreaterThan(-1);
    expect(bulkRollback).toBeLessThan(afterUpsert.indexOf("break"));
    expect(afterUpsert).toMatch(/step:\s*["']mappings["']/);
  });

  it("the derive route audits the enqueue on the curriculum", () => {
    const text = source.get(routes.find((f) => rel(f) === "derive/route.ts")!)!;
    expect(text).toMatch(/audit\(admin,\s*m\.id,\s*"derive_enqueue",\s*"curriculum",\s*curriculumId/);
  });

  it("lib.ts answers a missing 0112 table OR a missing 0113 column with the 409 hint", () => {
    const lib = source.get(files.find((f) => rel(f) === "lib.ts")!)!;
    expect(lib).toMatch(/missingMigration\(err\)/);
    expect(lib).toMatch(/status:\s*409/);
  });

  it("creating a topic from a node audits both sides: the node and the new topic", () => {
    const text = source.get(routes.find((f) => rel(f) === "curricula/route.ts")!)!;
    expect(text).toMatch(/audit\(admin,\s*m\.id,\s*"topic_create_from_node",\s*"curriculum_node",\s*nodeId/);
    expect(text).toMatch(/audit\(admin,\s*m\.id,\s*"topic_create",\s*"topic",\s*created\.id,\s*\{\s*from_node:\s*nodeId/);
  });

  it("the curate-only routes ask the guard for the curate action", () => {
    for (const name of ["candidates/route.ts", "candidates/bulk/route.ts", "curricula/route.ts", "harvest/route.ts", "derive/route.ts"]) {
      const text = source.get(routes.find((f) => rel(f) === name)!)!;
      expect(text, name).toMatch(/isLibraryMemberRequest\(\s*["']curate["']\s*\)/);
    }
    // POST /topics creates → curate; GET /topics is a picker any member may use.
    const topics = source.get(routes.find((f) => rel(f) === "topics/route.ts")!)!;
    const [get, post] = handlers(topics).sort((a, b) => a.method.localeCompare(b.method));
    expect(get.method).toBe("GET");
    expect(get.body).toMatch(/isLibraryMemberRequest\(\s*\)/);
    expect(post.body).toMatch(/isLibraryMemberRequest\(\s*["']curate["']\s*\)/);
  });
});

describe("the article route (Phase 2b): /api/library/topics/[id]/article", () => {
  const ARTICLE = "topics/[id]/article/route.ts";
  const text = () => source.get(routes.find((f) => rel(f) === ARTICLE)!)!;
  const section = (action: string) => {
    const t = text();
    const at = t.indexOf(`if (action === "${action}")`);
    expect(at, `${ARTICLE} has an "${action}" branch`).toBeGreaterThan(-1);
    const rest = t.slice(at + 1);
    const next = rest.search(/\n  if \(action === "/);
    return rest.slice(0, next === -1 ? undefined : next);
  };

  it("checks the role per action — edit_article to write, approve to review — BEFORE it opens a client", () => {
    const t = text();
    for (const a of ["generate", "save", "submit", "render_figures"]) {
      expect(t, a).toMatch(new RegExp(`${a}:\\s*"edit_article"`));
    }
    for (const a of ["approve", "reject"]) {
      expect(t, a).toMatch(new RegExp(`${a}:\\s*"approve"`));
    }
    const check = t.search(/if\s*\(\s*!libraryAllows\(m\.role,\s*NEEDS\[action\]\)\s*\)\s*return\s+notFound\(\)/);
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(t.indexOf("createAdminClient()"));
    // an article id is only reachable through its own topic
    expect(t).toMatch(/\.from\(\s*["']topic_articles["']\s*\)\s*\.select\([^)]*\)\s*\.eq\(\s*["']id["']\s*,\s*articleId\s*\)\s*\.eq\(\s*["']topic_id["']\s*,\s*id\s*\)/);
  });

  it("approves ONLY through approve_topic_article() with the reviewer's id — no route writes topic_articles.status = 'approved'", () => {
    const approve = section("approve");
    expect(approve).toMatch(/admin\.rpc\(\s*["']approve_topic_article["']\s*,\s*\{\s*p_article:\s*article\.id,\s*p_reviewer:\s*m\.id,\s*p_notes:\s*notes\s*\}\s*\)/);
    expect(approve).not.toMatch(/\.from\(\s*["']topic_articles["']\s*\)\s*\.update\(/);
    // the whole route never spells the approved status into a payload…
    expect(text()).not.toMatch(/status:\s*["']approved["']/);
    // …and nowhere under /api/library does a topic_articles write carry it.
    for (const [f, t] of source) {
      for (const m of t.matchAll(/\.from\(\s*["']topic_articles["']\s*\)/g)) {
        const chain = t.slice(m.index!, t.indexOf(";", m.index!));
        if (/\.(update|insert|upsert)\(/.test(chain)) {
          expect(chain, `${rel(f)}: a topic_articles write may not set approved`).not.toMatch(/["']?status["']?\s*:\s*["']approved["']/);
        }
      }
    }
    // the RPC's own refusals (not reviewable, vanished) are the 409, not a 500
    expect(approve).toMatch(/RPC_REFUSALS\.has\(/);
    expect(approve.indexOf("conflict(")).toBeLessThan(approve.indexOf("dbError("));
  });

  /** The guarded-transition shape: `.update({…}).eq("id", article.id)` +
   *  the status guard + `.select("id")`, its rows read back, and zero rows
   *  answered with conflict( BEFORE anything else happens. */
  const guardedWrite = (branch: string, rows: string, guard: RegExp) => {
    const write = branch.search(/\.from\(\s*["']topic_articles["']\s*\)\s*\.update\(/);
    expect(write).toBeGreaterThan(-1);
    const chain = branch.slice(write, branch.indexOf(";", write));
    expect(chain).toMatch(/\.eq\(\s*["']id["']\s*,\s*article\.id\s*\)/);
    expect(chain).toMatch(guard);
    expect(chain).toMatch(/\.select\(\s*["']id["']\s*\)\s*$/);
    // the rows come back into a named binding and their absence is the 409
    expect(branch).toMatch(new RegExp(`const\\s*\\{\\s*data:\\s*${rows}\\s*,\\s*error(?::\\s*\\w+)?\\s*\\}\\s*=\\s*await\\s+admin`));
    const zero = branch.search(new RegExp(`if\\s*\\(\\s*!${rows}\\?\\.length\\s*\\)`));
    expect(zero, `${rows}: zero rows written is checked`).toBeGreaterThan(write);
    expect(branch.slice(zero, branch.indexOf("}", zero))).toMatch(/return\s+conflict\(/);
    return zero;
  };

  it("submit and reject are guarded transitions read back (zero rows → 409, no audit); reject needs notes", () => {
    const submit = section("submit");
    expect(submit).toMatch(/canSubmitArticle\(article\.status\)/);
    expect(submit).toMatch(
      /\.update\(\s*\{\s*status:\s*["']in_review["']\s*\}\s*\)\s*\.eq\(\s*["']id["']\s*,\s*article\.id\s*\)\s*\.eq\(\s*["']status["']\s*,\s*["']draft["']\s*\)\s*\.select\(\s*["']id["']\s*\)/,
    );
    const submitZero = guardedWrite(submit, "moved", /\.eq\(\s*["']status["']\s*,\s*["']draft["']\s*\)/);
    expect(submit.indexOf("audit(")).toBeGreaterThan(submitZero);

    const reject = section("reject");
    expect(reject).toMatch(/canRejectArticle\(article\.status\)/);
    expect(reject).toMatch(/if\s*\(\s*!notes\s*\)\s*return\s+bad\(/);
    expect(reject).toMatch(/status:\s*["']rejected["']/);
    expect(reject).toMatch(/reviewer_id:\s*m\.id/);
    const rejectZero = guardedWrite(reject, "rejected", /\.in\(\s*["']status["']\s*,\s*\[\s*["']draft["']\s*,\s*["']in_review["']\s*\]\s*\)/);
    expect(reject.indexOf("audit(")).toBeGreaterThan(rejectZero);
  });

  it("save runs the pure validator first, then a status-guarded write read back — a Save after an approve is a 409, never an overwrite", () => {
    const save = section("save");
    expect(save).toMatch(/canEditArticle\(article\.status\)/);
    const validate = save.indexOf("validateArticle(body.article)");
    const write = save.search(/\.from\(\s*["']topic_articles["']\s*\)\s*\.update\(/);
    expect(validate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(validate);
    expect(save).toMatch(/word_count:\s*v\.wordCount/);
    // the body update is guarded on the editable statuses and read back; the
    // zero-rows 409 comes BEFORE the figures are touched, so a version that
    // was approved or rejected under the editor is left exactly as it is
    const zero = guardedWrite(save, "written", /\.in\(\s*["']status["']\s*,\s*\[\s*["']draft["']\s*,\s*["']in_review["']\s*\]\s*\)/);
    const figures = save.search(/\.from\(\s*["']article_figures["']\s*\)/);
    expect(figures).toBeGreaterThan(zero);
    expect(save.indexOf("audit(")).toBeGreaterThan(zero);
  });

  it("save upserts figures by key, resets a rendered figure whose spec changed, and deletes only draft figures", () => {
    const save = section("save");
    expect(save).toMatch(/onConflict:\s*["']article_id,figure_key["']/);
    expect(save).toMatch(/\.delete\(\)\s*\.eq\(\s*["']article_id["']\s*,\s*article\.id\s*\)\s*\.eq\(\s*["']status["']\s*,\s*["']draft["']\s*\)/);
    // the existing rows are read WITH their spec, so the reset rule can compare
    expect(save).toMatch(/\.from\(\s*["']article_figures["']\s*\)\s*\.select\(\s*["']id, figure_key, status, spec["']\s*\)/);
    // the upsert payload is the editable columns — an existing row keeps the
    // renderer's visual_asset_id, labels, status and render_error — plus the
    // reset columns for exactly the figures figureNeedsReset() names
    expect(save).toMatch(
      /\.upsert\(\s*next\.figures\.map\(\(f: ArticleFigureInput\) => \(\{\s*article_id:\s*article\.id,\s*figure_key:\s*f\.figure_key,\s*caption:\s*f\.caption,\s*spec:\s*f\.spec,\s*sort:\s*f\.sort,\s*\.\.\.\(resetKeys\.has\(f\.figure_key\)\s*\?\s*FIGURE_RESET\s*:\s*\{\}\),?\s*\}\)\)/,
    );
    expect(save).toMatch(/figureNeedsReset\(prior,\s*f\.spec\)/);
    // the reset is exactly: back to draft, no asset, no labels, no stale error
    expect(text()).toMatch(/const\s+FIGURE_RESET\s*=\s*\{\s*status:\s*["']draft["'],\s*visual_asset_id:\s*null,\s*labels:\s*\[\][^,]*,\s*render_error:\s*null\s*\}/);
    // …and it is reported next to the kept figures, in the answer and the audit row
    expect(save).toMatch(/figuresReset:\s*reset/);
    expect(save).toMatch(/figures_reset:\s*reset/);
    expect(save).toMatch(/figuresKept:\s*kept/);
  });

  it("render_figures refuses a version that is history (rejected, superseded) before it counts or enqueues anything", () => {
    const render = section("render_figures");
    const gate = render.indexOf("canRenderFigures(article.status)");
    expect(gate).toBeGreaterThan(-1);
    const count = render.search(/\.from\(\s*["']article_figures["']\s*\)/);
    const insert = render.search(/\.from\(\s*["']jobs["']\s*\)\s*\.insert\(/);
    expect(gate).toBeLessThan(count);
    expect(gate).toBeLessThan(insert);
    expect(render.slice(gate, count)).toMatch(/return\s+conflict\(/);
  });

  it("approve refuses while the TOPIC is still a candidate — before the RPC runs", () => {
    const approve = section("approve");
    const gate = approve.search(/topic\.status\s*===\s*["']candidate["']/);
    const rpc = approve.indexOf('admin.rpc("approve_topic_article"');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(rpc);
    expect(approve.slice(gate, rpc)).toMatch(/return\s+conflict\(/);
  });

  it("both jobs check for a live one BEFORE inserting, keyed like their 0114 index", () => {
    const generate = section("generate");
    const gCheck = generate.indexOf('.in("status", ["queued", "processing"])');
    const gInsert = generate.search(/\.from\(\s*["']jobs["']\s*\)\s*\.insert\(/);
    expect(gCheck).toBeGreaterThan(-1);
    expect(gInsert).toBeGreaterThan(gCheck);
    // jobs_one_live_article: (params->>'topic_id', coalesce(params->>'language','en'))
    expect(generate).toMatch(/\.eq\(\s*["']params->>topic_id["']\s*,\s*id\s*\)/);
    expect(generate).toMatch(/\.eq\(\s*["']params->>language["']\s*,\s*LANGUAGE\s*\)/);
    expect(generate).toMatch(/topicAcceptsArticle\(topic\.status\)/);

    const render = section("render_figures");
    const rCheck = render.indexOf('.in("status", ["queued", "processing"])');
    const rInsert = render.search(/\.from\(\s*["']jobs["']\s*\)\s*\.insert\(/);
    expect(rCheck).toBeGreaterThan(-1);
    expect(rInsert).toBeGreaterThan(rCheck);
    // jobs_one_live_figure_render: (params->>'article_id')
    expect(render).toMatch(/\.eq\(\s*["']params->>article_id["']\s*,\s*article\.id\s*\)/);
    // nothing to render is a 400, not a job
    expect(render.indexOf("return bad(")).toBeLessThan(rInsert);
  });

  it("audits every action on the topic (approve is audited by the RPC itself)", () => {
    const t = text();
    for (const verb of ["article_generate", "article_save", "article_submit", "figures_render", "article_reject"]) {
      expect(t, verb).toMatch(new RegExp(`audit\\(admin,\\s*m\\.id,\\s*"${verb}",\\s*"topic",\\s*id`));
    }
    expect(section("approve")).not.toMatch(/\baudit\(/);
    expect(section("approve")).toMatch(/Audited by the RPC/);
  });
});

describe("the kit route (Phase 3): /api/library/topics/[id]/kit", () => {
  const t = () => text(KIT);
  const section = (action: string) => {
    const src = t();
    const at = src.indexOf(`if (action === "${action}")`);
    expect(at, `${KIT} has an "${action}" branch`).toBeGreaterThan(-1);
    const rest = src.slice(at + 1);
    const next = rest.search(/\n  if \(action === "/);
    return rest.slice(0, next === -1 ? undefined : next);
  };

  it("checks the role per action — generate to build, approve to review — BEFORE it opens a client", () => {
    const src = t();
    for (const a of ["generate", "retry", "regenerate", "save_clips"]) {
      expect(src, a).toMatch(new RegExp(`${a}:\\s*"generate"`));
    }
    for (const a of ["approve", "reject"]) {
      expect(src, a).toMatch(new RegExp(`${a}:\\s*"approve"`));
    }
    const check = src.search(/if\s*\(\s*!libraryAllows\(m\.role,\s*NEEDS\[action\]\)\s*\)\s*return\s+notFound\(\)/);
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(src.indexOf("createAdminClient()"));
    // a kit id is only reachable through its own topic
    expect(src).toMatch(/\.from\(\s*["']topic_kits["']\s*\)\s*\.select\(KIT_COLUMNS\)\s*\.eq\(\s*["']id["']\s*,\s*kitId\s*\)\s*\.eq\(\s*["']topic_id["']\s*,\s*id\s*\)/);
  });

  it("approves and rejects ONLY through the 0115 RPCs with the reviewer's id — no route writes a kit's approved / rejected status", () => {
    const approve = section("approve");
    // the three-way agreement the RPC enforces, answered as the friendly 409
    // BEFORE the RPC: the kit's own article is read by kit.article_id
    expect(approve).toMatch(/\.from\(\s*["']topic_articles["']\s*\)\s*\.select\([^)]*\)\s*\.eq\(\s*["']id["']\s*,\s*kit\.article_id\s*\)/);
    expect(approve).toMatch(/kitAcceptsApprove\(topic\.status,\s*kit\.status,/);
    const approveGate = approve.search(/kitAcceptsApprove\(/);
    const approveRpc = approve.indexOf('admin.rpc("approve_topic_kit"');
    expect(approveGate).toBeGreaterThan(-1);
    expect(approveGate).toBeLessThan(approveRpc);
    expect(approve.slice(approveGate, approveRpc)).toMatch(/return\s+conflict\(accepts\.why/);
    expect(approve).toMatch(/admin\.rpc\(\s*["']approve_topic_kit["']\s*,\s*\{\s*p_kit:\s*kit\.id,\s*p_reviewer:\s*m\.id,\s*p_notes:\s*notes\s*\}\s*\)/);
    expect(approve).not.toMatch(/\.from\(\s*["']topic_kits["']\s*\)\s*\.update\(/);
    // the RPC's own refusals (not reviewable, topic not in review, article
    // superseded, vanished) are the 409, not a 500
    const afterRpc = approve.slice(approveRpc);
    expect(afterRpc).toMatch(/RPC_REFUSALS\.has\(/);
    expect(afterRpc.indexOf("conflict(")).toBeLessThan(afterRpc.indexOf("dbError("));
    expect(approve).toMatch(/Audited by the RPC/);
    expect(approve).not.toMatch(/\baudit\(/);

    const reject = section("reject");
    expect(reject).toMatch(/kitAcceptsReject\(topic\.status,\s*kit\.status\)/);
    expect(reject.search(/kitAcceptsReject\(/)).toBeLessThan(reject.indexOf('admin.rpc("reject_topic_kit"'));
    expect(reject).toMatch(/if\s*\(\s*!isKitRejectReason\(reason\)\s*\)\s*return\s+bad\(/);
    expect(reject).toMatch(/if\s*\(\s*!notes\s*\)\s*return\s+bad\(/);
    expect(reject).toMatch(/admin\.rpc\(\s*["']reject_topic_kit["']\s*,\s*\{\s*p_kit:\s*kit\.id,\s*p_reviewer:\s*m\.id,\s*p_reason:\s*reason,\s*p_notes:\s*notes\s*\}\s*\)/);
    expect(reject).not.toMatch(/\.from\(\s*["']topic_kits["']\s*\)\s*\.update\(/);
    expect(reject).toMatch(/Audited by the RPC/);
    expect(reject).not.toMatch(/\baudit\(/);

    // the whole route never spells either status into a payload…
    expect(t()).not.toMatch(/status:\s*["']approved["']/);
    expect(t()).not.toMatch(/status:\s*["']rejected["']/);
    // …and nowhere under /api/library does a topic_kits write carry them.
    for (const [f, src] of source) {
      for (const m of src.matchAll(/\.from\(\s*["']topic_kits["']\s*\)/g)) {
        const chain = src.slice(m.index!, src.indexOf(";", m.index!));
        if (/\.(update|insert|upsert)\(/.test(chain)) {
          expect(chain, `${rel(f)}: a topic_kits write may not set approved / rejected`).not.toMatch(/["']?status["']?\s*:\s*["'](approved|rejected)["']/);
        }
      }
    }
    // the only rpc calls to the kit RPCs live here
    for (const [f, src] of source) {
      if (rel(f) === KIT) continue;
      expect(src, rel(f)).not.toMatch(/approve_topic_kit|reject_topic_kit/);
    }
  });

  it("generate: acceptance, then the locks, then the guarded topic move (the race lock) and the rows from kitGenerationRows; the bank job after", () => {
    const generate = section("generate");
    expect(generate).toMatch(/kitAcceptsGenerate\(topic\.status,\s*article\?\.status \?\? null,\s*hasLiveKit\(kits,\s*LANGUAGE\)\)/);
    expect(generate).toMatch(/if\s*\(\s*!accepts\.ok\s*\)\s*return\s+conflict\(accepts\.why/);
    // the avatar is validated or defaulted by alternation
    expect(generate).toMatch(/nextTeacherAvatar\(kits\)/);
    expect(generate).toMatch(/isTeacherAvatar\(body\.teacherAvatar\)/);
    // acceptance before the locks, the locks before the shared insert path
    expect(generate.indexOf("kitAcceptsGenerate(")).toBeLessThan(generate.indexOf("generationGate()"));
    expect(generate.indexOf("generationGate()")).toBeLessThan(generate.indexOf("createKit("));
    expect(generate).toMatch(/fromTopicStatus:\s*["']article_approved["']/);
    expect(generate).toMatch(/verb:\s*["']kit_generate["']/);

    // the shared insert path
    const src = t();
    const create = src.slice(src.indexOf("const createKit = async"), src.indexOf('if (action === "generate")'));
    const kitInsert = create.search(/\.from\(\s*["']topic_kits["']\s*\)\s*\.insert\(/);
    const move = create.search(/\.from\(\s*["']topics["']\s*\)\.update\(\s*\{\s*status:\s*["']generating["']\s*\}\s*\)\.eq\(\s*["']id["']\s*,\s*id\s*\)\.eq\(\s*["']status["']\s*,\s*opts\.fromTopicStatus\s*\)\.select\(\s*["']id["']\s*\)/);
    const gens = create.search(/\.from\(\s*["']generations["']\s*\)\.insert\(kitGenerationRows\(opts\.owner,\s*params\)\)/);
    const bank = create.indexOf("enqueueQuestionsJob(");
    const auditAt = create.indexOf("audit(admin, m.id, opts.verb, \"topic\", id");
    expect(kitInsert).toBeGreaterThan(-1);
    expect(move).toBeGreaterThan(kitInsert);
    expect(gens).toBeGreaterThan(move);
    expect(bank).toBeGreaterThan(gens);
    expect(auditAt).toBeGreaterThan(bank);
    // zero rows moved: the kit row is taken out and the answer is 409
    const zero = create.search(/if\s*\(\s*!moved\?\.length\s*\)/);
    expect(zero).toBeGreaterThan(move);
    const zeroBlock = create.slice(zero, create.indexOf("}", zero));
    expect(zeroBlock).toMatch(/\.from\(\s*["']topic_kits["']\s*\)\.delete\(\)\.eq\(\s*["']id["']\s*,\s*kitId\s*\)/);
    expect(zeroBlock).toMatch(/return\s+conflict\(/);
    // a failed generations insert fails the kit and puts the topic back; 42501 has its own 409
    const gErr = create.slice(create.indexOf("if (gErr)"));
    expect(gErr).toMatch(/status:\s*["']failed["']/);
    expect(gErr).toMatch(/\.update\(\s*\{\s*status:\s*opts\.fromTopicStatus\s*\}\s*\)/);
    expect(gErr).toMatch(/gErr\.code\s*===\s*OWNER_NOT_ADMIN/);
    expect(src).toMatch(/const\s+OWNER_NOT_ADMIN\s*=\s*["']42501["']/);
    // the header lines are composed from the mappings by the pure module
    expect(create).toMatch(/curriculumHeaderLines\(mappings\)/);
    expect(create).toMatch(/kitGenerationParams\(\{/);
  });

  it("regenerate: a reviewed kit, the topic back in review, the old kit's avatar, the approved source article", () => {
    const regen = section("regenerate");
    expect(regen).toMatch(/kitAcceptsRegenerate\(topic\.status,\s*kit\.status,\s*hasLiveKit\(kits,\s*LANGUAGE\)\)/);
    expect(regen).toMatch(/isTeacherAvatar\(kit\.teacher_avatar\)\s*\?\s*kit\.teacher_avatar\s*:\s*nextTeacherAvatar\(kits\)/);
    expect(regen).toMatch(/article\.status\s*!==\s*["']approved["']/);
    expect(regen).toMatch(/sourceKitId:\s*kit\.id/);
    expect(regen).toMatch(/fromTopicStatus:\s*["']in_review["']/);
    expect(regen).toMatch(/verb:\s*["']kit_regenerate["']/);
    expect(regen.indexOf("generationGate()")).toBeLessThan(regen.indexOf("createKit("));
  });

  it("retry: only a failed piece, taken exclusively (params.retried CAS), after a guarded kit update read back, with the row's whitelisted params, repointed through the RPC", () => {
    const retry = section("retry");
    expect(retry).toMatch(/canRetryKit\(kit\.status\)/);
    expect(retry).toMatch(/isKitKind\(kind\)/);
    expect(retry).toMatch(/old\.status\s*!==\s*["']error["']/);
    expect(retry).toMatch(/params\.catalogue\s*!==\s*true/);
    // an already-retried row is refused before anything is written
    expect(retry).toMatch(/if\s*\(\s*params\[RETRIED_KEY\]\s*===\s*true\s*\)\s*return\s+conflict\(/);
    // the exclusive take: flip params.retried where it is not set, on the
    // error row only, read back — zero rows is "somebody else retried", 409
    const lock = retry.search(/\.from\(\s*["']generations["']\s*\)\.update\(\s*\{\s*params:\s*lockedParams\s*\}\s*\)\.eq\(\s*["']id["']\s*,\s*old\.id\s*\)\.eq\(\s*["']status["']\s*,\s*["']error["']\s*\)\.is\(`params->>\$\{RETRIED_KEY\}`,\s*null\)\.select\(\s*["']id["']\s*\)/);
    expect(lock).toBeGreaterThan(-1);
    expect(retry.search(/if\s*\(\s*!locked\?\.length\s*\)\s*return\s+conflict\(/)).toBeGreaterThan(lock);
    const reopen = retry.search(/\.from\(\s*["']topic_kits["']\s*\)\.update\(\s*\{\s*status:\s*["']generating["']\s*\}\s*\)\.eq\(\s*["']id["']\s*,\s*kit\.id\s*\)\.in\(\s*["']status["']\s*,\s*\[\s*["']failed["']\s*,\s*["']generating["']\s*\]\s*\)\.select\(\s*["']id["']\s*\)/);
    // the whitelist, not the row's params verbatim
    const insert = retry.search(/\.from\(\s*["']generations["']\s*\)\.insert\(kitGenerationRows\(gate\.owner,\s*retryParamsOf\(params,\s*kind\),\s*\[kind\]\)\)/);
    expect(reopen).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(reopen);
    expect(retry.search(/if\s*\(\s*!reopened\?\.length\s*\)/)).toBeGreaterThan(reopen);
    expect(retry.indexOf("generationGate()")).toBeLessThan(lock);
    // a lock taken with nothing inserted behind it is released (best effort)
    expect(retry).toMatch(/const\s+unlock\s*=\s*\(\)\s*=>\s*admin\.from\(\s*["']generations["']\s*\)\.update\(\s*\{\s*params\s*\}\s*\)\.eq\(\s*["']id["']\s*,\s*old\.id\s*\)\.eq\(\s*["']status["']\s*,\s*["']error["']\s*\)/);
    expect((retry.match(/await unlock\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // the pointer: the RPC with the replaced id — never a route-side
    // read-modify-write of doc_generation_ids / presentation_generation_id
    const repoint = retry.search(/admin\.rpc\(\s*["']repoint_kit_generation["']\s*,\s*\{\s*p_kit:\s*kit\.id,\s*p_kind:\s*kind,\s*p_generation:\s*newId,\s*p_replaces:\s*old\.id\s*\}\s*\)/);
    expect(repoint).toBeGreaterThan(insert);
    expect(retry).not.toMatch(/docGenerationIdsWith\(/);
    expect(retry).not.toMatch(/doc_generation_ids:/);
    expect(retry).not.toMatch(/presentation_generation_id:/);
    // a refused repoint is audited with both ids (the new row is queued but unreferenced)
    expect(retry).toMatch(/audit\(admin,\s*m\.id,\s*"kit_retry_unpointed",\s*"topic",\s*id/);
    expect(retry).toMatch(/audit\(admin,\s*m\.id,\s*"kit_retry",\s*"topic",\s*id/);
  });

  it("generate: once the kit and its generations exist, a later failure is audited — the bank job is best-effort (warning), the pointer failure names the ids", () => {
    const src = t();
    const create = src.slice(src.indexOf("const createKit = async"), src.indexOf('if (action === "generate")'));
    const gens = create.search(/\.from\(\s*["']generations["']\s*\)\.insert\(kitGenerationRows\(opts\.owner,\s*params\)\)/);
    const after = create.slice(gens);
    // no early return between the generations insert and the audit row
    const auditAt = after.indexOf("await audit(admin, m.id, opts.verb");
    expect(auditAt).toBeGreaterThan(-1);
    const between = after.slice(after.indexOf("const rows ="), auditAt);
    expect(between).not.toMatch(/return\s+dbError\(/);
    expect(between).not.toMatch(/return\s+NextResponse/);
    // both failures land in the audit detail
    expect(after).toMatch(/questions_job_error:/);
    expect(after).toMatch(/pointer_error:/);
    // …and the bank job's failure is a warning on the 200, not a 500
    expect(after).toMatch(/warning:\s*q && !q\.ok/);
    expect(after).not.toMatch(/if\s*\(\s*!q\.ok\s*\)\s*return\s+dbError/);
  });

  it("save_clips: the pure validator first, then a status-guarded write read back", () => {
    const clips = section("save_clips");
    expect(clips).toMatch(/canEditClips\(kit\.status\)/);
    const validate = clips.indexOf("validateClips(body.clips");
    const write = clips.search(/\.from\(\s*["']topic_kits["']\s*\)\.update\(\s*\{\s*clips:\s*v\.clips\s*\}\s*\)\.eq\(\s*["']id["']\s*,\s*kit\.id\s*\)\.in\(\s*["']status["']\s*,\s*CLIP_EDITABLE\s*\)\.select\(\s*["']id["']\s*\)/);
    expect(validate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(validate);
    expect(clips.search(/if\s*\(\s*!written\?\.length\s*\)\s*return\s+conflict\(/)).toBeGreaterThan(write);
    expect(clips.indexOf("audit(")).toBeGreaterThan(write);
    expect(t()).toMatch(/const\s+CLIP_EDITABLE\s*=\s*\[\s*"in_review",\s*"approved",\s*"rejected",\s*"failed"\s*\]/);
  });

  it("every catalogue generations insert asks for `generate`: compose, and the questions job that spends model calls (items stay edit_article)", () => {
    if (has(COMPOSE)) {
      const c = text(COMPOSE);
      expect(c).toMatch(/if\s*\(\s*!libraryAllows\(m\.role,\s*["']generate["']\)\s*\)\s*return\s+notFound\(\)/);
      expect(c).not.toMatch(/libraryAllows\(m\.role,\s*["']edit_article["']\)/);
    }
    if (has(QUESTIONS)) {
      const q = text(QUESTIONS);
      expect(q).toMatch(/generate:\s*"generate"/);
      expect(q).toMatch(/regenerate_rejected:\s*"generate"/);
      for (const a of ["save", "retire"]) expect(q, a).toMatch(new RegExp(`${a}:\\s*"edit_article"`));
      for (const a of ["approve", "reject"]) expect(q, a).toMatch(new RegExp(`${a}:\\s*"approve"`));
    }
    // LibraryAction's own comment names compose under `generate`
    const routing = readFileSync(resolve(__dirname, "..", "library-routing.ts"), "utf8");
    expect(routing).toMatch(/"generate"\s*\/\/[^\n]*compose worksheets/);
  });

  it("audits every action on the topic (approve and reject are audited by the RPCs)", () => {
    const src = t();
    expect(src).toMatch(/audit\(admin,\s*m\.id,\s*opts\.verb,\s*"topic",\s*id/);
    expect(src).toMatch(/verb:\s*"kit_generate"/);
    expect(src).toMatch(/verb:\s*"kit_regenerate"/);
    for (const verb of ["kit_retry", "kit_clips_save"]) {
      expect(src, verb).toMatch(new RegExp(`audit\\(admin,\\s*m\\.id,\\s*"${verb}",\\s*"topic",\\s*id`));
    }
    // the route itself never inserts a job: the bank job is the helper's
    expect(src).not.toMatch(/\.from\(\s*["']jobs["']\s*\)/);
    expect(src).toMatch(/import\s*\{\s*enqueueQuestionsJob\s*\}\s*from\s*["']\.\/questions-job["']/);
  });
});
