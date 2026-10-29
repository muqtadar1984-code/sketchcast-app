/**
 * S5 slice C — the leader-figure phrasings (EN / MS / AR, at least six per
 * capability), routed deterministically ONLY on a leader hat (seats: the
 * principal only), and sk.shell.school.figures.* (school-figure-lines.ts)
 * equal to the ten dictionaries.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/school-figures-rules.test.ts
 */
import { describe, expect, it } from "vitest";
import { routeLeader } from "../leader-rules";
import { routeByRules } from "../rules";
import { SCHOOL_FIGURE_LINES } from "../school-figure-lines";
import { makeCtx, NOW } from "./fixtures";
import { LOCALES } from "@/i18n/locales";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import te from "@/i18n/messages/te.json";
import mr from "@/i18n/messages/mr.json";
import hi from "@/i18n/messages/hi.json";
import msArab from "@/i18n/messages/ms-arab.json";

const principal = makeCtx({ role: "school_admin", hat: "principal" });
const coordinator = makeCtx({ role: "teacher", hat: "coordinator", scope: [{ grade: "5", subject: null }] });

const CASES: Array<[string, string, Record<string, string>?]> = [
  // school.seats
  ["how many teachers and students do we have", "school.seats"],
  ["How many teachers do we have?", "school.seats"],
  ["how many students are there", "school.seats"],
  ["our licence", "school.seats"],
  ["show me our license status", "school.seats"],
  ["seats", "school.seats"],
  ["how many seats are used", "school.seats"],
  ["berapa guru dan pelajar", "school.seats"],
  ["berapa ramai murid di sekolah ini", "school.seats"],
  ["status lesen sekolah", "school.seats"],
  ["bilangan guru dan murid", "school.seats"],
  ["كم عدد المعلمين", "school.seats"],
  ["كم عدد المعلمين والطلاب؟", "school.seats"],
  ["ترخيص المدرسة", "school.seats"],
  // school.cost
  ["how much have we spent on kits", "school.cost"],
  ["what's our generation cost", "school.cost"],
  ["show me the kit cost", "school.cost"],
  ["how much do our kits cost", "school.cost"],
  ["which teachers spend the most", "school.cost"],
  ["school spending", "school.cost"],
  ["berapa kos penjanaan", "school.cost"],
  ["kos kit sekolah", "school.cost"],
  ["berapa banyak kita belanja untuk kit", "school.cost"],
  ["كم تكلفة الحزم", "school.cost"],
  ["تكاليف المدرسة", "school.cost"],
  ["كم أنفقنا على الحزم", "school.cost"],
  // school.gaps
  ["shelf gaps", "school.gaps"],
  ["what are the book gaps", "school.gaps"],
  ["what's missing from the shelf", "school.gaps"],
  ["which subjects have no books", "school.gaps"],
  ["what books are we missing", "school.gaps"],
  ["are there any gaps on the shelf in grade 5", "school.gaps", { grade: "grade 5" }],
  ["jurang rak buku", "school.gaps"],
  ["subjek mana yang tiada buku", "school.gaps"],
  ["apa yang kurang di rak buku sekolah", "school.gaps"],
  ["ما الفجوات في رف الكتب", "school.gaps"],
  ["ما المواد التي ليس لها كتب", "school.gaps"],
  ["ما الكتب الناقصة", "school.gaps"],
  // school.trend
  ["show me the 4-week trend", "school.trend"],
  ["school trend", "school.trend"],
  ["how are we trending", "school.trend"],
  ["are we improving", "school.trend"],
  ["on-time rate trend", "school.trend"],
  ["trend for grade 5", "school.trend", { grade: "grade 5" }],
  ["trend sekolah", "school.trend"],
  ["adakah kita semakin baik", "school.trend"],
  ["bagaimana trend kita", "school.trend"],
  ["ما اتجاه المدرسة", "school.trend"],
  ["هل نتحسن", "school.trend"],
  ["كيف يسير الاتجاه", "school.trend"],
];

