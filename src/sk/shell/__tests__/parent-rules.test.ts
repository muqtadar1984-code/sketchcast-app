/**
 * S4 — the parent phrasings of the rules router (EN / MS / AR, at least six per
 * capability), the child they name, and the parent lines' parity with the
 * dictionaries (sk.shell.parent.* in all ten locales).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/parent-rules.test.ts
 */
import { describe, expect, it } from "vitest";
import { routeByRules } from "../rules";
import { routeParent, type SkParentCapability } from "../parent-rules";
import { PARENT_LINE_TABLES } from "../parent-lines";
import { makeCtx, NOW } from "./fixtures";
import { A1, A2, PA, PB, B1, parentCtx } from "@/sk/capabilities/__tests__/parent-fixtures";
import { formatCode, generateEditionCode } from "@/sk/access";
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

const ALL = undefined;
/** [phrase, capability, expected child arg (an id when a linked child is named, the raw words otherwise, undefined = every child)] */
const CASES: Array<[string, SkParentCapability, string | undefined]> = [
  // child.status
  ["how is Aisyah doing", "child.status", A1],
  ["How are my kids doing?", "child.status", "my kids"],
  ["what's overdue for Adam", "child.status", A2],
  ["what is overdue", "child.status", ALL],
  ["how's Adam getting on", "child.status", A2],
  ["Aisyah's homework", "child.status", A1],
  ["any feedback for Adam", "child.status", A2],
  ["bagaimana anak saya", "child.status", "anak saya"],
  ["bagaimana dengan Aisyah", "child.status", A1],
  ["markah Adam", "child.status", A2],
  ["apa yang lewat untuk Aisyah", "child.status", A1],
  ["كيف حال ابني", "child.status", "ابني"],
  ["كيف حال Aisyah؟", "child.status", A1],
  ["درجات Adam", "child.status", A2],
  // child.week
  ["Aisyah's week", "child.week", A1],
  ["how was Adam's week?", "child.week", A2],
  ["how was my kids' week", "child.week", "my kids"],
  ["weekly summary", "child.week", ALL],
  ["weekly summary for Aisyah", "child.week", A1],
  ["what did Adam do this week", "child.week", A2],
  ["minggu Aisyah", "child.week", A1],
  ["ringkasan minggu ini untuk Adam", "child.week", A2],
  ["أسبوع Aisyah", "child.week", A1],
  ["ملخص الأسبوع", "child.week", ALL],
  // child.risk
  ["is Aisyah at risk", "child.risk", A1],
  ["is Adam struggling?", "child.risk", A2],
  ["did Aisyah do well", "child.risk", A1],
  ["should I worry about Adam", "child.risk", A2],
  ["are any of my kids falling behind", "child.risk", ALL],
  ["adakah Aisyah ketinggalan", "child.risk", A1],
  ["هل Adam متأخر", "child.risk", A2],
  ["هل يعاني Aisyah", "child.risk", A1],
  // child.progress
  ["what has Aisyah mastered", "child.progress", A1],
  ["what is Adam good at", "child.progress", A2],
  ["what does Aisyah need to work on", "child.progress", A1],
  ["Adam's progress", "child.progress", A2],
  ["apa yang Aisyah sudah kuasai", "child.progress", A1],
  ["kemajuan Adam", "child.progress", A2],
  ["ماذا أتقن Aisyah", "child.progress", A1],
  ["تقدم Adam", "child.progress", A2],
  // child.diary
  ["what's in Aisyah's diary", "child.diary", A1],
  ["any notes for Adam", "child.diary", A2],
  ["Aisyah's diary notes", "child.diary", A1],
  ["what did the teacher write about Adam", "child.diary", A2],
  ["any new diary notes", "child.diary", ALL],
  ["catatan diari Aisyah", "child.diary", A1],
  ["apa cikgu tulis tentang Adam", "child.diary", A2],
  ["ماذا كتب المعلم عن Aisyah", "child.diary", A1],
  ["ملاحظات يوميات Adam", "child.diary", A2],
  // child.notices
  ["any notices", "child.notices", ALL],
  ["any school notices?", "child.notices", ALL],
  ["notices from Adam's school", "child.notices", A2],
  ["what's on the notice board", "child.notices", ALL],
  ["notis sekolah", "child.notices", ALL],
  ["ada pengumuman sekolah", "child.notices", ALL],
  ["هل هناك إشعارات", "child.notices", ALL],
  ["إعلانات المدرسة", "child.notices", ALL],
];

