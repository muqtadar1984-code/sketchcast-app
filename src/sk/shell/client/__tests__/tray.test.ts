/**
 * The job tray's client rules (S2): poll every 15 s only while a kit is still
 * being made, the panel is open and the tab is visible; hide when empty; the
 * state words; a defensive parse of the route's reply.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/tray.test.ts
 */
import { describe, expect, it } from "vitest";
import { TRAY_POLL_MS, parseTray, shouldPollTray, trayInProgress, trayStateText, trayVisible } from "../tray";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";

const making = { state: "making" as const };
const partial = { state: "partial" as const };
const ready = { state: "ready" as const };
const failed = { state: "failed" as const };

describe("shouldPollTray", () => {
  it("polls every 15 s", () => {
    expect(TRAY_POLL_MS).toBe(15_000);
  });
  it.each([
    ["a kit being made, open, visible", { open: true, visibility: "visible", kits: [making] }, true],
    ["a kit partly ready, open, visible", { open: true, visibility: "visible", kits: [ready, partial] }, true],
    ["everything finished", { open: true, visibility: "visible", kits: [ready, failed] }, false],
    ["an empty tray", { open: true, visibility: "visible", kits: [] }, false],
    ["the tab is hidden", { open: true, visibility: "hidden", kits: [making] }, false],
    ["the tab is prerendering / unknown", { open: true, visibility: undefined, kits: [making] }, false],
    ["the panel is closed", { open: false, visibility: "visible", kits: [making] }, false],
  ])("%s → %s", (_n, input, want) => {
    expect(shouldPollTray(input)).toBe(want);
  });
  it("trayInProgress / trayVisible", () => {
    expect(trayInProgress([ready, making])).toBe(true);
    expect(trayInProgress([ready])).toBe(false);
    expect(trayVisible([])).toBe(false);
    expect(trayVisible([ready])).toBe(true);
  });
});

describe("trayStateText", () => {
  it("one line per state, from the dictionary", () => {
    const k = (state: "making" | "partial" | "ready" | "failed") => ({ state, ready: 2, total: 7 });
    expect(trayStateText(k("making"), en.sk.shell.tray)).toBe("Being made");
    expect(trayStateText(k("partial"), en.sk.shell.tray)).toBe("2 of 7 pieces ready");
    expect(trayStateText(k("ready"), en.sk.shell.tray)).toBe("Ready");
    expect(trayStateText(k("failed"), en.sk.shell.tray)).toBe("Didn't finish");
    expect(trayStateText(k("partial"), ms.sk.shell.tray)).toBe("2 daripada 7 bahagian siap");
  });
});

describe("parseTray", () => {
  it("keeps well-formed kits (at most 3) and drops the rest", () => {
    const good = { id: "p1", title: "Specialised Cells", state: "partial", ready: 2, total: 7, href: "/dashboard?book=b1" };
    const out = parseTray({
      kits: [good, { ...good, id: "p2", state: "bogus" }, { ...good, id: "p3", href: "https://evil.example/" }, { ...good, id: "p4", href: "//evil.example" }, { ...good, id: "p5" }],
    });
    expect(out.map((k) => k.id)).toEqual(["p1", "p3"]);
    expect(out[1].href).toBeNull();
    expect(parseTray(null)).toEqual([]);
    expect(parseTray({ kits: "x" })).toEqual([]);
  });
});