describe("routeLeader — the figure phrasings", () => {
  it("at least six phrasings per capability across EN / MS / AR", () => {
    for (const cap of ["school.seats", "school.cost", "school.gaps", "school.trend"]) {
      const mine = CASES.filter((c) => c[1] === cap);
      expect(mine.length, cap).toBeGreaterThanOrEqual(6);
      expect(mine.some(([t]) => /[؀-ۿ]/.test(t)), `${cap} Arabic`).toBe(true);
      expect(mine.some(([t]) => /\b(berapa|kos|jurang|subjek|trend sekolah|lesen|kita)\b/.test(t)), `${cap} Malay`).toBe(true);
    }
  });

  it.each(CASES)("principal: %s → %s", (text, capability, args) => {
    expect(routeLeader(text, principal)).toEqual({ capability, args: args ?? {} });
    // …and the whole router hands it over as a leader ask.
    expect(routeByRules(text, principal, NOW)).toEqual({ intent: "ask", leader: { capability, args: args ?? {} } });
  });

  it.each(CASES.filter((c) => c[1] !== "school.seats"))("coordinator: %s → %s", (text, capability, args) => {
    expect(routeLeader(text, coordinator)).toEqual({ capability, args: args ?? {} });
  });

  it("seats are never routed for a coordinator (decision 5)", () => {
    for (const [text] of CASES.filter((c) => c[1] === "school.seats")) expect(routeLeader(text, coordinator), text).toBeNull();
  });

  it("no leader hat → never a figure route (teacher hat, plain teacher, parent)", () => {
    for (const ctx of [makeCtx({ role: "school_admin", hat: "teacher" }), makeCtx({ role: "teacher", hat: "teacher" }), makeCtx({ role: "parent", hat: "parent" })]) {
      for (const [text] of CASES) expect(routeLeader(text, ctx), text).toBeNull();
    }
  });

  it("slice A's routes are untouched", () => {
    expect(routeLeader("how is the school doing", principal)).toEqual({ capability: "school.health", args: { focus: "overview" } });
    expect(routeLeader("who is at risk in grade 5", coordinator)).toEqual({ capability: "learners.risk", args: { grade: "grade 5" } });
    expect(routeByRules("open the school shelf", principal, NOW)).toMatchObject({ intent: "navigate", target: "school_books" });
  });
});

type Shell = { sk: { shell: { school: { figures: Record<string, string> } } } };
const FILES: Record<string, Shell> = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, Shell>;

describe("school-figure-lines.ts ⇄ messages/*.json (sk.shell.school.figures.*)", () => {
  it("every key, every locale, equal; placeholders kept", () => {
    for (const { value } of LOCALES) {
      const dict = FILES[value].sk.shell.school.figures;
      expect(Object.keys(dict).sort(), value).toEqual(Object.keys(SCHOOL_FIGURE_LINES).sort());
      for (const [key, line] of Object.entries(SCHOOL_FIGURE_LINES)) {
        expect(line[value], `${value}.${key}`).toBe(dict[key]);
        const want = (line.en.match(/\{\w+\}/g) ?? []).sort();
        expect((line[value].match(/\{\w+\}/g) ?? []).sort(), `${value}.${key} placeholders`).toEqual(want);
      }
    }
    for (const line of Object.values(SCHOOL_FIGURE_LINES)) expect(Object.keys(line).sort()).toEqual(LOCALES.map((l) => l.value).sort());
  });
  it("Jawi is Jawi (Arabic script), not Rumi; every locale differs from English except where a word is shared", () => {
    for (const [key, line] of Object.entries(SCHOOL_FIGURE_LINES)) {
      expect(line["ms-arab"], key).toMatch(/[؀-ۿ]/);
      expect(line.ar, key).toMatch(/[؀-ۿ]/);
      for (const loc of ["ms", "fr", "es", "pt", "te", "mr", "hi"]) expect(line[loc], `${loc}.${key}`).not.toBe(line.en);
    }
  });
});
