/**
 * SK's walkthrough stops (founder feedback 2026-10-30: "point at the exact
 * control, explain every feature"): every line a stop can say is in all ten
 * message files, and every anchor a stop names really exists in a component
 * (a source scan for each data-tour / data-sk value), so a renamed attribute
 * fails here instead of the tour silently skipping a stop.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/walkthrough/__tests__/stops.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { WALK_ROLES, WALK_STOPS, lineKeysFor, type WalkAnchor } from "../stops";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import msArab from "@/i18n/messages/ms-arab.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import hi from "@/i18n/messages/hi.json";
import mr from "@/i18n/messages/mr.json";
import te from "@/i18n/messages/te.json";

const FILES = { en, ms, "ms-arab": msArab, ar, fr, es, pt, hi, mr, te } as const;
const SRC = resolve(__dirname, "..", "..", "..");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const SOURCE = [...tsxFiles(join(SRC, "app")), ...tsxFiles(join(SRC, "components"))].map((f) => readFileSync(f, "utf8")).join("\n");
const HEADER_NAV = readFileSync(join(SRC, "app", "dashboard", "header-nav.tsx"), "utf8");
/** The TOUR_MARK table (nav tabs' markers). */
const TOUR_MARKS = HEADER_NAV.slice(HEADER_NAV.indexOf("export const TOUR_MARK"), HEADER_NAV.indexOf("};", HEADER_NAV.indexOf("export const TOUR_MARK")));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const selOf = (a: WalkAnchor) => (typeof a === "string" ? a : a.sel);

/** Every [attr="value"] in every stop's anchors (own and fallback). */
function attributePairs(): Array<[string, string]> {
  const pairs = new Map<string, [string, string]>();
  for (const defs of Object.values(WALK_STOPS)) {
    for (const d of defs) {
      for (const a of [...d.anchors, ...(d.fallback ?? []).flatMap((f) => f.anchors ?? [])]) {
        for (const m of selOf(a).matchAll(/\[([a-z-]+)="([^"]+)"\]/g)) pairs.set(`${m[1]}=${m[2]}`, [m[1]!, m[2]!]);
      }
    }
  }
  return [...pairs.values()];
}

/** Is `attr="value"` rendered somewhere: literally, as an expression holding
 *  the literal, through a component's `tour` prop, or (data-tour) as a nav
 *  tab's TOUR_MARK entry? */
function rendered(attr: string, value: string): boolean {
  const v = esc(value);
  if (new RegExp(`${esc(attr)}="${v}"`).test(SOURCE)) return true;
  if (new RegExp(`${esc(attr)}=\\{[^}]*"${v}"[^}]*\\}`).test(SOURCE)) return true;
  if (attr === "data-tour") {
    if (new RegExp(`\\btour=(?:"${v}"|\\{[^}]*"${v}"[^}]*\\})`).test(SOURCE)) return true;
    if (new RegExp(`:\\s*"${v}",`).test(TOUR_MARKS) && /data-tour=\{TOUR_MARK\[/.test(SOURCE)) return true;
  }
  // data-tour-kind carries the document kind itself.
  if (attr === "data-tour-kind") return /data-tour-kind=\{kind\}/.test(SOURCE) && /"worksheet"/.test(SOURCE);
  // The Board's launcher marks itself with a boolean.
  if (attr === "data-sk-board") return /data-sk-board=\{/.test(SOURCE);
  return false;
}

describe("every line a stop can say is in all ten message files", () => {
  it("lines per role (own, fallback and per-anchor lines)", () => {
    for (const [code, file] of Object.entries(FILES)) {
      for (const role of WALK_ROLES) {
        const table = file.sk.walkthrough[role] as Record<string, string>;
        for (const key of lineKeysFor(role)) expect(table[key]?.trim(), `${code} sk.walkthrough.${role}.${key}`).toBeTruthy();
      }
    }
  });
  it("no file carries a line no stop says any more (the old teacher 'output' lines are gone)", () => {
    for (const [code, file] of Object.entries(FILES)) {
      for (const role of WALK_ROLES) {
        const keys = new Set(lineKeysFor(role));
        for (const k of Object.keys(file.sk.walkthrough[role] as Record<string, string>)) expect(keys.has(k), `${code} ${role}.${k}`).toBe(true);
      }
    }
  });
  it("the 'once you generate a kit' and 'More' lines say what the code does: free papers, no credit numbers", () => {
    const t = en.sk.walkthrough.teacher;
    expect(t.assignNone).toMatch(/^Once you generate a kit, you'll be able to assign it to a class/);
    expect(t.boardBridge).toBe("Generated kits can be used very efficiently on the whiteboard, which we'll cover in a minute.");
    // Revision papers and exams are free (0063/0112 enforce_fair_use: no credit, a monthly cap).
    expect(t.more).toMatch(/free/);
    for (const [code, file] of Object.entries(FILES)) {
      for (const role of WALK_ROLES) {
        for (const [k, line] of Object.entries(file.sk.walkthrough[role] as Record<string, string>)) {
          expect(line, `${code} ${role}.${k}`).not.toMatch(/[0-9٠-٩०-९౦-౯]+\s*(?:credit|kredit|رصيد|crédit|crédito|क्रेडिट|క్రెడిట్)/iu);
        }
      }
    }
  });
});

describe("every anchor a stop names exists in a component (source scan)", () => {
  const pairs = attributePairs();
  it("finds the attributes it scans for", () => {
    expect(pairs.length).toBeGreaterThan(40);
  });
  it.each(pairs)("[%s=\"%s\"] is rendered somewhere in src/app or src/components", (attr, value) => {
    expect(rendered(attr, value)).toBe(true);
  });
  it("the new Library markers sit on the exact controls", () => {
    const read = (f: string) => readFileSync(join(SRC, "app", "dashboard", f), "utf8");
    expect(read("lesson-card.tsx")).toContain('tour="generate-part"');
    expect(read("lesson-card.tsx")).toContain('<span data-tour="assign-part" className="ms-auto">');
    expect(read("generate-all-button.tsx")).toMatch(/<button\s+data-tour="generate-all"/);
    expect(read("chapter-generate.tsx")).toMatch(/data-tour="generate-lesson"\s+data-tour-kit="full"\s+onClick=\{onGenerate\}/);
    expect(read("content-cell.tsx")).toContain('tour={isPres ? undefined : "rerun"}');
    expect(read("regenerate-button.tsx")).toMatch(/<button\s+data-tour=\{tour\}/);
    expect(read("generate-kit-button.tsx")).toMatch(/<button\s+data-tour=\{tour\}/);
    expect(read("book-table.tsx")).toContain('data-tour-book={isOpen ? "open" : undefined}');
    expect(read("book-tools.tsx")).toContain('data-tour="book-tools"');
  });
});
