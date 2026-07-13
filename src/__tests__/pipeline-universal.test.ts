/**
 * Guard: book upload + generation stay a SINGLE, shared, role-agnostic path, so
 * any pipeline improvement (chapter detection, self-heal, …) reaches EVERY adult
 * who can author — teacher, principal, coordinator, school_admin, parent-author —
 * not just the profile we happened to test.
 *
 * A `books` insert fires the `create_index_job_for_book` trigger → `index_book`;
 * a `generations` insert fires `on_generation_created` → `process_generation`.
 * Both triggers are unconditional (no role), and the worker job carries only
 * book_id / generation_id. So the one thing to protect is: don't grow a SECOND,
 * divergent upload entry point that could quietly skip the shared pipeline.
 *
 * If this test fails, you added a new place that inserts a `books` row. That's
 * fine IF it inserts a normal books row (so the index trigger fires and every
 * pipeline fix applies regardless of the uploader's role) — in that case add the
 * file to ALLOWED_UPLOADERS. It is NOT fine if it bypasses that. See
 * docs/PIPELINE_INVARIANTS.md.
 *
 * Run: npx vitest run src/__tests__/pipeline-universal.test.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ALLOWED_UPLOADERS = ["src/app/dashboard/upload-book.tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "node_modules" && entry !== ".next") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

const norm = (p: string) => p.replace(/\\/g, "/");
const files = walk("src");

describe("book upload + generation is one shared, universal path", () => {
  it("has exactly one book-upload entry point (every adult's book hits the same index pipeline)", () => {
    const bookInsert = /\.from\(\s*["']books["']\s*\)\s*\.insert/;
    const uploaders = files.filter((f) => bookInsert.test(readFileSync(f, "utf8"))).map(norm);
    expect(uploaders.sort()).toEqual([...ALLOWED_UPLOADERS].sort());
  });

  it("every generation entry point relies on the DB trigger (never creates its own job) so the shared worker path always runs", () => {
    // Files that insert a `generations` row must NOT also insert a `jobs` row —
    // the on_generation_created trigger owns that, uniformly for all roles. A
    // hand-rolled job insert could diverge (wrong type, skip the pipeline).
    const genInsert = /\.from\(\s*["']generations["']\s*\)\s*\.insert/;
    const jobInsert = /\.from\(\s*["']jobs["']\s*\)\s*\.insert/;
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return genInsert.test(src) && jobInsert.test(src);
    }).map(norm);
    expect(offenders).toEqual([]);
  });
});
