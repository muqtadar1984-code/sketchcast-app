/**
 * The SK allow-lists never reach a browser.
 *
 * SK_ALLOWED_EMAILS and SK_ALLOWED_STUDENTS_OF name real people (the founder,
 * a teacher) and the students they unlock are found with the service role.
 * Only one boolean per surface may cross to the client (skOn / the launcher
 * mounting). Pinned three ways:
 *   1. no NEXT_PUBLIC_ variable carries either list (Next inlines those into
 *      the client bundle), in src/ or next.config;
 *   2. no "use client" module mentions either variable;
 *   3. no "use client" module can REACH src/utils/flags.ts or
 *      src/sk/access-gate.ts through its static imports (transitively), so the
 *      bundler never pulls the parsers — or the service-role client — in.
 * See also server-client-boundary.test.ts (no server module calls client code).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const source = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const isClient = (f: string) => /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*["']use client["']/.test((source.get(f) ?? "").slice(0, 400));

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return null;
  const base = spec.startsWith("@/") ? resolve(SRC, spec.slice(2)) : resolve(dirname(from), spec);
  for (const c of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) if (source.has(c)) return c;
  return null;
}

// Runtime imports only: `import type` / `export type` erase at build time.
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function deps(file: string): string[] {
  const out: string[] = [];
  for (const m of (source.get(file) ?? "").matchAll(IMPORT)) {
    const r = resolveSpec(file, m[1] ?? m[2]);
    if (r) out.push(r);
  }
  return out;
}

const SECRET_MODULES = [join(SRC, "utils", "flags.ts"), join(SRC, "sk", "access-gate.ts")];
const VARS = /SK_ALLOWED_EMAILS|SK_ALLOWED_STUDENTS_OF/;

describe("the SK allow-lists stay on the server", () => {
  it("the scan is not vacuous", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.filter(isClient).length).toBeGreaterThan(50);
    for (const m of SECRET_MODULES) expect(source.has(m), m).toBe(true);
  });

  it("no NEXT_PUBLIC_ variable carries an allow-list", () => {
    const bad = /NEXT_PUBLIC_[A-Z_]*(?:ALLOWED_EMAILS|ALLOWED_STUDENTS_OF)/;
    const offenders = files.filter((f) => bad.test(source.get(f) ?? "")).map((f) => relative(ROOT, f));
    for (const cfg of ["next.config.ts", "next.config.js", "next.config.mjs"]) {
      const p = join(ROOT, cfg);
      if (existsSync(p) && (bad.test(readFileSync(p, "utf8")) || VARS.test(readFileSync(p, "utf8")))) offenders.push(cfg);
    }
    expect(offenders).toEqual([]);
  });

  it("no client module mentions either variable", () => {
    expect(files.filter((f) => isClient(f) && VARS.test(source.get(f) ?? "")).map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("no client module reaches flags.ts or access-gate.ts through its imports", () => {
    const offenders: string[] = [];
    for (const start of files.filter(isClient)) {
      const seen = new Set<string>([start]);
      const stack = [start];
      const parent = new Map<string, string>();
      while (stack.length) {
        const f = stack.pop()!;
        if (SECRET_MODULES.includes(f)) {
          const chain: string[] = [];
          for (let c: string | undefined = f; c; c = parent.get(c)) chain.unshift(relative(SRC, c));
          offenders.push(chain.join(" → "));
          break;
        }
        for (const d of deps(f)) {
          if (seen.has(d)) continue;
          seen.add(d);
          parent.set(d, f);
          stack.push(d);
        }
      }
    }
    expect(offenders, `A client module would bundle the allow-list gate:\n${offenders.join("\n")}`).toEqual([]);
  });
});
