/**
 * SK's first-login walkthrough — the browser half (founder 2026-10-30):
 * the static Example card (never a request, never a token), the docked bar
 * (non-modal, with Pause / Back / Next / Skip and the text box), the strip in
 * the hero, TourProvider standing down for SK users, and the version bump.
 * Server-rendered with react-dom/server (no DOM in this suite) plus source
 * pins for the wiring no render can see.
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/sk-walkthrough.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import en from "@/i18n/messages/en.json";
import ar from "@/i18n/messages/ar.json";
import { startWalk, pauseWalk, planWalk } from "@/sk/shell/client/walkthrough";
import { driverTourMode, shouldAutoStart } from "@/tour/logic";
import { SK_INTRO_TOUR } from "@/sk/shell/tour";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, prefetch: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => "/dashboard/kits",
}));

const read = (f: string) => readFileSync(resolve(__dirname, "..", f), "utf8");
const readSrc = (f: string) => readFileSync(resolve(__dirname, "..", "..", "..", f), "utf8");

const noop = () => {};
/** renderToStaticMarkup escapes quotes and apostrophes. */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Code only: comments may name what the code must not do. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const teacherWalk = () => startWalk("teacher", planWalk("teacher", { books: true, classId: "c1", catalogue: true, exam: true, diary: true, timetable: true, board: true }), { record: true, runId: "r" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WalkExampleCard: a static demo of an action card", () => {
  it("renders the example with a disabled 'Example' button, and never calls fetch", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network in a demo")));
    vi.stubGlobal("fetch", fetchSpy);
    const { WalkExampleCard } = await import("../sk-walkthrough");
    for (const demo of ["lessonPrepare", "assign", "markingGrade", "diaryNote", "diaryParent", "bookActivate", "bookActivateChild", "noticeSchool"] as const) {
      const html = renderToStaticMarkup(createElement(WalkExampleCard, { demo, copy: en.sk.walkthrough }));
      expect(html).toContain(`data-sk-demo="${demo}"`);
      expect(html).toContain(en.sk.walkthrough.demo[demo].title);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-sk="walk-example-confirm"[^>]*>Example<\/button>/);
      expect(html).toContain(en.sk.walkthrough.ui.exampleNote);
      // Never the real card's hooks (they carry a token back to /api/sk/act).
      expect(html).not.toContain('data-sk="confirm-card"');
      expect(html).not.toContain('data-sk="confirm-yes"');
    }
    // Click-only actions say so, like the real card.
    expect(renderToStaticMarkup(createElement(WalkExampleCard, { demo: "lessonPrepare", copy: en.sk.walkthrough }))).toContain(en.sk.walkthrough.ui.needsClick);
    expect(renderToStaticMarkup(createElement(WalkExampleCard, { demo: "assign", copy: en.sk.walkthrough }))).not.toContain(en.sk.walkthrough.ui.needsClick);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("the walkthrough module never posts to /api/sk/act nor mints a token; its only write is the seen row", () => {
    const src = code(read("sk-walkthrough.tsx"));
    expect(src).not.toContain("/api/sk/act");
    expect(src).not.toContain("/api/sk/shell/turn");
    expect(src).not.toMatch(/token/i);
    // The fetches it makes: the facts (GET) and the seen row.
    expect(src.match(/(?<![.\w])fetch\(/g)?.length).toBe(2);
    expect(src).toContain('fetch("/api/sk/walkthrough", { cache: "no-store" })');
    expect(src).toContain('fetch("/api/tour/seen"');
  });
  it("splits rows on the first ': ' (a time like 17:00 stays whole)", async () => {
    const { exampleRows } = await import("../sk-walkthrough");
    expect(exampleRows("Due: Friday, 17:00\nClass: 5A")).toEqual([
      ["Due", "Friday, 17:00"],
      ["Class", "5A"],
    ]);
  });
});

describe("WalkStrip: caption, sound chip, chips, controls", () => {
  it("shows the stop's caption, 'Tap for sound' until a gesture, and Pause / Back / Next / Skip with the progress", async () => {
    const { WalkStrip } = await import("../sk-walkthrough");
    const walk = teacherWalk();
    const html = renderToStaticMarkup(
      createElement(WalkStrip, { mode: "hero", copy: en.sk.walkthrough, walk, line: en.sk.walkthrough.teacher.hello, soundOn: false, onSound: noop, onPause: noop, onResume: noop, onBack: noop, onNext: noop, onSkip: noop, onJump: noop, onChip: noop }),
    );
    expect(html).toContain('data-sk="caption"');
    expect(html).toContain(esc(en.sk.walkthrough.teacher.hello));
    expect(html).toContain('data-sk="walk-sound"');
    for (const c of ["walk-pause", "walk-back", "walk-next", "walk-skip", "walk-progress", "walk-dots"]) expect(html).toContain(`data-sk="${c}"`);
    expect(html).toContain("1 of 14");
    // Back is disabled at the first stop.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-sk="walk-back"/);
  });
  it("paused by a question: Resume and 'Continue the tour'; sample chips are buttons that only fill the box", async () => {
    const { WalkStrip } = await import("../sk-walkthrough");
    let w = teacherWalk();
    w = { ...w, index: w.stops.findIndex((s) => s.id === "analytics") };
    w = pauseWalk(w, "question");
    const html = renderToStaticMarkup(
      createElement(WalkStrip, { mode: "dock", copy: en.sk.walkthrough, walk: w, line: "x", soundOn: true, look: "A", onSound: noop, onPause: noop, onResume: noop, onBack: noop, onNext: noop, onSkip: noop, onJump: noop, onChip: noop }),
    );
    expect(html).toContain('data-sk="walk-continue"');
    expect(html).toContain(en.sk.walkthrough.ui.continueTour);
    expect(html).toContain('data-sk="walk-resume"');
    expect(html).not.toContain('data-sk="walk-sound"');
    expect(html).toContain(en.sk.walkthrough.chips.howAreMyClasses);
    expect(html).toContain('data-sk="walk-portrait"');
    expect(html).toContain("/sk/portrait/sk-a.webp");
    // The chips never send: the handler only hands the words to the Shell's box.
    const src = read("sk-walkthrough.tsx");
    expect(src).toContain("onChip={(text) => setFill({ key: uid(), text })}");
    expect(read("sk-shell.tsx")).toMatch(/const f = walkRef\.current\?\.fill;\s*if \(!f\) return;\s*setInput\(f\.text\);/);
  });
  it("Arabic: the controls flip their arrows and use logical spacing (RTL)", async () => {
    const { WalkStrip } = await import("../sk-walkthrough");
    const html = renderToStaticMarkup(
      createElement(WalkStrip, { mode: "dock", copy: ar.sk.walkthrough, walk: teacherWalk(), line: ar.sk.walkthrough.teacher.hello, soundOn: false, onSound: noop, onPause: noop, onResume: noop, onBack: noop, onNext: noop, onSkip: noop, onJump: noop, onChip: noop }),
    );
    expect(html).toContain("rtl:rotate-180");
    expect(html).toContain("ms-auto");
    expect(html).not.toMatch(/\b(?:ml|mr|pl|pr)-\d/);
  });
});

describe("the docked bar: the Shell's dock variant", () => {
  it("is non-modal (no backdrop, no dialog), docked at the bottom, phone-width, with the tour controls and the text box", async () => {
    vi.resetModules();
    const { default: SkShell } = await import("../sk-shell");
    const { WalkStrip } = await import("../sk-walkthrough");
    const walk = teacherWalk();
    const strip = createElement(WalkStrip, { mode: "dock", copy: en.sk.walkthrough, walk, line: en.sk.walkthrough.teacher.kits, soundOn: false, look: "B", onSound: noop, onPause: noop, onResume: noop, onBack: noop, onNext: noop, onSkip: noop, onJump: noop, onChip: noop });
    const html = renderToStaticMarkup(
      createElement(SkShell, { variant: "dock", copy: en.sk.shell, role: "teacher", hat: null, walk: { strip, voice: null, fill: null, showAnswers: false, command: () => false } }),
    );
    expect(html).toContain('data-sk="dock"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("bg-black/40");
    expect(html).toContain("fixed inset-x-0 bottom-0");
    expect(html).toContain("w-full max-w-xl");
    for (const c of ["walk-pause", "walk-back", "walk-next", "walk-skip", "walk-portrait", "caption", "input"]) expect(html).toContain(`data-sk="${c}"`);
    expect(html).toContain(esc(en.sk.walkthrough.teacher.kits));
    // The conversation stays out of the way until she asks something.
    expect(html).toMatch(/class="hidden" data-sk="transcript"/);
  });
  it("the hero carries the tour inside the card instead of its greeting; the panel and hero offer 'Take the tour'", async () => {
    vi.resetModules();
    const { default: SkShell } = await import("../sk-shell");
    const strip = createElement("div", { "data-sk": "walk" }, "tour strip");
    const hero = renderToStaticMarkup(createElement(SkShell, { variant: "hero", copy: en.sk.shell, role: "teacher", hat: null, walk: { strip, voice: null, fill: null, showAnswers: false, command: () => false } }));
    expect(hero).toContain("tour strip");
    expect(hero).not.toContain('data-sk="hero-greeting"');
    const idle = renderToStaticMarkup(createElement(SkShell, { variant: "hero", copy: en.sk.shell, role: "teacher", hat: null, onTakeTour: noop, takeTourLabel: "Take the tour" }));
    expect(idle).toContain('data-sk="take-tour"');
    const panel = renderToStaticMarkup(createElement(SkShell, { copy: en.sk.shell, role: "teacher", hat: null, onClose: noop, onTakeTour: noop, takeTourLabel: "Take the tour" }));
    expect(panel).toContain('data-sk="take-tour"');
    // Not while a tour runs.
    expect(hero).not.toContain('data-sk="take-tour"');
  });
});

describe("the launcher's wiring (source pins)", () => {
  const src = read("sk-launcher.tsx");
  it("one Shell: hero on a landing page, the dock elsewhere while a tour runs, else the panel", () => {
    expect(src).toContain('variant={heroHere ? "hero" : docked ? "dock" : "panel"}');
    expect(src.match(/<SkShell\b/g)?.length).toBe(1);
  });
  it("the dock works on the leaders' School pages (the floating launcher stays hidden there)", () => {
    expect(src).toContain("if (hiddenHere && !heroHere && !tourActive) return null;");
  });
  it("auto-starts only from the home hero, only while the intro is due, and records only that run", () => {
    expect(src).toMatch(/if \(!SK_ON \|\| autoTried \|\| !introPending \|\| !heroHere \|\| tourActive\) return;/);
    expect(src).toContain("if (!carried) start({ record: true });");
    // Replays (the 🧭, the links, "Show me around") start without record.
    expect(src).toContain("useEffect(() => onSkWalkthroughRequest(() => start()), [start]);");
  });
  it("a question mid-tour pauses it; SK answers through the normal turn", () => {
    expect(src).toContain("tour.onQuestion();");
    expect(read("sk-shell.tsx")).toMatch(/if \(walkRef\.current\?\.command\(q\)\) \{/);
  });
  it("the /present and /sk launchers carry the tour's words (a run resumes there)", () => {
    expect(readSrc("app/present/present-client.tsx")).toContain("walkCopy={sk.walkCopy}");
    expect(readSrc("app/sk/layout.tsx")).toContain("walkCopy={t.sk.walkthrough}");
  });
  it("navigation is the client router (never a full reload), with EVERY page of the plan prefetched when the run starts", () => {
    const w = read("sk-walkthrough.tsx");
    expect(w).toContain("router.push(s.route);");
    expect(w).toContain("for (const route of new Set(w.stops.map((s) => s.route))) {");
    expect(w).toContain("router.prefetch(route);");
    expect(w).not.toMatch(/window\.location\.(?:href|assign|replace)\s*[=(]/);
  });
});

// 2026-10-30 (founder: "SK is proceeding without waiting for the page to
// complete loading" — the teacher tour started at "1 of 10" on "output").
describe("strict sequence: navigate → settle → highlight → the whole line → only then next (source pins)", () => {
  const w = code(read("sk-walkthrough.tsx")).replace(/\r\n/g, "\n");
  const stopEffect = w.slice(w.indexOf("const goKey = goKeyOf(walk);"), w.indexOf("const onVoiceDone = useCallback("));
  it("no fixed clock: the anchor waits for a SETTLED page (route, loaded, no loading UI, quiet), capped", () => {
    expect(w).not.toContain("waitForAnchor(");
    expect(stopEffect).toContain("await waitForSettledAnchor<");
    expect(stopEffect).toContain("probe: settleProbe(target),");
    expect(w).toContain("ready: () => document.readyState === \"complete\",");
    expect(w).toMatch(/\[aria-busy="true"\], \[data-loading\]:not\(\[data-loading="false"\]\), \[data-sk-loading\], \.animate-pulse/);
    // The route loading.tsx fallbacks carry the attribute the probe keys on.
    expect(readSrc("components/loading/loading-screen.tsx")).toContain("data-sk-loading");
  });
  it("in order: settle → scroll into view → the scroll has finished → highlight → only THEN the line", () => {
    const order = ["await waitForSettledAnchor<", "el.scrollIntoView(", "await waitForStableRect(", "setMatch(m);", "speakStop(goKey, entry, text)"].map((s) => stopEffect.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("the tour does not START before the home page has settled", () => {
    const start = w.slice(w.indexOf("const start = useCallback("), w.indexOf("const goKey = goKeyOf(walk);"));
    expect(start.indexOf("await waitForSettledPage(")).toBeGreaterThan(0);
    expect(start.indexOf("await waitForSettledPage(")).toBeLessThan(start.indexOf("setWalk(startWalk("));
  });
  it("auto-advance only after the line was FULLY spoken (or the reading time without sound), cancelled by a pause, a question or her typing", () => {
    expect(w).toContain("const ms = advanceDelay({ status: w.status, soundOn: true, outcome, text: sp.text });");
    expect(w).toMatch(/if \(advance\.entry !== entryRef\.current \|\| heldRef\.current === advance\.entry\) return;/);
    for (const name of ["const onQuestion = useCallback(", "const hold = useCallback(", "pause: () => {"]) {
      const body = w.slice(w.indexOf(name), w.indexOf(name) + 260);
      expect(body).toContain("setAdvance(null);");
    }
    const shell = code(read("sk-shell.tsx"));
    expect(shell).toContain("void coord.sayLine(v.text).then(report);");
    expect(shell).toContain("walkRef.current?.hold?.();");
  });
  it("the caption shows WITH the highlight, not before the page has settled", () => {
    expect(w).toContain('const shown = walk?.status === "paused" || (!!match && match.key === goKey);');
  });
});

describe("TourProvider stands down for SK users (founder decision 1)", () => {
  it("driverTourMode: no auto-start and the replay goes to SK for an SK user; unchanged for everyone else", () => {
    expect(driverTourMode({ flagOn: true, hasTour: true, skWalkthrough: true })).toEqual({ available: true, autoStart: false, replayVia: "sk" });
    expect(driverTourMode({ flagOn: false, hasTour: false, skWalkthrough: true })).toEqual({ available: true, autoStart: false, replayVia: "sk" });
    expect(driverTourMode({ flagOn: true, hasTour: true, skWalkthrough: false })).toEqual({ available: true, autoStart: true, replayVia: "driver" });
    expect(driverTourMode({ flagOn: false, hasTour: true, skWalkthrough: false })).toEqual({ available: false, autoStart: false, replayVia: "driver" });
  });
  it("the provider uses it, and the dashboard layout hands it the SK gate", () => {
    const tp = readSrc("tour/TourProvider.tsx");
    expect(tp).toContain("const mode = driverTourMode({ flagOn: TOUR_ON, hasTour: !!def, skWalkthrough });");
    expect(tp).toContain("if (!mode.autoStart || !def || pathname !== def.homePath) return;");
    expect(tp).toMatch(/if \(mode\.replayVia === "sk"\) \{\s*requestSkWalkthrough\(\);/);
    expect(read("layout.tsx")).toContain("<TourProvider role={role} seen={seen} copy={t.app.tour} skWalkthrough={skOn}>");
  });
});

describe("the version bump (founder decision 9)", () => {
  it("sk-intro is v2, so everyone who heard v1 gets the walkthrough once — and only once", () => {
    expect(SK_INTRO_TOUR).toEqual({ key: "sk-intro", version: 2 });
    expect(shouldAutoStart({ version: 1, status: "completed" }, SK_INTRO_TOUR.version)).toBe(true);
    expect(shouldAutoStart({ version: 2, status: "skipped" }, SK_INTRO_TOUR.version)).toBe(false);
    // The layout decides introDue from the same key and version.
    expect(read("layout.tsx")).toContain("skIntroDue = shouldAutoStart(skSeen, SK_INTRO_TOUR.version);");
    // The run posts that pair.
    expect(read("sk-walkthrough.tsx")).toContain("JSON.stringify({ tourKey: SK_INTRO_TOUR.key, version: SK_INTRO_TOUR.version, status })");
  });
});
