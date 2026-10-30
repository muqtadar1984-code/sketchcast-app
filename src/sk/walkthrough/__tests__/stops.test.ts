/**
 * SK's walkthrough stops (founder feedback 2026-10-30: "point at the exact
 * control, explain every feature"): every line a stop can say is in all ten
 * message files, and every anchor a stop names really exists in a component
 * (a source scan for each data-tour / data-sk value), so a renamed attribute
 * fails here instead of the tour silently skipping a stop.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/walkthrough/__tests__/stops.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WALK_ROLES, WALK_STOPS, anchorsOf, lineKeysFor, type WalkAnchor, type WalkFacts, type WalkRole } from "../stops";
import { composeParts, planWalk, stripMarks } from "@/sk/shell/client/walkthrough";
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
      for (const a of anchorsOf(d)) {
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
  it("the invitation to upload is said once: the close asks, the setup narration only names Upload", () => {
    const t = en.sk.walkthrough.teacher;
    expect(t.uploadNow).toBe("That's the tour. When you're ready, click here to upload your textbook and I'll turn it into lessons.");
    expect(t.upload).not.toMatch(/click here|when you're ready/i);
    expect(en.sk.walkthrough.parent.uploadNow).toMatch(/^That's the tour\. When you're ready, click here to upload a textbook/);
    // The old long upload explanation (title and author) is gone.
    expect(t.upload).not.toMatch(/title and author/);
  });
  it("the 'once you generate a kit' and 'More' lines say what the code does: free papers, no credit numbers", () => {
    const t = en.sk.walkthrough.teacher;
    expect(t.assignNone).toMatch(/^Once you generate a kit, you'll be able to assign it to a class/);
    expect(t.boardBridge).toBe("Generated kits also run on the classroom Board, which we'll see in a minute.");
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
    // Report a problem: the inline "report" on a failed kit, and the widget's button.
    expect(read("report-failure.tsx")).toMatch(/<button\s+data-tour="report-failure"\s+onClick=\{send\}/);
    expect(read("content-cell.tsx")).toMatch(/lesson\.status === "error"[\s\S]*<ReportFailure/);
    expect(read("report-issue-form.tsx")).toMatch(/<button\s+data-tour="report-issue"\s+onClick=\{\(\) => setOpen/);
  });
});

// Production 2026-10-30: {provider:"plan", why:"missing", error:"/dashboard
// settled"}. The meter renders nothing for an unlimited plan (and when its
// read fails, or without lesson tools), so the plan stop needs a fallback.
describe("the 'plan' stop survives a dashboard with no meter", () => {
  const METER = readFileSync(join(SRC, "app", "dashboard", "fair-use-meter.tsx"), "utf8");
  const DASHBOARD = readFileSync(join(SRC, "app", "dashboard", "page.tsx"), "utf8");
  const plan = WALK_STOPS.teacher.find((s) => s.id === "plan")!;
  it("the meter still carries data-tour=\"fair-use\" on every card it renders, and renders nothing for an unlimited plan", () => {
    const cards = METER.match(/<section[^>]*>/g) ?? [];
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c).toContain('data-tour="fair-use"');
    expect(METER).toMatch(/if \(fu\.unlimited\) return null;/);
    // …and it streams in behind lesson tools on the dashboard (#217).
    expect(DASHBOARD).toMatch(/\{lessonTools && \(\s*<Suspense fallback=\{[^\n]*\}>\s*<FairUseMeter \/>/);
  });
  it("so the stop points at the meter first, then falls back to SK's avatar with its own line", () => {
    expect(plan.route).toBe("/dashboard");
    expect(selOf(plan.anchors[0]!)).toBe('[data-tour="fair-use"]');
    const last = plan.anchors[plan.anchors.length - 1]!;
    expect(last).toEqual({ sel: '[data-sk="avatar"]', line: "planUnlimited" });
    expect(rendered("data-sk", "avatar")).toBe(true);
  });
  it("the fallback line is in all ten files and promises no number", () => {
    for (const [code, file] of Object.entries(FILES)) {
      const line = (file.sk.walkthrough.teacher as Record<string, string>).planUnlimited;
      expect(line, code).toBeTruthy();
      expect(line, code).not.toMatch(/[0-9]/);
    }
  });
});

// Founder 2026-10-30: steps 3–6 and 14–16 are one narration each. The parts'
// lines are spoken as ONE line and the highlight moves on sentence starts, so
// every part's line must end a sentence, in every language.
describe("combined stops: every part's line ends a sentence, in all ten files", () => {
  it("teacher openBook and setup carry their parts", () => {
    const t = WALK_STOPS.teacher;
    expect(t.find((s) => s.id === "openBook")?.parts?.map((p) => p.id)).toEqual(["bookCard", "generateAll", "chapterKit", "lessonOptions"]);
    expect(t.find((s) => s.id === "setup")?.parts?.map((p) => p.id)).toEqual(["upload", "classes", "branding"]);
    for (const id of ["bookCard", "generateAll", "chapterKit", "lessonOptions", "upload", "classes", "branding"]) expect(t.find((s) => s.id === id), id).toBeUndefined();
  });
  it("each part line (own, fallback, per-anchor) ends with sentence punctuation", () => {
    for (const role of WALK_ROLES) {
      for (const s of WALK_STOPS[role]) {
        for (const p of s.parts ?? []) {
          const keys = new Set<string>([p.line ?? p.id, ...(p.fallback ?? []).flatMap((f) => (f.line ? [f.line] : [])), ...anchorsOf(p).flatMap((a) => (typeof a === "string" ? [] : [a.line]))]);
          for (const [code, file] of Object.entries(FILES)) {
            for (const k of keys) {
              const line = (file.sk.walkthrough[role] as Record<string, string>)[k]!;
              expect(line, `${code} ${role}.${k}`).toMatch(/[.!?؟।]["'”’»)]*$/u);
            }
          }
        }
      }
    }
  });
});

// The report stop's fact is the widget's own flag: where it renders, and the
// facts route reporting it.
describe("Report a problem: the stop follows the widget's flag", () => {
  const DASHBOARD = readFileSync(join(SRC, "app", "dashboard", "page.tsx"), "utf8");
  const SCHOOL = readFileSync(join(SRC, "app", "dashboard", "school", "page.tsx"), "utf8");
  const ROUTE = readFileSync(join(SRC, "app", "api", "sk", "walkthrough", "route.ts"), "utf8");
  it("the widget renders on the student, teacher/parent and School dashboards under platformConsoleEnabled()", () => {
    expect(DASHBOARD).toContain('{platformConsoleEnabled() && <ReportIssueWidget variant="student" />}');
    expect(DASHBOARD).toContain("{platformConsoleEnabled() && <ReportIssueWidget />}");
    expect(SCHOOL).toContain("{platformConsoleEnabled() && <ReportIssueWidget />}");
  });
  it("the facts route reports it for every role, and every role's report stop needs it", () => {
    expect(ROUTE).toContain("reportIssue: platformConsoleEnabled()");
    for (const role of WALK_ROLES) {
      const s = WALK_STOPS[role].find((d) => d.id === "reportProblem");
      expect(s?.needs, role).toEqual(["reportIssue"]);
    }
  });
});

// Founder decision 2026-10-30: lesson videos play our STORED MP4 everywhere
// (Board, Library, kits, SK); YouTube is only a fallback. No tour line names it.
describe("no tour line claims YouTube playback", () => {
  it("in any of the ten files", () => {
    for (const [code, file] of Object.entries(FILES)) expect(JSON.stringify(file.sk.walkthrough), code).not.toMatch(/youtube|يوتيوب|यूट्यूब|యూట్యూబ్/i);
    expect(en.sk.walkthrough.teacher.boardSk).toContain("I'm on the Board too");
  });
});

// 2026-10-31 (founder: "combine the complete explanation into 1 or no more
// than 3 sentences and avoid repetitions"): a combined stop's precomposed line
// carries `{part}` markers where the highlight moves; its parts' lines are
// short clauses the app composes when a part is missing.
describe("combined stops: the precomposed line and its part markers, in all ten files", () => {
  const MARK = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
  const END = /[.!?؟।]["'”’»)]*$/u;
  const sentences = (t: string) => t.split(/(?<=[.!?؟।])\s+/).filter(Boolean);
  const combined = WALK_ROLES.flatMap((role) => WALK_STOPS[role].filter((s) => s.parts?.length).map((s) => ({ role, s })));
  it("there are combined stops to check", () => {
    expect(combined.map(({ s }) => s.id)).toEqual(["openBook", "kit", "setup", "classBoard", "readyMade", "insights", "bellLanguage", "skHelp"]);
  });
  it("each precomposed line: every later part's marker once, in order, nothing else; 1–2 sentences that end cleanly", () => {
    for (const { role, s } of combined) {
      const want = s.parts!.slice(1).map((p) => p.id);
      for (const [code, file] of Object.entries(FILES)) {
        const line = (file.sk.walkthrough[role] as Record<string, string>)[s.line ?? s.id]!;
        const where = `${code} ${role}.${s.line ?? s.id}`;
        expect([...line.matchAll(MARK)].map((m) => m[1]), where).toEqual(want);
        const clean = stripMarks(line);
        expect(clean, where).not.toMatch(/[{}]/);
        expect(clean, where).toMatch(END);
        expect(sentences(clean).length, where).toBeLessThanOrEqual(2);
      }
    }
  });
  it("no other line carries a marker (they would be spoken)", () => {
    const wholes = new Set(combined.map(({ role, s }) => `${role}.${s.line ?? s.id}`));
    for (const [code, file] of Object.entries(FILES)) {
      for (const role of WALK_ROLES) {
        for (const [k, line] of Object.entries(file.sk.walkthrough[role] as Record<string, string>)) {
          if (!wholes.has(`${role}.${k}`)) expect(line, `${code} ${role}.${k}`).not.toMatch(/\{[A-Za-z]/);
        }
      }
    }
  });
  it("composed from its parts' clauses (a part missing) it stays within 3 sentences, with no lead-in said twice", () => {
    for (const { role, s } of combined) {
      // Every clause each part can say: its own line and its fallback lines.
      const options = s.parts!.map((p) => [p.line ?? p.id, ...(p.fallback ?? []).flatMap((f) => (f.line ? [f.line] : [])), ...anchorsOf(p).flatMap((a) => (typeof a === "string" ? [] : [a.line]))]);
      for (const [code, file] of Object.entries(FILES)) {
        const words = (k: string) => (file.sk.walkthrough[role] as Record<string, string>)[k]!;
        const join = file.sk.walkthrough.ui.partJoin;
        // Each part's first option, then each part's fallback swapped in, then each part dropped.
        const firsts = options.map((o) => o[0]!);
        const variants: string[][] = [firsts, ...options.flatMap((o, i) => o.slice(1).map((alt) => firsts.map((f, j) => (j === i ? alt : f))))];
        for (let drop = 0; drop < firsts.length; drop++) variants.push(firsts.filter((_, j) => j !== drop));
        for (const v of variants) {
          const line = stripMarks(composeParts(v.map(words), v, join));
          expect(sentences(line).length, `${code} ${role}.${s.id} [${v}]`).toBeLessThanOrEqual(3);
          if (code === "en") {
            const leads = v.map((k) => words(k).split(/\s+/).slice(0, 2).join(" ").toLowerCase());
            expect(new Set(leads).size, `en ${s.id} [${v}] lead-ins ${leads}`).toBe(leads.length);
          }
        }
      }
    }
  });
  it("English: the combined lines repeat no phrase ('you can… you can…', 'here… here…')", () => {
    for (const { role, s } of combined) {
      const line = stripMarks((en.sk.walkthrough[role] as Record<string, string>)[s.line ?? s.id]!).toLowerCase();
      for (const phrase of ["you can", "here", "it uses credits", "in one go"]) expect(line.split(phrase).length - 1, `${s.id}: ${phrase}`).toBeLessThanOrEqual(1);
    }
  });
});

// 2026-10-31 (founder: "the tour is approx 6 to 7 minutes right now. need to
// bring it down to less than 4 minutes"). The spoken length of the whole tour
// per role, everything on: English words at ~2.6 words a second; the other
// languages scaled from English by their character count. The teacher's
// speech must stay under 210 s (≈30 s more for moving between stops).
describe("the whole tour's spoken length", () => {
  const WORDS_PER_SEC = 2.6;
  const ALL: Record<string, WalkFacts> = {
    teacher: { books: true, bookId: "b1", classId: "c1", catalogue: true, exam: true, diary: true, timetable: true, calendar: true, board: true, skTutor: true, reportIssue: true },
    student: { diary: true, tutorPath: "/sk/bio/1", reportIssue: true },
    parent: { children: 2, verifiedChildren: 2, schoolParent: true, diary: true, calendar: true, parentPortal: true, reportIssue: true },
    principal: { analytics: true, timetable: true, diary: true, notices: true, roleHats: true, reportIssue: true },
    coordinator: { timetable: true, diary: true, notices: true, reportIssue: true },
  };
  /** What SK says over the whole tour (every part present). */
  const spoken = (file: (typeof FILES)[keyof typeof FILES], role: WalkRole) => {
    const t = file.sk.walkthrough[role] as Record<string, string>;
    return planWalk(role, ALL[role]!)
      .map((s) => (s.parts?.length ? stripMarks(s.whole ? t[s.whole]! : composeParts(s.parts.map((p) => t[p.line]!), s.parts.map((p) => p.id), file.sk.walkthrough.ui.partJoin)) : t[s.line]!))
      .join(" ");
  };
  const estimate = (role: WalkRole) => {
    const enText = spoken(en, role);
    const enSec = enText.split(/\s+/).filter(Boolean).length / WORDS_PER_SEC;
    const out: Record<string, number> = {};
    for (const [code, file] of Object.entries(FILES)) out[code] = Math.round((enSec * [...spoken(file, role)].length) / [...enText].length);
    return { stops: planWalk(role, ALL[role]!).length, sec: out };
  };
  it("the teacher's tour is under 210 s of speech in English, and every role and language under 240 s", () => {
    const report: string[] = [];
    for (const role of WALK_ROLES) {
      const e = estimate(role);
      report.push(`${role} (${e.stops} stops): ${Object.entries(e.sec).map(([c, v]) => `${c} ${v}s`).join(", ")}`);
      for (const [code, v] of Object.entries(e.sec)) expect(v, `${code} ${role}`).toBeLessThan(240);
    }
    // TOUR_LENGTH_REPORT=<file>: write the estimates out (for the script doc).
    if (process.env.TOUR_LENGTH_REPORT) writeFileSync(process.env.TOUR_LENGTH_REPORT, report.join("\n"));
    expect(estimate("teacher").sec.en).toBeLessThan(210);
    expect(estimate("teacher").stops).toBeLessThanOrEqual(22);
  });
  it("one short sentence per stop: no single line over ~22 English words (a combined line ~45)", () => {
    const wholes = new Set(WALK_ROLES.flatMap((r) => WALK_STOPS[r].filter((s) => s.parts?.length).map((s) => `${r}.${s.line ?? s.id}`)));
    for (const role of WALK_ROLES) {
      for (const [k, line] of Object.entries(en.sk.walkthrough[role] as Record<string, string>)) {
        const n = stripMarks(line).split(/\s+/).length;
        expect(n, `${role}.${k}: ${n} words`).toBeLessThanOrEqual(wholes.has(`${role}.${k}`) ? 45 : 22);
      }
    }
  });
});
