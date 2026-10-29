// SK S3 slice E — the packager clip path is retired: no file under src/,
// public/ or tools/ may name its old folder again (S3 acceptance: "no
// public/<old folder> references remain"), neither in its contents nor in its
// path. The needle is assembled at run time so this file does not match itself.
//
// The walk is synchronous on purpose: an earlier async source scan timed out.
// Run: node node_modules/vitest/vitest.mjs run src/__tests__/no-packager-clip-path.test.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const NEEDLE = ["sk", "s1"].join("-");
const NEEDLE_BYTES = Buffer.from(NEEDLE, "utf-8");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

function walk(dir: string, out: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a root that does not exist has nothing in it
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe(`no "${NEEDLE}" reference returns`, () => {
  const files = ["src", "public", "tools"].flatMap((d) => walk(join(ROOT, d), []));

  it("the walk sees the tree (a guard that scans nothing proves nothing)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(join("sk", "server.ts")))).toBe(true);
  });

  it("no path and no file content names it", () => {
    const hits: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).split("\\").join("/");
      if (rel.toLowerCase().includes(NEEDLE)) {
        hits.push(`${rel} (path)`);
        continue;
      }
      if (readFileSync(f).includes(NEEDLE_BYTES)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });
});
