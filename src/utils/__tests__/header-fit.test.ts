import { describe, expect, it } from "vitest";
import { headerFit } from "../header-fit";

// The geometry these assertions are checked against, measured from the live
// principal header at 1536px (English, 2026-08-02):
//
//   scrollbar 15 + bar padding 40 + brand 178 + inter-item gaps 40   = 273
//   bell 36 + Tour 75 + Sign out 80 + their gaps 36                  = 227
//   language picker 189 · hat switcher 175 · school badge 117 · name 183
//
// so the room left for the centred tab row at a given viewport is
//   viewport - 273 - (the controls actually showing at that width).
const CHROME = 273;
const FIXED_CONTROLS = 227;
const LANG = 189;
const HAT = 175;
// The two informational items step back in at their own widths (app-header).
const SCHOOL_BADGE = { from: 1600, px: 117 };
const NAME_AND_ROLE = { from: 1800, px: 183 };

function roomForTabs(viewport: number, { hat }: { hat: boolean }): number {
  const right =
    FIXED_CONTROLS +
    LANG +
    (hat ? HAT : 0) +
    (viewport >= SCHOOL_BADGE.from ? SCHOOL_BADGE.px : 0) +
    (viewport >= NAME_AND_ROLE.from ? NAME_AND_ROLE.px : 0);
  return viewport - CHROME - right;
}

// Real tab rows, measured. English is the NARROWEST case — every other
// language is wider — so these are the friendliest widths the fix will see.
const ROLES = [
  { name: "principal", tabs: 7, hat: true, navPx: 502 },
  { name: "coordinator", tabs: 6, hat: true, navPx: 442 },
  { name: "parent", tabs: 6, hat: false, navPx: 442 },
  { name: "teacher", tabs: 5, hat: false, navPx: 387 },
  { name: "student", tabs: 2, hat: false, navPx: 160 },
];

const TIER_PX: Record<string, number> = {
  "hidden sm:flex": 640,
  "hidden md:flex": 768,
  "hidden lg:flex": 1024,
  "hidden xl:flex": 1280,
  "hidden 2xl:flex": 1536,
};

describe("headerFit", () => {
  it.each(ROLES)("$name's tabs fit at the tier it is given", ({ tabs, hat, navPx }) => {
    const { navShow } = headerFit({ tabs, hatSwitcher: hat, languagePicker: true });
    // The whole point: at the width where the inline row first appears, the
    // row must actually FIT. Failing this is the 2026-08-02 overlap returning.
    expect(roomForTabs(TIER_PX[navShow], { hat })).toBeGreaterThanOrEqual(navPx);
  });

  it("keeps the principal's row fitting at every width above its tier, including where the school badge and name return", () => {
    const { navShow } = headerFit({ tabs: 7, hatSwitcher: true, languagePicker: true });
    expect(navShow).toBe("hidden 2xl:flex");
    // 1600 and 1800 are the widths that ADD a control back; they are the local
    // worst cases, not the narrowest viewport.
    for (const vw of [1536, 1599, 1600, 1799, 1800, 1920, 2560]) {
      expect(roomForTabs(vw, { hat: true }), `principal at ${vw}px`).toBeGreaterThanOrEqual(502);
    }
  });

  it("pairs each show class with the mirroring hide class, so exactly one nav is on screen", () => {
    for (const tabs of [0, 2, 5, 7, 12]) {
      for (const hatSwitcher of [true, false]) {
        const { navShow, navHide } = headerFit({ tabs, hatSwitcher, languagePicker: true });
        expect(navShow).toBe(`hidden ${navHide.replace(":hidden", "")}:flex`);
      }
    }
  });

  it("gives a light bar a low tier and a heavy one the highest, never past it", () => {
    // A student with the picker off is the lightest bar the app renders.
    expect(headerFit({ tabs: 2, hatSwitcher: false, languagePicker: false }).navShow).toBe("hidden md:flex");
    // Nothing may exceed 2xl — there is no wider tier to escalate to.
    expect(headerFit({ tabs: 40, hatSwitcher: true, languagePicker: true }).navShow).toBe("hidden 2xl:flex");
  });

  it("charges for the language picker, since adding it is what broke the bar", () => {
    const off = headerFit({ tabs: 6, hatSwitcher: true, languagePicker: false }).needed;
    const on = headerFit({ tabs: 6, hatSwitcher: true, languagePicker: true }).needed;
    expect(on - off).toBe(189);
  });
});
