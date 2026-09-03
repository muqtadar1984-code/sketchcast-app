/**
 * No server module may CALL into a Client Component module.
 *
 * In the App Router a module that begins with "use client" can be imported by
 * a Server Component, but every export crosses the boundary as a client
 * REFERENCE — renderable as a component, passable as a prop, and nothing else.
 * Calling one throws at render time: "Attempted to call statusLabel() from the
 * server but statusLabel is on the client."
 *
 * That exact throw took the founder's dashboard down on 2026-09-03. page.tsx
 * (a Server Component) imported `statusLabel` from content-cell.tsx ("use
 * client") and called it in the "Other lessons" block. The bug was three weeks
 * old and had never fired, because that block only renders generations whose
 * book is gone, and only calls the helper for ones that aren't "done" — a
 * combination no one had produced until a shelf was cleared while it still
 * carried a failed kit. Nothing static — not tsc, not eslint, not the build —
 * says a word about it; the bundler happily emits the reference and the throw
 * waits for the first reader with the right data.
 *
 * This test is that missing static check. It walks every non-client module
 * under src/, resolves its relative named imports, and fails on any runtime
 * (non-`type`) import whose name starts with a lower-case letter — a function
 * or a value, not a Component — from a module that is "use client". Components
 * are PascalCase and are exactly what a server module is allowed to take from
 * a client one, so they pass.
 *
 * The rule is stricter than "what crashes today" on purpose: a helper reachable
 * only from client graphs right now (which is how `defaultParams` sat in
 * options-modal.tsx) is one new API-route import away from the same throw. A
 * pure helper belongs in a pure module; the fix is always to move it, never to
 * allow-list it here.
 *
 * Run: npx vitest run src/__tests__/server-client-boundary.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SRC = resolve(__dirname, "..");

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

/** "use client" must be the first statement; only comments may precede it. */
function isClientModule(file: string): boolean {
  const head = (source.get(file) ?? "").slice(0, 400);
  return /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*["']use client["']/.test(head);
}

function resolveRelative(from: string, spec: string): string | null {
  // "@/x" is tsconfig's alias for "src/x" — a server module can reach a client
  // one through it just as easily as through "./x".
  const base = spec.startsWith("@/") ? resolve(SRC, spec.slice(2)) : resolve(dirname(from), spec);
  for (const c of [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    if (source.has(c)) return c;
  }
  return null;
}

// `import { a, type B, c as d } from "./x"` — the type-only FORM
// (`import type {…}`) is skipped by the negative lookahead.
const NAMED_IMPORT = /import\s+(?!type\s)\{([^}]*)\}\s*from\s*["'']((?:\.|@\/)[^"']+)["'']/g;

type Offence = { from: string; name: string; to: string };

function offences(): Offence[] {
  const found: Offence[] = [];
  for (const [file, text] of source) {
    if (isClientModule(file)) continue;
    for (const m of text.matchAll(NAMED_IMPORT)) {
      const target = resolveRelative(file, m[2]);
      if (!target || !isClientModule(target)) continue;
      for (const raw of m[1].split(",")) {
        const spec = raw.trim();
        if (!spec || spec.startsWith("type ")) continue;
        const name = spec.split(/\s+as\s+/)[0].trim();
        if (/^[a-z]/.test(name)) {
          found.push({ from: file.slice(SRC.length + 1), name, to: target.slice(SRC.length + 1) });
        }
      }
    }
  }
  return found;
}

describe("server modules never call into client modules", () => {
  it("scans a meaningful number of modules", () => {
    // Guards the walker itself: an empty scan would pass vacuously.
    expect(files.length).toBeGreaterThan(200);
    expect(files.filter(isClientModule).length).toBeGreaterThan(50);
  });

  it("finds no lower-case runtime import from a 'use client' module into a server module", () => {
    const bad = offences();
    const report = bad.map((o) => `  ${o.from} imports ${o.name} from ${o.to}`).join("\n");
    expect(bad, `Move the helper to a module without "use client":\n${report}`).toEqual([]);
  });
});