describe("routeParent — parent phrasings (EN/MS/AR)", () => {
  const ctx = parentCtx(PA);
  it.each(CASES)("%s → %s", (text, capability, child) => {
    const d = routeByRules(text, ctx, NOW);
    expect(d).toEqual({ intent: "ask", parent: { capability, args: child === undefined ? {} : { child } } });
  });
  it("at least six phrasings per capability, in all three launch languages", () => {
    const caps: SkParentCapability[] = ["child.status", "child.diary", "child.notices", "child.risk", "child.progress", "child.week"];
    for (const c of caps) {
      const mine = CASES.filter((x) => x[1] === c).map((x) => x[0]);
      expect(mine.length, c).toBeGreaterThanOrEqual(6);
      expect(mine.some((p) => /[a-z]/i.test(p) && /\b(?:how|what|is|did|any|notices|week|should|are)\b/i.test(p)), `${c} en`).toBe(true);
      expect(mine.some((p) => /[؀-ۿ]/.test(p)), `${c} ar`).toBe(true);
    }
  });
  it("a name that is not a linked child is passed on (the capability refuses it), never resolved to another child", () => {
    expect(routeParent("how is Zara doing", ctx)).toEqual({ capability: "child.status", args: { child: "zara" } });
    expect(routeParent(`how is ${B1} doing`, ctx)?.args.child).not.toBe(A1);
  });
  it("only parents: a teacher's 'how is Aisyah doing' stays with the model; navigation stays navigation", () => {
    expect(routeParent("how is Aisyah doing", makeCtx({ role: "teacher" }))).toBeNull();
    expect(routeByRules("how is Aisyah doing", makeCtx({ role: "teacher" }), NOW)).toEqual({ intent: "ask" });
    expect(routeByRules("open my children", ctx, NOW)).toMatchObject({ intent: "navigate", target: "children" });
    expect(routeByRules("open the diary", ctx, NOW)).toMatchObject({ intent: "navigate", target: "diary" });
    expect(routeByRules("thanks", ctx, NOW)).toMatchObject({ intent: "chat" });
    expect(routeParent("how is it doing", ctx)).toBeNull();
  });
  it("one child: 'how is my son doing' is about that child", () => {
    expect(routeParent("how is my son doing", parentCtx(PB))).toEqual({ capability: "child.status", args: { child: "my son" } });
  });
});

// S4 slices C+D together: a book code is decided BEFORE the parent rules (a
// code never reaches anything else), and the book rules never swallow a
// parent's question about a child.
describe("a parent's book code → book.activate, never child.*", () => {
  const CODE = generateEditionCode((n) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 29 + 3) & 0xff)));
  it("'activate SKE-… for Aisyah' from a parent → book.activate with the child, not child.*", () => {
    const d = routeByRules(`activate ${formatCode(CODE)} for Aisyah`, parentCtx(PA), NOW);
    expect(d).toEqual({ intent: "act", action: "book.activate", book: { code: CODE, childQuery: "Aisyah" } });
  });
  it("a code inside a child question still goes to book.activate", () => {
    expect(routeByRules(`how is Aisyah doing ${formatCode(CODE)}`, parentCtx(PA), NOW)).toMatchObject({ intent: "act", action: "book.activate", book: { code: CODE } });
    expect(routeByRules(`activate my book for Aisyah`, parentCtx(PA), NOW)).toEqual({ intent: "act", action: "book.activate", book: { childQuery: "Aisyah" } });
  });
  it("with book.activate waiting on 'which child?': a name is the answer, a child question is still child.*", () => {
    const ctx = parentCtx(PA);
    ctx.pending = { task: "book.activate", needs: ["child"] };
    expect(routeByRules("Aisyah", ctx, NOW)).toEqual({ intent: "act", action: "book.activate", book: { childQuery: "Aisyah" } });
    expect(routeByRules("untuk Adam", ctx, NOW)).toEqual({ intent: "act", action: "book.activate", book: { childQuery: "Adam" } });
    expect(routeByRules("how is Aisyah doing", ctx, NOW)).toEqual({ intent: "ask", parent: { capability: "child.status", args: { child: A1 } } });
    expect(routeByRules("Adam's week", ctx, NOW)).toEqual({ intent: "ask", parent: { capability: "child.week", args: { child: A2 } } });
  });
  it("without a code, the parent phrasings stay the parent's", () => {
    expect(routeByRules("how is Aisyah doing", parentCtx(PA), NOW)).toEqual({ intent: "ask", parent: { capability: "child.status", args: { child: A1 } } });
    expect(routeByRules("tell Adam's teacher he was sick yesterday", parentCtx(PA), NOW)).toEqual({ intent: "act", action: "diary.note" });
  });
});

type Shell = { sk: { shell: { parent: Record<string, string> } } };
const FILES: Record<string, Shell> = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, Shell>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("parent-lines.ts ⇄ messages/*.json (sk.shell.parent)", () => {
  it("every line in every locale, equal to the dictionary, placeholders as in English, really translated", () => {
    const locales = LOCALES.map((l) => l.value).sort();
    for (const [key, table] of Object.entries(PARENT_LINE_TABLES)) {
      expect(Object.keys(table).sort(), key).toEqual(locales);
      for (const loc of locales) {
        expect(table[loc], `${key}/${loc}`).toBe(FILES[loc].sk.shell.parent[key]);
        expect(placeholders(table[loc]), `${key}/${loc}`).toEqual(placeholders(table.en));
      }
      // ms-arab is Malay in Jawi: Arabic script, never the Latin Malay copy.
      if (table.ms !== table["ms-arab"]) expect(table["ms-arab"], key).toMatch(/[؀-ۿ]/);
    }
    expect(Object.keys(FILES.en.sk.shell.parent).sort()).toEqual(Object.keys(PARENT_LINE_TABLES).sort());
  });
});
