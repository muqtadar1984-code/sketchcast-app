/**
 * Guard: every /api/library/* route handler is shaped the way the portal's
 * access model needs (topic-catalogue plan §7.1–7.2).
 *
 *   1. `export const runtime = "nodejs"` — the service-role client and the
 *      membership RPC run on Node, never the edge.
 *   2. The FIRST await in every exported handler is isLibraryMemberRequest( —
 *      the layout does not guard route handlers, so each one must, before it
 *      reads a body, opens a client, or touches a table.
 *   3. Nothing under /api/library reads or writes `generations` — Phase 1 is
 *      taxonomy only; catalogue builds arrive in a later phase behind their own
 *      guards, and the harvest is an OBSERVER job (generation_id NULL).
 *   4. Exactly ONE file inserts into `jobs` (the harvest route), and it never
 *      inserts into `generations` (pipeline-universal.test.ts' invariant).
 *   5. Every POST handler writes platform_audit_log.
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
  it("has the Phase 1 routes", () => {
    const names = routes.map(rel).sort();
    expect(names).toEqual(
      [
        "candidates/route.ts",
        "curricula/[id]/nodes/route.ts",
        "curricula/route.ts",
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

  it("inserts into `jobs` from exactly the harvest route, and nowhere else", () => {
    const jobInsert = /\.from\(\s*["']jobs["']\s*\)[\s\S]{0,200}?\.insert\(/;
    const inserters = [...source].filter(([, text]) => jobInsert.test(text)).map(([f]) => rel(f));
    expect(inserters).toEqual(["harvest/route.ts"]);
    // The harvest job is an observer: it owns no generation.
    const harvest = source.get(routes.find((f) => rel(f) === "harvest/route.ts")!)!;
    expect(harvest).toMatch(/type:\s*HARVEST_JOB_TYPE|type:\s*["']topic_harvest["']/);
    expect(harvest).toMatch(/generation_id:\s*null/);
    expect(harvest).toMatch(/status:\s*["']queued["']/);
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

  it("the curate-only routes ask the guard for the curate action", () => {
    for (const name of ["candidates/route.ts", "curricula/route.ts", "harvest/route.ts"]) {
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
