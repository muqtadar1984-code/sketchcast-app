import { describe, expect, it } from "vitest";
import { isHardReload } from "@/sk/shell/tour";

const h = (o: Record<string, string>) => new Headers(o);

describe("isHardReload", () => {
  it("is true for a Ctrl+Shift+R page load", () => {
    expect(isHardReload(h({ "sec-fetch-mode": "navigate", "cache-control": "no-cache", pragma: "no-cache" }))).toBe(true);
    expect(isHardReload(h({ "sec-fetch-mode": "navigate", pragma: "no-cache" }))).toBe(true);
  });

  it("is false for a normal reload or a first visit", () => {
    expect(isHardReload(h({ "sec-fetch-mode": "navigate", "cache-control": "max-age=0" }))).toBe(false);
    expect(isHardReload(h({ "sec-fetch-mode": "navigate" }))).toBe(false);
  });

  it("is false for the app's own fetches", () => {
    expect(isHardReload(h({ "sec-fetch-mode": "cors", "cache-control": "no-cache" }))).toBe(false);
    expect(isHardReload(h({ "sec-fetch-mode": "navigate", rsc: "1", "cache-control": "no-cache" }))).toBe(false);
    expect(isHardReload(h({ "cache-control": "no-cache" }))).toBe(false);
  });
});
