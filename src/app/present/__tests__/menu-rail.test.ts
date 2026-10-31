/**
 * Board UX (2026-10-28): the Board's menu (menu-items.ts) and the collapsible
 * unit rail's state (rail-state.ts). Both pure.
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/menu-rail.test.ts
 */
import { describe, expect, it } from "vitest";
import { menuItemsFor } from "../menu-items";
import { RAIL_CLOSED, railReduce, type RailAction } from "../rail-state";
import { tabsForHat } from "@/utils/nav-tabs";
import en from "@/i18n/messages/en.json";

const HOME = { href: "/dashboard", label: "Back to dashboard" };

describe("menuItemsFor — the Board's menu", () => {
  it("leads with Back to dashboard, then the tabs in their own order", () => {
    const items = menuItemsFor(
      [
        { href: "/dashboard/analytics", label: "My analytics" },
        { href: "/dashboard/kits", label: "Ready-made kits" },
      ],
      HOME,
    );
    expect(items).toEqual([HOME, { href: "/dashboard/analytics", label: "My analytics" }, { href: "/dashboard/kits", label: "Ready-made kits" }]);
  });

  it("drops the Board itself (and its sub-routes) and the dashboard tab the home link already is", () => {
    const items = menuItemsFor(
      [
        { href: "/dashboard", label: "Library" },
        { href: "/present", label: "Classroom board" },
        { href: "/present?kit=x", label: "Board, deep-linked" },
        { href: "/present/recap", label: "Board recap" },
        { href: "/presenter", label: "Not the Board" },
      ],
      HOME,
    );
    expect(items.map((i) => i.href)).toEqual(["/dashboard", "/presenter"]);
    expect(items[0].label).toBe("Back to dashboard");
  });

  it("collapses duplicates by href and skips blank entries", () => {
    const items = menuItemsFor(
      [
        { href: " /sk ", label: "SK" },
        { href: "/sk", label: "SK again" },
        { href: "", label: "Nothing" },
        { href: "/dashboard/diary", label: "" },
      ],
      HOME,
    );
    expect(items).toEqual([HOME, { href: "/sk", label: "SK" }]);
  });

  it("with the real teacher-hat tabs: home first, no /present, every other tab once", () => {
    const tabs = tabsForHat(en.nav.tabs, "teacher", true, true, true, true, false, true, true);
    const items = menuItemsFor(tabs, HOME);
    expect(items[0]).toEqual(HOME);
    expect(items.some((i) => i.href.startsWith("/present"))).toBe(false);
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
    // Everything the header offers (bar the Board and the Library, which IS home) is here.
    const expected = tabs.filter((x) => x.href !== "/present" && x.href !== "/dashboard").map((x) => x.href);
    expect(items.slice(1).map((i) => i.href)).toEqual(expected);
  });
});

describe("railReduce — the collapsible unit rail", () => {
  const run = (actions: RailAction[]) => actions.reduce(railReduce, RAIL_CLOSED);

  it("starts closed; open/close/toggle do what they say", () => {
    expect(RAIL_CLOSED).toEqual({ open: false });
    expect(run(["open"])).toEqual({ open: true });
    expect(run(["open", "close"])).toEqual({ open: false });
    expect(run(["toggle"])).toEqual({ open: true });
    expect(run(["toggle", "toggle"])).toEqual({ open: false });
  });

  it("a pick (unit, doc, video) closes it: she asked for a thing, not a panel", () => {
    expect(run(["open", "pick"])).toEqual({ open: false });
    expect(run(["pick"])).toEqual({ open: false });
  });

  it("returns the SAME state when nothing changes (no re-render for a no-op)", () => {
    const open = railReduce(RAIL_CLOSED, "open");
    expect(railReduce(open, "open")).toBe(open);
    expect(railReduce(RAIL_CLOSED, "close")).toBe(RAIL_CLOSED);
    expect(railReduce(RAIL_CLOSED, "pick")).toBe(RAIL_CLOSED);
    expect(railReduce(RAIL_CLOSED, "nonsense" as RailAction)).toBe(RAIL_CLOSED);
  });
});
