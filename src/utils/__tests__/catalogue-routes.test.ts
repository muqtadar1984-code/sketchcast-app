/**
 * Guard: every /api/library/* route handler is shaped the way the portal's
 * access model needs (topic-catalogue plan §7.1–7.2).
 *
 *   1. `export const runtime = "nodejs"` — the service-role client and the
 *      membership RPC run on Node, never the edge.
 *   2. The FIRST await in every exported handler is isLibraryMemberRequest( —
 *      the layout does not guard route handlers, so each one must, before it
 *      reads a body, opens a client, or touches a table.
 *   3. Nothing under /api/library reads or writes `generations` — Phases 1–2a
 *      are taxonomy only; catalogue builds arrive in a later phase behind their
 *      own guards, and the harvest and derive jobs are OBSERVER jobs
 *      (generation_id NULL; derive also book_id NULL, its input in jobs.params).
 *   4. Exactly TWO files insert into `jobs` (the harvest and derive routes), and
 *      neither inserts into `generations` (pipeline-universal.test.ts' invariant).
 *   5. Every POST handler writes platform_audit_log.
 *   6. Phase 2a: a grouped candidate maps its node_ids; create-from-node maps
 *      the ticked children; the bulk create pre-checks every key and skips a
 *      taken one instead of answering 200 with a half-made topic.
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

describe("the /api/library routes exist and are scanned", () => {
  it("has the Phase 1 + 2a routes", () => {
    const names = routes.map(rel).sort();
    expect(names).toEqual(
      [
        "candidates/bulk/route.ts",
        "candidates/route.ts",
        "curricula/[id]/nodes/route.ts",
        "curricula/route.ts",
        "derive/route.ts",
        "harvest/route.ts",
        "topics/[id]/route.ts",
        "topics/route.ts",
      ].sort(),
    );
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

  it("never touches `generations`", () => {
    for (const [f, text] of source) {
      expect(text, rel(f)).not.toMatch(/\.from\(\s*["']generations["']\s*\)/);
    }
  });

  it("inserts into `jobs` from exactly the harvest and derive routes, and nowhere else", () => {
    const jobInsert = /\.from\(\s*["']jobs["']\s*\)[\s\S]{0,200}?\.insert\(/;
    const inserters = [...source].filter(([, text]) => jobInsert.test(text)).map(([f]) => rel(f)).sort();
    expect(inserters).toEqual(["derive/route.ts", "harvest/route.ts"]);
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

  it("the harvest and derive routes map a lost race on their one-live index (23505) to the 409", () => {
    for (const name of ["harvest/route.ts", "derive/route.ts"]) {
      const text = source.get(routes.find((f) => rel(f) === name)!)!;
      expect(text, name).toMatch(/jErr\.code\s*===\s*["']23505["']/);
      const branch = text.slice(text.indexOf('jErr.code === "23505"'));
      expect(branch.indexOf("conflict("), name).toBeGreaterThan(-1);
      expect(branch.indexOf("conflict("), name).toBeLessThan(branch.indexOf("dbError("));
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

  it("the bulk create pre-checks every key with keyOwner( BEFORE inserting, skips a taken one, and takes a raced topic back out", () => {
    const text = source.get(routes.find((f) => rel(f) === "candidates/bulk/route.ts")!)!;
    const loop = text.slice(text.indexOf("for (const candidate of rows)"));
    const check = loop.indexOf("keyOwner(");
    const insert = loop.indexOf("insertTopic(");
    expect(check).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(check);
    expect(loop).toMatch(/skipped\.push\(/);
    expect(loop).toMatch(/\brollbackTopic\(/);
    // only OPEN, curriculum-source, unmatched rows of THIS curriculum
    expect(text).toMatch(/\.eq\(\s*["']status["']\s*,\s*["']open["']\s*\)/);
    expect(text).toMatch(/\.eq\(\s*["']source_kind["']\s*,\s*["']curriculum["']\s*\)/);
    expect(text).toMatch(/\.is\(\s*["']suggested_topic_id["']\s*,\s*null\s*\)/);
    expect(text).toMatch(/\.eq\(\s*["']curriculum_nodes\.curriculum_id["']\s*,\s*curriculumId\s*\)/);
    // the batch itself is audited on the curriculum
    expect(text).toMatch(/audit\(admin,\s*m\.id,\s*"candidates_bulk_create",\s*"curriculum",\s*curriculumId/);
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
