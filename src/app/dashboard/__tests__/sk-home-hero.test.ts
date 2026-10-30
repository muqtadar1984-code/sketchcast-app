/**
 * SK as the first thing a signed-in user sees (founder 2026-10-30): the hero
 * on the landing pages renders ONLY when the dashboard layout's SK gate
 * (skShellEnabledFor → skOn) passed; it is SkShell's `variant="hero"` (one
 * engine) with the Mic switch top-end of the card, portalled by the layout's
 * launcher so ONE Shell moves between the hero and the floating panel as she
 * changes pages. Server-rendered with react-dom/server (no DOM in this suite)
 * plus source pins for the wiring no render can see.
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/sk-home-hero.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import en from "@/i18n/messages/en.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, prefetch: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => "/dashboard",
}));

const read = (f: string) => readFileSync(resolve(__dirname, "..", f), "utf8");

type HomeModule = typeof import("../sk-home");

async function loadHome(featureOn: boolean): Promise<HomeModule> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_FEATURE_SK", featureOn ? "true" : "false");
  return import("../sk-home");
}

const renderHome = (mod: HomeModule, on: boolean) => renderToStaticMarkup(createElement(mod.SkHomeProvider, { on }, createElement(mod.SkHomeHero, { className: "pt-6" })));

describe("skHeroVisible: the layout's gate AND the build flag", () => {
  it("only when both say on", async () => {
    const { skHeroVisible } = await loadHome(true);
    expect(skHeroVisible(true, true)).toBe(true);
    expect(skHeroVisible(false, true)).toBe(false);
    expect(skHeroVisible(true, false)).toBe(false);
    expect(skHeroVisible(null, true)).toBe(false);
    expect(skHeroVisible(undefined, true)).toBe(false);
  });
});

describe("SkHomeHero renders only when SK is on", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("SK off for this user (skOn false) → nothing at all, not even the page's spacing", async () => {
    const mod = await loadHome(true);
    expect(renderHome(mod, false)).toBe("");
  });

  it("no provider (a page outside the dashboard layout) → nothing", async () => {
    const mod = await loadHome(true);
    expect(renderToStaticMarkup(createElement(mod.SkHomeHero))).toBe("");
  });

  it("the deployment never opted in (NEXT_PUBLIC_FEATURE_SK unset) → nothing, even with skOn", async () => {
    const mod = await loadHome(false);
    expect(renderHome(mod, true)).toBe("");
  });

  it("SK on → the hero's place on the page, which the launcher's one Shell fills", async () => {
    const mod = await loadHome(true);
    expect(renderHome(mod, true)).toBe('<div class="pt-6" data-sk="home-hero"></div>');
  });
});

describe('SkShell variant="hero": the card', () => {
  it("still avatar (Look B by default), greeting, text box and Send, Mic switch — not the dialog", async () => {
    vi.resetModules();
    const { default: SkShell } = await import("../sk-shell");
    const html = renderToStaticMarkup(createElement(SkShell, { variant: "hero", copy: en.sk.shell, tourCopy: en.app.tour, role: "teacher", hat: null, introDue: false }));
    expect(html).toContain('data-sk="hero"');
    // NOT the floating dialog: one engine, the inline variant.
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('data-sk="shell"');
    // The still avatar: the flattened head-and-shoulders portrait, never the
    // rig's body layer (it has no head).
    expect(html).toMatch(/data-sk="avatar"[^>]*data-sk-look="B"/);
    expect(html).toContain("/sk/portrait/sk-b.webp");
    expect(html).not.toContain("body.png");
    // The one-line greeting, then the text box and Send.
    expect(html).toContain(en.sk.shell.hero.greeting);
    expect(html).toContain('data-sk="input"');
    expect(html).toContain(">" + en.sk.shell.send + "<");
    // The switch: a real switch, labelled, with its visible state.
    expect(html).toMatch(/role="switch"[^>]*aria-checked="(true|false)"[^>]*aria-label="Microphone"/);
    expect(html).toContain('data-sk="mic-switch"');
    // No push-to-talk button and no hands-free opt-in in the hero.
    expect(html).not.toContain('data-sk="mic"');
    expect(html).not.toContain('data-sk="hands-free"');
  });
  it("the panel variant is still the dialog, with no Mic switch", async () => {
    vi.resetModules();
    const { default: SkShell } = await import("../sk-shell");
    const html = renderToStaticMarkup(createElement(SkShell, { copy: en.sk.shell, tourCopy: en.app.tour, role: "teacher", hat: null, introDue: false, onClose: () => {} }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-sk="shell"');
    expect(html).not.toContain('data-sk="mic-switch"');
    expect(html).not.toContain('data-sk="hero"');
  });
});

describe("the wiring (source pins)", () => {
  it("the dashboard layout hands the hero ITS skOn decision", () => {
    const src = read("layout.tsx");
    expect(src).toContain("<SkHomeProvider on={skOn}>");
    // skOn is still decided by skShellEnabledFor, unchanged.
    expect(src).toContain("skOn = await skShellEnabledFor(supabase, user, role, schoolId);");
  });
  it("each landing page has the hero: /dashboard (library and student view), /dashboard/children, /dashboard/school", () => {
    const home = read("page.tsx");
    expect(home.match(/<SkHomeHero\b/g)?.length).toBe(2);
    expect(read("children/page.tsx")).toContain("<SkHomeHero />");
    expect(read("school/page.tsx")).toContain("<SkHomeHero />");
  });
  it("the launcher keeps ONE Shell: portalled into the hero's place, the panel elsewhere, no pill beside a hero", () => {
    const src = read("sk-launcher.tsx");
    expect(src).toContain("const slot = useSkHeroSlot();");
    expect(src).toContain('variant={heroHere ? "hero" : "panel"}');
    expect(src).toContain("portalTo={heroHere ? slot : null}");
    expect(src).toContain("{!heroHere && (");
    // Exactly one SkShell element, so React keeps its state through every move.
    expect(src.match(/<SkShell\b/g)?.length).toBe(1);
  });
  it("leaving the hero's page carries an engaged conversation on in the panel, open", () => {
    const src = read("sk-launcher.tsx");
    expect(src).toContain("if (wasHero) setOpen(engaged);");
    expect(src).toContain("onEngaged={() => setEngaged(true)}");
  });
  it("the hero never narrates the intro (it speaks, and nothing may play before a gesture)", () => {
    expect(read("sk-shell.tsx")).toMatch(/if \(hero\) \{\s*introStartedRef\.current = true;\s*return;/);
  });
  it("a fresh Shell restores this tab's conversation instead of re-greeting", () => {
    const src = read("sk-shell.tsx");
    expect(src).toContain("const carried = transcriptRef.current?.load(sessionIdRef.current)");
    expect(src).toContain("transcriptRef.current?.save(sessionIdRef.current, entries");
  });
  it("the Mic switch sits at the END of the card's top row (logical, so RTL mirrors it)", () => {
    const src = read("sk-shell.tsx");
    expect(src).toContain('<div className="flex items-center justify-between gap-2">');
    expect(src).toContain("rtl:-translate-x-5");
  });
});
