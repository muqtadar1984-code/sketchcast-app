/**
 * SK's first-login walkthrough — the browser half (founder 2026-10-30):
 * the static Example card (never a request, never a token), the tour INSIDE
 * SK's speech bubble beside the corner avatar (caption, "Tap for sound",
 * compact Pause / Back / Next / Skip and "n of N"; the Example card and chips
 * above; SK's answer to a question mid-tour with "Continue the tour"),
 * TourProvider standing down for SK users, and the version bump.
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
    expect(src).toContain('fetch("/api/sk/walkthrough", { cache: "no-store", signal })');
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

describe("WalkStrip: the tour inside the speech bubble", () => {
  const strip = async (props: Record<string, unknown>) => {
    const { WalkStrip } = await import("../sk-walkthrough");
    return renderToStaticMarkup(
      createElement(WalkStrip, { copy: en.sk.walkthrough, walk: teacherWalk(), line: en.sk.walkthrough.teacher.hello, soundOn: false, onSound: noop, onPause: noop, onResume: noop, onBack: noop, onNext: noop, onSkip: noop, onChip: noop, ...props } as Parameters<typeof WalkStrip>[0]),
    );
  };
  it("the caption, 'Tap for sound' as a chip until a gesture, and compact Pause / Back / Next / Skip with 'n of N'", async () => {
    const html = await strip({});
    expect(html).toContain('data-sk-walk-mode="bubble"');
    expect(html).toContain('data-sk="caption"');
    expect(html).toContain(esc(en.sk.walkthrough.teacher.hello));
    expect(html).toMatch(/class="inline-flex items-center gap-1 rounded-full[^"]*"[^>]*data-sk="walk-sound"/);
    for (const c of ["walk-pause", "walk-back", "walk-next", "walk-skip", "walk-progress"]) expect(html).toContain(`data-sk="${c}"`);
    expect(html).toContain(`1 of ${teacherWalk().stops.length}`);
    expect(teacherWalk().stops.length).toBeLessThanOrEqual(22);
    // Back is disabled at the first stop; compact: an arrow with its label for screen readers.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-sk="walk-back" aria-label="Back"/);
    // Compact: no portrait and no progress dots any more (the avatar is beside the bubble).
    expect(html).not.toContain('data-sk="walk-portrait"');
    expect(html).not.toContain('data-sk="walk-dots"');
    // The caption keeps to four lines, scrolling past them.
    expect(html).toContain("max-h-20 overflow-y-auto");
  });
  it("while a start is under way: 'Starting the tour…' and Skip, at once (2026-10-31)", async () => {
    const { WalkStarting } = await import("../sk-walkthrough");
    const html = renderToStaticMarkup(createElement(WalkStarting, { copy: en.sk.walkthrough, onSkip: noop }));
    expect(html).toContain('data-sk-walk-status="starting"');
    expect(html).toContain("Starting the tour…");
    expect(html).toContain('data-sk="walk-skip"');
  });
  it("the Example card and the sample chips open ABOVE the caption; chips only fill a box", async () => {
    let w = teacherWalk();
    w = { ...w, index: w.stops.findIndex((s) => s.id === "insights") };
    const html = await strip({ walk: w, soundOn: true });
    expect(html).toContain(en.sk.walkthrough.chips.howAreMyClasses);
    expect(html.indexOf('data-sk="walk-chips"')).toBeLessThan(html.indexOf('data-sk="caption"'));
    const demoStop = teacherWalk().stops.findIndex((s) => !!s.demo);
    const demo = await strip({ walk: { ...teacherWalk(), index: demoStop }, soundOn: true });
    expect(demo.indexOf('data-sk="walk-example"')).toBeGreaterThan(-1);
    expect(demo.indexOf('data-sk="walk-example"')).toBeLessThan(demo.indexOf('data-sk="caption"'));
    expect(read("sk-walkthrough.tsx")).toContain("onChip={(text) => setFill({ key: uid(), text })}");
    // A tapped chip lands in a box she can see: the sheet's, else the one-line box.
    const shell = read("sk-shell.tsx").replace(/\r\n/g, "\n");
    expect(shell).toMatch(/const f = walkRef\.current\?\.fill;\s*if \(!f\) return;\s*setInput\(f\.text\);/);
    expect(shell).toContain("if (!sheetOpenRef.current) setQuickOpen(true);");
  });
  it("a question mid-tour: SK's answer in the bubble instead of the caption, with 'Continue the tour' and Resume", async () => {
    let w = teacherWalk();
    w = pauseWalk(w, "question");
    const html = await strip({ walk: w, soundOn: true, answer: "Your classes are 7A and 7B." });
    expect(html).toContain("Your classes are 7A and 7B.");
    expect(html).toContain('data-sk-answer="true"');
    expect(html).not.toContain(esc(en.sk.walkthrough.teacher.hello));
    expect(html).toContain('data-sk="walk-continue"');
    expect(html).toContain(en.sk.walkthrough.ui.continueTour);
    expect(html).toContain('data-sk="walk-resume"');
    expect(html).not.toContain('data-sk="walk-sound"');
    // The Shell hands the answer over only while the tour is paused by her question.
    expect(code(read("sk-shell.tsx"))).toContain('const tourAnswer = walk?.showAnswers && openMsg && openMsg.kind !== "greeting" && openMsg.kind !== "confirm" ? openMsg.text : null;');
  });
  it("Arabic: the controls flip their arrows and use logical spacing (RTL)", async () => {
    const { WalkStrip } = await import("../sk-walkthrough");
    const html = renderToStaticMarkup(
      createElement(WalkStrip, { copy: ar.sk.walkthrough, walk: teacherWalk(), line: ar.sk.walkthrough.teacher.hello, soundOn: false, onSound: noop, onPause: noop, onResume: noop, onBack: noop, onNext: noop, onSkip: noop, onChip: noop }),
    );
    expect(html).toContain("rtl:rotate-180");
    expect(html).toContain("ms-auto");
    expect(html).not.toMatch(/\b(?:ml|mr|pl|pr)-\d/);
  });
});

describe("the tour in the Shell: the bubble, pinned open, non-modal", () => {
  it("no dock, no dialog, no backdrop: the corner with the tour in its bubble, above the spotlight", async () => {
    vi.resetModules();
    const { default: SkShell } = await import("../sk-shell");
    const { WalkStrip } = await import("../sk-walkthrough");
    const walk = teacherWalk();
    const strip = (answer?: string | null) =>
      createElement(WalkStrip, { copy: en.sk.walkthrough, walk, line: en.sk.walkthrough.teacher.kits, answer, soundOn: false, onSound: noop, onPause: noop, onResume: noop, onBack: noop, onNext: noop, onSkip: noop, onChip: noop });
    const html = renderToStaticMarkup(createElement(SkShell, { copy: en.sk.shell, role: "teacher", hat: null, walk: { strip, voice: null, fill: null, showAnswers: false, command: () => false } }));
    expect(html).not.toContain('data-sk="dock"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("bg-black/40");
    expect(html).toMatch(/data-sk="bubble" data-sk-kind="tour" data-sk-open="true"/);
    for (const c of ["walk-pause", "walk-back", "walk-next", "walk-skip", "caption", "avatar"]) expect(html).toContain(`data-sk="${c}"`);
    expect(html).toContain(esc(en.sk.walkthrough.teacher.kits));
    // The bubble is wider for the controls, still within the phone limit.
    expect(html).toContain("w-[min(340px,calc(100vw-88px))]");
    // z-[48]: above the spotlight's dim (z-[46]).
    expect(html).toContain("z-[48]");
    expect(read("sk-walkthrough.tsx")).toContain('className="pointer-events-none fixed inset-0 z-[46]"');
    // The conversation stays hidden unless she opens it.
    expect(html).not.toContain('data-sk="transcript"');
  });
  it("the tour never fades: bubble.ts pins it while a tour runs", () => {
    const shell = code(read("sk-shell.tsx"));
    expect(shell).toContain("const isBubbleOpen = bubbleOpen(bubble, { tour: tourOn });");
    expect(shell).toContain("const tourOn = !!walk;");
  });
  it("'Take the tour' is in the avatar's menu, never while a tour runs", () => {
    const shell = code(read("sk-shell.tsx"));
    expect(shell).toContain("...(onTakeTour && takeTourLabel && !walk");
    expect(shell).toContain('id: "tour",');
  });
  it("the settle probe ignores SK's own corner (its pulse and fades are not the page loading)", () => {
    expect(read("sk-walkthrough.tsx")).toContain(`const SK_UI = '[data-sk="launcher"], [data-sk="shell"], [data-sk="walk-spotlight"]';`);
  });
});

describe("the launcher's wiring (source pins)", () => {
  const src = read("sk-launcher.tsx").replace(/\r\n/g, "\n");
  it("one Shell, the tour handed to it while it runs", () => {
    expect(src.match(/<SkShell\b/g)?.length).toBe(1);
    expect(src).toContain("strip: tour.strip,");
    expect(src).toContain('narrating: tour.walk?.status === "running",');
  });
  it("SK and its tour work on the leaders' School pages (raised above the briefing bot)", () => {
    expect(src).toContain("raised={school}");
    expect(src).not.toContain('pathname?.startsWith("/dashboard/school") || ');
  });
  it("auto-starts only from a home page, only while the intro is due, and records only that run", () => {
    expect(src).toMatch(/if \(!SK_ON \|\| autoTried \|\| !introPending \|\| !home \|\| tourActive\) return;/);
    expect(src).toContain("if (!carried) start({ record: true });");
    // Replays (the 🧭, the menu, "Show me around") start without record.
    expect(src).toContain("useEffect(() => onSkWalkthroughRequest(() => start()), [start]);");
    expect(src).toContain("onTakeTour={() => start()}");
  });
  it("a question mid-tour pauses it; SK answers through the normal turn", () => {
    expect(src).toContain("onEngaged={tour.onQuestion}");
    expect(read("sk-shell.tsx")).toMatch(/if \(walkRef\.current\?\.command\(q\)\) \{/);
  });
  it("'continue the tour' with no tour running starts one, with no turn (founder 2026-10-30)", () => {
    expect(code(read("sk-shell.tsx"))).toMatch(/if \(!walkRef\.current && onTakeTourRef\.current && walkStartCommand\(q\)\) \{\s*setInput\(""\);\s*onTakeTourRef\.current\(\);\s*return;/);
  });
  it("the /present launcher carries the tour's words (a run resumes there); /sk has no launcher any more (SK Tutor retired 2026-10-31)", () => {
    expect(readSrc("app/present/present-client.tsx")).toContain("walkCopy={sk.walkCopy}");
    expect(() => readSrc("app/sk/layout.tsx")).toThrow();
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
  // 2026-10-31 ("SK show me around still didn't start the tour"): the start
  // no longer waits for the page she is on unless stop 1 is there (≤ 2 s).
  it("the start: one single-flight starter, 'Starting the tour…' at once, the page settle only through the starter's capped wait", () => {
    const start = w.slice(w.indexOf("const [starting, setStarting] = useState(false);"), w.indexOf("const goKey = goKeyOf(walk);"));
    expect(start).toContain("const starter = createWalkStarter<{ record: boolean }>({");
    expect(start).toContain("settle: (capMs, signal) => waitForSettledPage({ probe: settleProbe(null), observe: observePage, signal, capMs }),");
    expect(start).toContain("navigate: (route) => router.push(route),");
    expect(start).not.toMatch(/await waitForSettledPage\(/);
    expect(w).toContain("<WalkStarting copy={copy} onSkip={cancelStart} />");
    expect(read("sk-launcher.tsx")).toContain("tourActive || tour.starting");
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
