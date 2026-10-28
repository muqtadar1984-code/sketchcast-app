/**
 * The SK panel's colours are its own (founder, 2026-10-28): on /present the
 * Board sets light text for a dark room and the panel inherited it — the
 * title and the typed text went near-invisible on the white card. No unit
 * test can see a colour, so this pins the SOURCE: the panel root carries an
 * explicit near-black text colour and a light colour-scheme, the input its
 * own text and placeholder colours, and the launcher's label stays white.
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/sk-shell-colours.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (f: string) => readFileSync(resolve(__dirname, "..", f), "utf8");

/** The className literal of the element carrying `data-sk="<marker>"`. */
function classOf(src: string, marker: string): string {
  const at = src.indexOf(`data-sk="${marker}"`);
  expect(at, marker).toBeGreaterThan(0);
  // The className sits in the same JSX opening tag, within a few hundred chars before the marker.
  const head = src.slice(Math.max(0, at - 600), at);
  const m = [...head.matchAll(/className="([^"]*)"/g)].at(-1);
  expect(m, `className before ${marker}`).toBeTruthy();
  return m![1];
}

describe("sk-shell.tsx: page-independent colours", () => {
  const src = read("sk-shell.tsx");
  it("the panel root overrides any inherited text colour and pins a light colour scheme", () => {
    const root = classOf(src, "shell");
    expect(root.split(/\s+/)).toEqual(expect.arrayContaining(["text-slate-900", "[color-scheme:light]"]));
  });
  it("the input has its own background, text and placeholder colours", () => {
    const input = classOf(src, "input");
    expect(input.split(/\s+/)).toEqual(expect.arrayContaining(["bg-white", "text-slate-900", "placeholder:text-slate-400"]));
  });
  it("the title, caption and job tray are explicit, not inherited", () => {
    expect(src).toContain('<span className="truncate text-slate-900">{copy.title}</span>');
    expect(classOf(src, "caption")).toContain("text-slate-600");
    expect(classOf(src, "job-tray")).toContain("text-slate-600");
    expect(classOf(src, "capabilities")).toContain("text-slate-500");
  });
});

describe("sk-launcher.tsx: the launcher's label is white on the primary button", () => {
  it("carries text-white explicitly", () => {
    const src = read("sk-launcher.tsx");
    const m = /className="group btn-primary[^"]*"/.exec(src);
    expect(m).toBeTruthy();
    expect(m![0]).toContain("text-white");
  });
});
