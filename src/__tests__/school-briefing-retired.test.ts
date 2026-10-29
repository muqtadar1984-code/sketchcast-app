/**
 * SK S5 slice E — the School Briefing panel is RETIRED (SK S5 design
 * 2026-10-29 decision 7; Final Plan §3: "School Briefing launcher — retire
 * after §8 gates"). Nothing in src/ may bring it back by name: the panel
 * (school-assistant.tsx), its route (/api/school-assistant), its prompt
 * (utils/school-assistant), its flag (schoolAssistantEnabledFor /
 * FEATURE_SCHOOL_ASSISTANT) and its strings (school.briefing) are gone, and
 * SK's launcher shows on /dashboard/school instead.
 *
 * What stays: the shared 60/day counter still counts the panel's historic
 * `school_briefing` rows in today's window (school-meter.ts).
 *
 * Run: node node_modules/vitest/vitest.mjs run src/__tests__/school-briefing-retired.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { LOCALES } from "@/i18n/locales";
import { SCHOOL_BRIEFING_SCOPE } from "@/sk/shell/school-meter";

const SRC = resolve(__dirname, "..");
const SELF = resolve(__filename);
const BANNED = /school-assistant|schoolAssistantEnabledFor|SchoolAssistantLauncher|FEATURE_SCHOOL_ASSISTANT/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|json)$/.test(name)) out.push(p);
  }
  return out;
}

describe("the School Briefing panel is retired", () => {
  it("no file under src/ names the panel, its route, its prompt or its flag", () => {
    const hits = walk(SRC)
      .filter((p) => resolve(p) !== SELF)
      .flatMap((p) =>
        readFileSync(p, "utf8")
          .split(/\r?\n/)
          .map((line, i) => (BANNED.test(line) ? `${relative(SRC, p)}:${i + 1}: ${line.trim()}` : null))
          .filter((h): h is string => h !== null),
      );
    expect(hits).toEqual([]);
    // A walk of all of src/ (≈ 2k files) can take seconds when the suite runs alongside others.
  }, 60_000);

  it("no locale carries the school.briefing strings", () => {
    for (const l of LOCALES) {
      const m = JSON.parse(readFileSync(join(SRC, "i18n", "messages", `${l.value}.json`), "utf8")) as { school?: Record<string, unknown> };
      expect(m.school?.briefing, l.value).toBeUndefined();
    }
  });

  it("SK's launcher is no longer hidden on /dashboard/school", () => {
    const launcher = readFileSync(join(SRC, "app", "dashboard", "sk-launcher.tsx"), "utf8");
    expect(launcher).not.toMatch(/startsWith\(\s*["']\/dashboard\/school["']\s*\)/);
  });

  it("the shared 60/day counter still counts the panel's historic school_briefing rows", () => {
    expect(SCHOOL_BRIEFING_SCOPE).toBe("school_briefing");
    const meter = readFileSync(join(SRC, "sk", "shell", "school-meter.ts"), "utf8");
    expect(meter).toMatch(/\.in\("scope", \[SK_SCHOOL_SCOPE, SCHOOL_BRIEFING_SCOPE\]\)/);
  });
});
