import { describe, it, expect } from "vitest";
import {
  libraryRoute,
  libraryAllows,
  isGrantableLibraryRole,
  LIBRARY_LOGIN_PATH,
  LIBRARY_HOME,
  LIBRARY_ROLES,
  GRANTABLE_LIBRARY_ROLES,
} from "../library-routing";

const HOST = "library.sketchcast.app";
const MAIN = "app.sketchcast.app";
const CONSOLE = "console.sketchcast.app";

describe("libraryRoute — portal OFF (no host configured)", () => {
  const off = (path: string, hasUser: boolean, host = MAIN) =>
    libraryRoute({ libraryHostname: null, host, path, hasUser });

  it("the portal does not exist anywhere: its paths go to /dashboard", () => {
    expect(off("/library", true)).toEqual({ type: "redirect", path: "/dashboard" });
    expect(off("/library/topics/abc", true)).toEqual({ type: "redirect", path: "/dashboard" });
    expect(off("/library-login", false)).toEqual({ type: "redirect", path: "/dashboard" });
    // …on any host, including what would be the portal host.
    expect(off("/library", true, HOST)).toEqual({ type: "redirect", path: "/dashboard" });
  });
  it("leaves everything else alone", () => {
    for (const path of ["/", "/dashboard", "/login", "/console", "/staff-login", "/api/library/x", "/libraryish"]) {
      expect(off(path, true)).toEqual({ type: "pass" });
    }
  });
});

describe("libraryRoute — on the LIBRARY host", () => {
  const on = (path: string, hasUser: boolean) => libraryRoute({ libraryHostname: HOST, host: HOST, path, hasUser });

  it("serves the portal for a signed-in user", () => {
    expect(on("/library", true)).toEqual({ type: "pass" });
    expect(on("/library/topics/abc/questions", true)).toEqual({ type: "pass" });
  });
  it("sends a logged-out portal hit to the portal login — never the teacher or staff login", () => {
    expect(on("/library", false)).toEqual({ type: "redirect", path: LIBRARY_LOGIN_PATH });
    expect(on("/library/candidates", false)).toEqual({ type: "redirect", path: LIBRARY_LOGIN_PATH });
    expect(LIBRARY_LOGIN_PATH).not.toBe("/login");
    expect(LIBRARY_LOGIN_PATH).not.toBe("/staff-login");
  });
  it("always serves the portal login, shared auth handlers, and APIs", () => {
    expect(on(LIBRARY_LOGIN_PATH, false)).toEqual({ type: "pass" });
    expect(on("/auth/confirm", false)).toEqual({ type: "pass" });
    expect(on("/auth/signout", true)).toEqual({ type: "pass" });
    expect(on("/api/library/topics", true)).toEqual({ type: "pass" });
    expect(on("/api/console/ops", false)).toEqual({ type: "pass" }); // guarded per-route
  });
  it("bounces every other path into the portal world", () => {
    expect(on("/", true)).toEqual({ type: "redirect", path: LIBRARY_HOME });
    expect(on("/", false)).toEqual({ type: "redirect", path: LIBRARY_LOGIN_PATH });
    expect(on("/dashboard", true)).toEqual({ type: "redirect", path: LIBRARY_HOME });
    expect(on("/console", true)).toEqual({ type: "redirect", path: LIBRARY_HOME });
    expect(on("/staff-login", false)).toEqual({ type: "redirect", path: LIBRARY_LOGIN_PATH });
    expect(on("/login", false)).toEqual({ type: "redirect", path: LIBRARY_LOGIN_PATH });
  });
  it("treats the trailing-dot FQDN and a port as the portal host", () => {
    expect(libraryRoute({ libraryHostname: HOST, host: "Library.SketchCast.app.:443", path: "/library", hasUser: true })).toEqual({
      type: "pass",
    });
  });
  it("does not mistake a look-alike path for the portal", () => {
    // "/libraryish" is not under /library; on the portal host it is just "not
    // part of the portal" and gets bounced like any other stray path.
    expect(on("/libraryish", true)).toEqual({ type: "redirect", path: LIBRARY_HOME });
  });
});

describe("libraryRoute — on OTHER hosts while the portal is on", () => {
  it("the portal does not exist on the main host or the console host", () => {
    for (const host of [MAIN, CONSOLE]) {
      expect(libraryRoute({ libraryHostname: HOST, host, path: "/library", hasUser: true })).toEqual({ type: "redirect", path: "/dashboard" });
      expect(libraryRoute({ libraryHostname: HOST, host, path: "/library/topics", hasUser: true })).toEqual({ type: "redirect", path: "/dashboard" });
      expect(libraryRoute({ libraryHostname: HOST, host, path: LIBRARY_LOGIN_PATH, hasUser: false })).toEqual({ type: "redirect", path: "/dashboard" });
    }
  });
  it("leaves the teacher app, the console and the APIs untouched", () => {
    for (const path of ["/", "/dashboard", "/login", "/console", "/staff-login", "/api/library/topics"]) {
      expect(libraryRoute({ libraryHostname: HOST, host: MAIN, path, hasUser: true })).toEqual({ type: "pass" });
    }
  });
});

describe("roles", () => {
  it("admin is never grantable from the console — it is what platform_admins means", () => {
    expect(LIBRARY_ROLES).toContain("admin");
    expect([...GRANTABLE_LIBRARY_ROLES]).toEqual(["editor", "reviewer"]);
    expect(isGrantableLibraryRole("admin")).toBe(false);
    expect(isGrantableLibraryRole("editor")).toBe(true);
    expect(isGrantableLibraryRole("reviewer")).toBe(true);
    expect(isGrantableLibraryRole("")).toBe(false);
    expect(isGrantableLibraryRole(null)).toBe(false);
  });
  it("publishing to YouTube is admin-only", () => {
    expect(libraryAllows("admin", "publish")).toBe(true);
    expect(libraryAllows("editor", "publish")).toBe(false);
    expect(libraryAllows("reviewer", "publish")).toBe(false);
  });
  it("a reviewer can only approve", () => {
    expect(libraryAllows("reviewer", "approve")).toBe(true);
    for (const a of ["curate", "edit_article", "generate", "publish"] as const) {
      expect(libraryAllows("reviewer", a)).toBe(false);
    }
  });
  it("an editor does everything but publish", () => {
    for (const a of ["curate", "edit_article", "approve", "generate"] as const) {
      expect(libraryAllows("editor", a)).toBe(true);
    }
  });
  it("no role, no permission", () => {
    expect(libraryAllows(null, "approve")).toBe(false);
    expect(libraryAllows(undefined, "curate")).toBe(false);
  });
});
