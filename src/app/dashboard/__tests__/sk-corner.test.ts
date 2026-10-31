/**
 * SK in the corner (founder 2026-10-30: "get rid of this boxed approach for
 * sk … just keep the avatar to the bottom right … keep [the text] hidden by
 * default … show the thought bubble on what the avatar is saying"). Replaces
 * the home-hero suite: no card on the landing pages; on every page the
 * launcher shows a round avatar at the bottom-end corner with a speech bubble,
 * a menu, and the conversation as a compact NON-modal sheet when she asks for
 * it. The layout's skOn gate is unchanged. Server-rendered with
 * react-dom/server (no DOM in this suite) plus source pins for the wiring no
 * render can see.
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/sk-corner.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import en from "@/i18n/messages/en.json";
import ar from "@/i18n/messages/ar.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, prefetch: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => "/dashboard",
}));

const read = (f: string) => readFileSync(resolve(__dirname, "..", f), "utf8").replace(/\r\n/g, "\n");
const noop = () => {};
/** Code only: comments may name what the code must not do. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

type HomeModule = typeof import("../sk-home");
async function loadHome(featureOn: boolean): Promise<HomeModule> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_FEATURE_SK", featureOn ? "true" : "false");
  return import("../sk-home");
}

async function shell(props: Record<string, unknown> = {}) {
  vi.resetModules();
  const { default: SkShell } = await import("../sk-shell");
  return renderToStaticMarkup(createElement(SkShell, { copy: en.sk.shell, role: "teacher", hat: null, ...props } as Parameters<typeof SkShell>[0]));
}

describe("the layout's gate is unchanged (sk-home.tsx)", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());
  it("skHeroVisible: the layout's gate AND the build flag", async () => {
    const { skHeroVisible } = await loadHome(true);
    expect(skHeroVisible(true, true)).toBe(true);
    expect(skHeroVisible(false, true)).toBe(false);
    expect(skHeroVisible(true, false)).toBe(false);
    expect(skHeroVisible(null, true)).toBe(false);
  });
  it("useSkOn reads the provider's decision (false outside it, or with the build flag off)", async () => {
    const probe = (mod: HomeModule) =>
      function Probe() {
        return createElement("i", null, String(mod.useSkOn()));
      };
    let mod = await loadHome(true);
    expect(renderToStaticMarkup(createElement(mod.SkHomeProvider, { on: true }, createElement(probe(mod))))).toBe("<i>true</i>");
    expect(renderToStaticMarkup(createElement(mod.SkHomeProvider, { on: false }, createElement(probe(mod))))).toBe("<i>false</i>");
    expect(renderToStaticMarkup(createElement(probe(mod)))).toBe("<i>false</i>");
    mod = await loadHome(false);
    expect(renderToStaticMarkup(createElement(mod.SkHomeProvider, { on: true }, createElement(probe(mod))))).toBe("<i>false</i>");
  });
  it("the home pages: each role's landing page, exactly", async () => {
    const { isSkHomePath } = await loadHome(true);
    for (const p of ["/dashboard", "/dashboard/", "/dashboard/children", "/dashboard/school"]) expect(isSkHomePath(p), p).toBe(true);
    for (const p of ["/dashboard/kits", "/dashboard/school/analytics", "/present", "/sk", "", null, undefined]) expect(isSkHomePath(p), String(p)).toBe(false);
  });
  it("the dashboard layout still hands down ITS skOn decision, decided as before", () => {
    const src = read("layout.tsx");
    expect(src).toContain("<SkHomeProvider on={skOn}>");
    expect(src).toContain("skOn = await skShellEnabledFor(supabase, user, role, schoolId);");
    expect(src).toContain("{skOn && <SkLauncher copy={t.sk.shell} walkCopy={t.sk.walkthrough} role={role} hat={hat} introDue={skIntroDue || skReplay} replay={skReplay} />}");
  });
});

describe("no card anywhere", () => {
  it("the landing pages no longer reserve a place for SK", () => {
    for (const f of ["page.tsx", "children/page.tsx", "school/page.tsx"]) {
      expect(read(f), f).not.toContain("SkHomeHero");
    }
    expect(read("sk-home.tsx")).not.toMatch(/export function SkHomeHero/);
  });
  it("the Shell renders the corner: no hero card, no modal dialog, no backdrop, no dock", async () => {
    const html = await shell();
    expect(html).not.toContain('data-sk="hero"');
    expect(html).not.toContain('data-sk="dock"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("bg-black/40");
    // The text is hidden by default: no conversation, no text box.
    expect(html).not.toContain('data-sk="shell"');
    expect(html).not.toContain('data-sk="input"');
    expect(html).not.toContain(en.sk.shell.hero.greeting);
  });
});

describe("the avatar: the full figure, ~144 px tall (112 px on a phone), bottom-end, z-40 (founder 2026-10-30: \"keep the full size avatar instead of just the head\")", () => {
  it("fixed at the bottom-end corner, standing: the full flattened figure, never a crop", async () => {
    const html = await shell();
    expect(html).toMatch(/class="pointer-events-none fixed bottom-4 end-4 items-end z-40 [^"]*"[^>]*data-sk="launcher"/);
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*data-sk="avatar"[^>]*data-sk-look="B"[^>]*data-tour="sk-launcher"/);
    expect(html).toContain("h-28 sm:h-36");
    expect(html).toContain("/sk/portrait/sk-b-full.webp");
    expect(html).toContain("h-full w-auto object-contain object-bottom");
    expect(html).not.toContain("scale-150");
    expect(html).not.toContain("body.png");
    expect(html).toContain(`aria-label="${en.sk.shell.corner.avatar}"`);
  });
  it("the Board: bottom-START, and the bubble opens toward the page (end side)", async () => {
    const html = await shell({ side: "start" });
    expect(html).toMatch(/class="pointer-events-none fixed bottom-4 start-4 items-start z-40/);
    expect(html).toContain("flex items-start gap-4 flex-row-reverse");
    expect(html).toMatch(/data-sk="bubble-tail" class="absolute top-5 -start-3 /);
  });
  it("the leaders' School pages: raised above the School-briefing bot's corner", async () => {
    const html = await shell({ raised: true });
    expect(html).toMatch(/fixed bottom-20 end-4 items-end z-40/);
  });
  it("speaking: a soft glow around the figure that pulses by opacity only, still under reduced motion", () => {
    const src = read("sk-corner.tsx");
    expect(src).toContain('${speaking ? "opacity-100 motion-safe:animate-pulse" : "opacity-0"}');
    expect(src).toContain("motion-reduce:transition-none");
    // Listening: a small red dot badge.
    expect(src).toMatch(/\{listening && <span aria-hidden data-sk="listening-dot" className="absolute top-1 end-1 [^"]*bg-\[#B42318\]/);
  });
});

describe("the speech bubble: beside the avatar, toward the page", () => {
  it("max ~320 px (the viewport minus 88 px on a phone), four lines then scrollable, a THOUGHT bubble: two trailing circles toward the head", async () => {
    const html = await shell();
    expect(html).toContain('data-sk="bubble"');
    expect(html).toContain("max-w-[min(320px,calc(100vw-88px))]");
    expect(html).toMatch(/data-sk="bubble-tail" class="absolute top-5 -end-3 h-3 w-3 rounded-full/);
    expect(html).toContain("absolute top-9 -end-[22px] h-2 w-2 rounded-full");
    // Nothing to say yet: present but faded out, inert, out of the a11y tree.
    expect(html).toMatch(/data-sk="bubble"[^>]*data-sk-open="false"[^>]*aria-hidden="true"/);
    expect(read("sk-shell.tsx")).toContain('className="max-h-20 overflow-y-auto whitespace-pre-wrap leading-5"');
  });
  it("while a tour runs it is open with the tour inside, and has no × (the tour has Skip)", async () => {
    const strip = () => createElement("div", { "data-sk": "walk" }, "tour strip");
    const html = await shell({ walk: { strip, voice: null, fill: null, showAnswers: false, command: () => false } });
    expect(html).toMatch(/data-sk="bubble" data-sk-kind="tour" data-sk-open="true"/);
    expect(html).toContain("tour strip");
    expect(html).not.toContain('data-sk="bubble-close"');
    // Above the tour's spotlight (z-46) while it runs.
    expect(html).toMatch(/fixed bottom-4 end-4 items-end z-\[48\]/);
  });
  it("hover / focus hold it; × closes it; More and Show open the conversation (wiring)", () => {
    const corner = read("sk-corner.tsx");
    expect(corner).toContain("onMouseEnter={() => onHold(true)}");
    expect(corner).toContain("onMouseLeave={() => onHold(false)}");
    expect(corner).toContain("onFocus={() => onHold(true)}");
    expect(corner).toContain("inert={!open}");
    const src = code(read("sk-shell.tsx"));
    expect(src).toContain('onHold={(on) => dispatchBubble({ type: "hold", on, at: Date.now() })}');
    // × closes the message (not while a tour pins the bubble, nor over her own words as she speaks — 2026-10-30).
    expect(src).toContain('onClose={tourOn || hearingText ? undefined : () => dispatchBubble({ type: "close" })}');
    expect(src).toMatch(/onClick=\{openSheet\}[^>]*data-sk="bubble-more"/);
    expect(src).toMatch(/onClick=\{openSheet\}[^>]*data-sk="bubble-show"/);
  });
  it("what it shows comes from the coordinator's sentence, text-only replies, the greeting, errors and cards", () => {
    const src = code(read("sk-shell.tsx"));
    expect(src).toContain('else if (!walkRef.current?.narrating) dispatchBubble({ type: "sentence", text: c.text, lang: c.lang, at: Date.now() });');
    expect(src).toContain('if (!c) dispatchBubble({ type: "speechEnd", at: Date.now() });');
    expect(src).toContain("if (readAloudRef.current && coord) return;");
    expect(src).toContain('const show = () => dispatchBubble({ type: "error", text: error, at: Date.now() });');
    // The warm start's own error waits for the greeting instead of replacing it.
    expect(src).toContain("if (Date.now() - mountedAtRef.current > WARM_START_WINDOW_MS) return show();");
    expect(src).toContain("const t = window.setTimeout(show, GREETING_MIN_MS);");
    // A failed warm start still greets, with the standard line.
    expect(src).toContain("setGreeting((g) => g ?? copy.greetingFallback);");
    expect(src).toContain("if (!shouldGreet({ home: greet, greeted, tour: tourOn, text: greeting })) return;");
    expect(src).toContain('if (!sheetOpenRef.current) dispatchBubble({ type: "confirm", text: copy.corner.needConfirm, at: Date.now() });');
    // One fade timer, decided by bubble.ts.
    expect(src).toContain("const fadeAt = bubbleFadeAt(bubble, { tour: tourOn });");
  });
});

describe("the menu: compact, keyboard accessible", () => {
  it("renders its items as an ARIA menu, toggles as menuitemcheckbox", async () => {
    vi.resetModules();
    const { SkCornerMenu } = await import("../sk-corner");
    const c = en.sk.shell.corner;
    const items = [
      { kind: "action" as const, id: "type", label: c.typeMessage, onSelect: noop },
      { kind: "action" as const, id: "conversation", label: c.showConversation, onSelect: noop },
      { kind: "toggle" as const, id: "mic", label: en.sk.shell.hero.micSwitch, checked: true, onSelect: noop },
      { kind: "toggle" as const, id: "read-aloud", label: en.sk.shell.readAloud, checked: false, onSelect: noop },
      { kind: "action" as const, id: "tour", label: en.sk.walkthrough.ui.takeTour, onSelect: noop },
      { kind: "action" as const, id: "clear", label: c.clearConversation, onSelect: noop },
      { kind: "action" as const, id: "settings", label: c.settings, onSelect: noop },
    ];
    const html = renderToStaticMarkup(createElement(SkCornerMenu, { label: c.menu, items, onClose: noop, side: "end" }));
    expect(html).toMatch(/role="menu" aria-label="SK menu"/);
    for (const it of items) expect(html).toContain(`data-sk-item="${it.id}"`);
    expect(html).toMatch(/role="menuitemcheckbox" aria-checked="true"[^>]*data-sk-item="mic"/);
    expect(html).toMatch(/role="menuitemcheckbox" aria-checked="false"[^>]*data-sk-item="read-aloud"/);
    expect(html.match(/role="menuitem"/g)?.length).toBe(5);
    expect(html).toContain("Type a message");
    expect(html).toContain("Clear conversation");
    // Opens upward from the avatar, on its side.
    expect(html).toContain("absolute bottom-full mb-2 w-64 max-w-[calc(100vw-2rem)]");
    expect(html).toContain("end-0");
  });
  it("arrow keys, Home / End, Escape (focus back to the avatar) and Tab are handled", () => {
    const src = read("sk-corner.tsx");
    for (const k of ['"ArrowDown"', '"ArrowUp"', '"Home"', '"End"', '"Escape"', '"Tab"']) expect(src).toContain(`e.key === ${k}`);
    expect(src).toContain("onClose(true);");
    expect(read("sk-shell.tsx")).toContain("if (refocus) avatarRef.current?.focus();");
  });
  it("the Shell's menu: Type, Show conversation, Mic (not on the Board), Read aloud, Character, Take the tour (not mid-tour), Clear, SK settings", () => {
    const src = code(read("sk-shell.tsx"));
    const at = (id: string) => src.indexOf(`id: "${id}"`);
    const order = ["type", "conversation", "mic", "read-aloud", "character", "tour", "clear", "settings"].map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(src).toContain('...(listen ? [{ kind: "toggle" as const, id: "mic"');
    expect(src).toContain("...(onTakeTour && takeTourLabel && !walk");
    expect(src).toContain('router.push("/dashboard/settings");');
  });
});

describe("text hidden by default; the conversation as a non-modal sheet", () => {
  it("the sheet (initialText, or the showText pref): the old panel body above the avatar, ~90vw × 60vh on a phone", async () => {
    const html = await shell({ initialText: true });
    expect(html).toContain('data-sk="shell"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("bg-black/40");
    expect(html).toContain("w-[90vw] sm:w-[24rem] h-[60vh]");
    for (const c of ["transcript", "caption", "job-tray", "confirm-slot", "input", "sheet-close", "mic-line"]) expect(html).toContain(`data-sk="${c}"`);
    // The listening corner has no push-to-talk; the Board keeps it.
    expect(html).not.toContain('data-sk="mic"');
    expect(html).not.toContain('data-sk="hands-free"');
    // The Board: no listening line (its push-to-talk and hands-free opt-in
    // render once the browser says it has a mic — after mount).
    const board = await shell({ initialText: true, side: "start", autoListen: false });
    expect(board).not.toContain('data-sk="mic-line"');
    expect(code(read("sk-shell.tsx"))).toContain("{mic && !listen && (");
  });
  it("showText opens it (once per mount); the one-line box closes on Escape or an empty Send", () => {
    const src = code(read("sk-shell.tsx"));
    expect(src).toContain("if (readFlag(PREF_LOCAL_KEY.showText, false)) openTextByPref();");
    expect(src).toContain("if (r.prefs.showText) openTextByPref();");
    expect(src).toMatch(/if \(!input\.trim\(\)\) \{\s*closeQuick\(\);\s*return;\s*\}/);
    expect(src).toMatch(/if \(e\.key !== "Escape" \|\| menuOpen\) return;\s*if \(quickOpen\) closeQuick\(\);\s*else closeSheet\(\);/);
  });
  it("Clear conversation: client-side stores and the visible conversation, no server call", () => {
    const src = code(read("sk-shell.tsx"));
    const clear = src.slice(src.indexOf("function clearAll()"), src.indexOf("const fadeAt = bubbleFadeAt("));
    expect(clear).toContain("clearConversation(storage);");
    expect(clear).toContain("memoryRef.current = undefined;");
    expect(clear).toContain("setEntries([]);");
    expect(clear).not.toContain("fetch(");
  });
  it("Arabic: logical sides only (RTL mirrors the corner, the bubble's tail and the menu)", async () => {
    vi.resetModules();
    const { default: SkShell } = await import("../sk-shell");
    const html = renderToStaticMarkup(createElement(SkShell, { copy: ar.sk.shell, role: "teacher", hat: null, initialText: true }));
    expect(html).not.toMatch(/\b(?:ml|mr|pl|pr|left|right)-\d/);
    expect(read("sk-corner.tsx")).not.toMatch(/\b(?:ml|mr|pl|pr)-\d|\b(?:left|right)-\d/);
  });
});

describe("the launcher (source pins)", () => {
  const src = code(read("sk-launcher.tsx"));
  it("exactly one SkShell, always mounted where the launcher shows; no pill, no portal", () => {
    expect(src.match(/<SkShell\b/g)?.length).toBe(1);
    expect(src).not.toContain("useSkHeroSlot");
    expect(src).not.toContain("portalTo");
    expect(src).not.toContain("btn-primary");
  });
  it("corners: the Board bottom-start, the School pages raised, listening everywhere but the Board", () => {
    expect(src).toContain('side={board ? "start" : "end"}');
    expect(src).toContain("const school = !board && !!pathname?.startsWith(\"/dashboard/school\");");
    expect(src).toContain("raised={school}");
    expect(src).toContain("autoListen={!board}");
    expect(src).toContain('if (pathname?.startsWith("/present") && !board) return null;');
    expect(read("sk-shell.tsx")).toContain("const listen = autoListen ?? !board;");
  });
  it("SK greets the first time it appears in a tab on any page (not the Board or the lesson player); the first-login tour starts from a home page", () => {
    expect(src).toContain("const home = !board && !tutor && isSkHomePath(pathname);");
    expect(src).toContain("greet={!board && !tutor}");
  });
  it("the Shell never narrates on its own: the tour is voiced only through `walk.voice`", () => {
    const shell = read("sk-shell.tsx");
    expect(shell).not.toContain("runNarration");
    expect(shell).not.toContain("introDue");
    expect(shell).toContain("else void coord.sayLine(v.text).then(report);");
  });
  it("a fresh Shell restores this tab's conversation instead of re-greeting", () => {
    const shell = read("sk-shell.tsx");
    expect(shell).toContain("const carried = transcriptRef.current?.load(sessionIdRef.current)");
    expect(shell).toContain("transcriptRef.current?.save(sessionIdRef.current, entries");
  });
});
