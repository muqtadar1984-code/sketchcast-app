/**
 * SK's character switch: the avatar's menu has a Character row (two round
 * thumbnails, a radio group of menuitemradio), and the settings page has the
 * same choice as two thumbnail radio buttons. useRigChoice stays the one
 * source: the Shell's warm start applies the server's lookA to it, and a pick
 * calls choose() AND saves the preference. Server-rendered (no DOM in this
 * suite) plus source pins for the wiring a static render cannot see.
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/sk-character.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import en from "@/i18n/messages/en.json";
import { DEFAULT_PREFS } from "@/sk/prefs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, prefetch: () => {}, replace: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => "/dashboard/settings",
}));

const read = (f: string) => readFileSync(resolve(__dirname, "..", f), "utf8").replace(/\r\n/g, "\n");
/** Code only: comments may name what the code must not do. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const noop = () => {};

async function menu(value: "A" | "B") {
  vi.resetModules();
  const { SkCornerMenu } = await import("../sk-corner");
  const c = en.sk.shell.corner;
  const items = [
    { kind: "toggle" as const, id: "read-aloud", label: en.sk.shell.readAloud, checked: true, onSelect: noop },
    {
      kind: "choice" as const,
      id: "character",
      label: c.character,
      value,
      options: [
        { value: "A", label: c.lookA, image: "/sk/portrait/sk-a.webp" },
        { value: "B", label: c.lookB, image: "/sk/portrait/sk-b.webp" },
      ],
      onSelect: noop,
    },
    { kind: "action" as const, id: "settings", label: c.settings, onSelect: noop },
  ];
  return renderToStaticMarkup(createElement(SkCornerMenu, { label: c.menu, items, onClose: noop, side: "end" }));
}

describe("the avatar's menu: a Character row", () => {
  it("both looks as menuitemradio in a labelled group, with thumbnails and their labels", async () => {
    const html = await menu("B");
    expect(html).toMatch(/role="group" aria-labelledby="sk-menu-character"/);
    expect(html).toContain(`id="sk-menu-character"`);
    expect(html).toContain(en.sk.shell.corner.character);
    expect(html.match(/role="menuitemradio"/g)?.length).toBe(2);
    expect(html).toContain(en.sk.shell.corner.lookA);
    expect(html).toContain(en.sk.shell.corner.lookB);
    expect(html).toContain("/sk/portrait/sk-a.webp");
    expect(html).toContain("/sk/portrait/sk-b.webp");
    // The other kinds are unchanged.
    expect(html).toMatch(/role="menuitemcheckbox" aria-checked="true"[^>]*data-sk-item="read-aloud"/);
    expect(html.match(/role="menuitem"/g)?.length).toBe(1);
  });
  it("aria-checked marks the current look", async () => {
    const b = await menu("B");
    expect(b).toMatch(/role="menuitemradio" aria-checked="false"[^>]*data-sk-item="character-A"/);
    expect(b).toMatch(/role="menuitemradio" aria-checked="true"[^>]*data-sk-item="character-B"/);
    const a = await menu("A");
    expect(a).toMatch(/role="menuitemradio" aria-checked="true"[^>]*data-sk-item="character-A"/);
    expect(a).toMatch(/role="menuitemradio" aria-checked="false"[^>]*data-sk-item="character-B"/);
  });
  it("keyboard: the arrow keys reach each option (every menuitem* role), and a pick passes its value", () => {
    const src = read("sk-corner.tsx");
    expect(src).toContain(`querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')`);
    expect(src).toContain("onClick={() => it.onSelect(o.value)}");
  });
  it("the Shell: the row reads the rig and a pick calls choose AND savePref (prefs.ts pickLook)", () => {
    const src = code(read("sk-shell.tsx"));
    expect(src).toContain("const [rig, chooseRig] = useRigChoice();");
    expect(src).toMatch(/kind: "choice",\s+id: "character",\s+label: cc\.character,/);
    expect(src).toContain("value: rig,");
    expect(src).toContain('{ value: "A", label: cc.lookA, image: "/sk/portrait/sk-a.webp" }');
    expect(src).toContain('{ value: "B", label: cc.lookB, image: "/sk/portrait/sk-b.webp" }');
    expect(src).toContain("onSelect: (v: string) => void pickLook(v, readRigChoice(), chooseRig, savePref),");
    // The avatar itself still follows the rig.
    expect(src).toContain("look={rig}");
  });
});

describe("the Shell's warm start applies the server's look", () => {
  it("through chooseRig, so the avatar, the voice gender and every reader update", () => {
    const src = code(read("sk-shell.tsx"));
    const warm = src.slice(src.indexOf("const r = resolvePrefs("), src.indexOf("setPrefsSettled(true);"));
    expect(warm).toContain("applyLook(r.prefs, readRigChoice(), chooseRig);");
    // The rig's key holds a letter, never "on" / "off".
    expect(warm).toContain('for (const k of PREF_KEYS) if (k !== "lookA") writeFlag(PREF_LOCAL_KEY[k], r.prefs[k]);');
    // lookA migrates under its own marker.
    expect(warm).toContain("(k) => readText(migratedLocalKey(k)) === \"1\"");
    expect(warm).toContain("MIGRATED_LOCAL_KEYS.forEach((m) => writeText(m, \"1\"))");
    // The local look is read as A / B.
    expect(src).toContain("const v = parseLocalPref(k, readText(PREF_LOCAL_KEY[k]));");
  });
  it("the voice gender still follows the rig at speak time", () => {
    const src = code(read("sk-shell.tsx"));
    expect(src).toContain("voiceGenderForChoice(readRigChoice())");
  });
});

describe("the settings page: the same Character choice", () => {
  async function page(props: Record<string, unknown> = {}) {
    vi.resetModules();
    const { default: SkPrivacy } = await import("../settings/sk-privacy");
    return renderToStaticMarkup(
      createElement(SkPrivacy, {
        t: en.settings,
        role: "teacher",
        prefs: DEFAULT_PREFS,
        memoryReadable: true,
        workflow: [],
        learning: null,
        children: [],
        school: null,
        student: null,
        ...props,
      } as Parameters<typeof SkPrivacy>[0]),
    );
  }
  it("two thumbnail radio buttons with their labels, the default look checked", async () => {
    const html = (await page()).replace(/&#x27;/g, "'");
    expect(html).toContain(`<legend class="font-medium">${en.settings.character}</legend>`);
    expect(html).toContain(en.settings.characterHint);
    const radio = (c: string) => html.match(new RegExp(`<input[^>]*data-sk-look="${c}"[^>]*>`))?.[0] ?? "";
    expect(html.match(/<input type="radio"[^>]*name="sk-look"/g)?.length).toBe(2);
    expect(radio("A")).toContain('value="A"');
    expect(radio("A")).not.toContain("checked");
    expect(radio("B")).toContain('checked=""');
    expect(html).toContain(en.settings.lookA);
    expect(html).toContain(en.settings.lookB);
    expect(html).toContain("/sk/portrait/sk-a.webp");
    expect(html).toContain("/sk/portrait/sk-b.webp");
  });
  it("a pick calls choose AND saves lookA (reverted on a failure); delete-my-memory forgets the look", () => {
    const src = code(read("settings/sk-privacy.tsx"));
    expect(src).toContain("const [rig, chooseRig] = useRigChoice();");
    expect(src).toContain('<LookChoice t={t} value={rig} busy={busy === "pref:lookA"} onPick={(c) => void pickLook(c)} />');
    const pick = src.slice(src.indexOf("async function pickLook("), src.indexOf("async function toggleConsent("));
    expect(pick).toContain("chooseRig(next);");
    expect(pick).toContain('send("/api/sk/prefs", "POST", { lookA: next === "A" })');
    expect(pick).toContain("chooseRig(prev);");
    expect(src).toContain("forgetRigChoice();");
    expect(src.indexOf('id="pref-text"')).toBeLessThan(src.indexOf("<LookChoice "));
  });
});
