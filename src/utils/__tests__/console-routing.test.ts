import { describe, it, expect } from "vitest";
import { isStaffDomain, consoleRoute, bareHost, STAFF_LOGIN_PATH } from "../console-routing";

const HOST = "console.sketchcast.app";
const MAIN = "app.sketchcast.app";

describe("isStaffDomain", () => {
  it("accepts @sketchcast.app (case/space-insensitive)", () => {
    expect(isStaffDomain("muqtadar.quraishi@sketchcast.app")).toBe(true);
    expect(isStaffDomain("  ADMIN@SketchCast.App ")).toBe(true);
  });
  it("rejects non-company domains", () => {
    expect(isStaffDomain("someone@gmail.com")).toBe(false);
    expect(isStaffDomain("muqtadar1984@gmail.com")).toBe(false);
    expect(isStaffDomain("")).toBe(false);
    expect(isStaffDomain(null)).toBe(false);
    expect(isStaffDomain(undefined)).toBe(false);
  });
  it("is not fooled by look-alike domains", () => {
    expect(isStaffDomain("evil@notsketchcast.app")).toBe(false); // no '@' boundary
    expect(isStaffDomain("evil@sketchcast.app.attacker.com")).toBe(false);
    expect(isStaffDomain("evil@sub.sketchcast.app")).toBe(false); // subdomain, not exact
  });
});

describe("bareHost", () => {
  it("lowercases and strips port", () => {
    expect(bareHost("Console.SketchCast.app:443")).toBe("console.sketchcast.app");
    expect(bareHost(null)).toBe("");
  });
  it("strips a trailing-dot FQDN so it can't dodge the exact host match", () => {
    expect(bareHost("console.sketchcast.app.")).toBe("console.sketchcast.app");
    expect(bareHost("console.sketchcast.app.:443")).toBe("console.sketchcast.app");
  });
});

describe("consoleRoute — trailing-dot FQDN is treated as the console host", () => {
  it("routes console.sketchcast.app. the same as the bare host", () => {
    // Would previously have taken the main-host branch (pass) and served the
    // teacher app on the console origin; now it normalizes and stays in-console.
    expect(
      consoleRoute({ consoleHostname: HOST, host: "console.sketchcast.app.", path: "/console", hasUser: true }),
    ).toEqual({ type: "pass" });
    expect(
      consoleRoute({ consoleHostname: HOST, host: "console.sketchcast.app.", path: "/", hasUser: false }),
    ).toEqual({ type: "redirect", path: STAFF_LOGIN_PATH });
  });
});

describe("consoleRoute — feature OFF (no console host configured)", () => {
  it("passes everything through untouched", () => {
    for (const path of ["/console", "/console/users", "/dashboard", "/", "/staff-login"]) {
      expect(consoleRoute({ consoleHostname: null, host: MAIN, path, hasUser: true })).toEqual({ type: "pass" });
    }
  });
});

describe("consoleRoute — on the CONSOLE host", () => {
  const on = (path: string, hasUser: boolean) => consoleRoute({ consoleHostname: HOST, host: HOST, path, hasUser });

  it("serves the console for a signed-in user", () => {
    expect(on("/console", true)).toEqual({ type: "pass" });
    expect(on("/console/users/abc", true)).toEqual({ type: "pass" });
  });
  it("sends a logged-out console hit to the staff login", () => {
    expect(on("/console", false)).toEqual({ type: "redirect", path: STAFF_LOGIN_PATH });
    expect(on("/console/issues", false)).toEqual({ type: "redirect", path: STAFF_LOGIN_PATH });
  });
  it("always serves the staff login, shared auth handlers, and APIs", () => {
    expect(on("/staff-login", false)).toEqual({ type: "pass" });
    expect(on("/auth/confirm", false)).toEqual({ type: "pass" });
    expect(on("/auth/signout", true)).toEqual({ type: "pass" });
    expect(on("/api/console/issues", true)).toEqual({ type: "pass" });
    expect(on("/api/autofix/decide", false)).toEqual({ type: "pass" });
  });
  it("bounces teacher-facing paths into the console world", () => {
    expect(on("/", true)).toEqual({ type: "redirect", path: "/console" });
    expect(on("/", false)).toEqual({ type: "redirect", path: STAFF_LOGIN_PATH });
    expect(on("/dashboard", true)).toEqual({ type: "redirect", path: "/console" });
    expect(on("/login", false)).toEqual({ type: "redirect", path: STAFF_LOGIN_PATH });
    expect(on("/signup", false)).toEqual({ type: "redirect", path: STAFF_LOGIN_PATH });
  });
});

describe("consoleRoute — on the MAIN host while the subdomain is enabled", () => {
  const main = (path: string, hasUser: boolean) => consoleRoute({ consoleHostname: HOST, host: MAIN, path, hasUser });

  it("removes the console + staff login entirely (→ /dashboard)", () => {
    expect(main("/console", true)).toEqual({ type: "redirect", path: "/dashboard" });
    expect(main("/console/users", true)).toEqual({ type: "redirect", path: "/dashboard" });
    expect(main("/staff-login", false)).toEqual({ type: "redirect", path: "/dashboard" });
  });
  it("leaves the teacher app and shared APIs untouched", () => {
    expect(main("/dashboard", true)).toEqual({ type: "pass" });
    expect(main("/", false)).toEqual({ type: "pass" });
    expect(main("/login", false)).toEqual({ type: "pass" });
    // console API is under /api (not /console) → still served on the main host,
    // guarded per-route by isPlatformAdminRequest().
    expect(main("/api/console/issues", true)).toEqual({ type: "pass" });
  });
});
