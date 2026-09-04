import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// premiumVoices (paid plan or comp override, from my_fair_use on the dashboard
// page) has to reach two leaves: the chapter row's voice picker and the
// per-part kit button's reuse prediction. It travels through five JSX sites,
// and vitest collects no .tsx, so a dropped prop at any of them would be
// silent — the picker would quietly show free voices to a paying school. This
// reads the sources and asserts the wiring, the way the server/client boundary
// test does.

const src = (rel: string) => readFileSync(join(process.cwd(), "src/app/dashboard", rel), "utf8");

describe("premiumVoices threading", () => {
  it("the page computes it from my_fair_use and hands it to every BookTable", () => {
    const page = src("page.tsx");
    expect(page).toMatch(/premiumVoices = premiumVoicesFor\(/);
    expect(page.match(/premiumVoices=\{premiumVoices\}/g)?.length).toBe(2);
  });

  it("BookTable forwards it to the chapter row and to every lesson card", () => {
    const table = src("book-table.tsx");
    expect(table).toMatch(/premiumVoices\?: boolean/);
    expect(table.match(/premiumVoices=\{premiumVoices\}/g)?.length).toBe(2);
  });

  it("LessonCard forwards it to the kit button", () => {
    expect(src("lesson-card.tsx")).toMatch(/<GenerateKitButton[\s\S]*?premiumVoices=\{premiumVoices\}/);
  });

  it("the two leaves consume it", () => {
    expect(src("chapter-generate.tsx")).toMatch(/availableVoices\([^)]*\{ premium: premiumVoices \}/);
    expect(src("generate-kit-button.tsx")).toMatch(/expectedVoiceFor\(language, premiumVoices\)/);
  });
});
