import { describe, it, expect } from "vitest";
import { schoolRoute, isPortalRole, SLUG_RE, RESERVED_SEGMENTS } from "../school-routing";

const HOST = "school.sketchcast.app";
const MAIN = "app.sketchcast.app";

describe("schoolRoute — feature OFF (no school host configured)", () => {
  it("passes everything through untouched", () => {
    for (const path of ["/", "/demo", "/demo/principal", "/dashboard", "/school/demo"]) {
      expect(schoolRoute({ schoolHostname: null, host: HOST, path })).toEqual({ type: "pass" });
    }
  });
});

describe("schoolRoute — on the MAIN host (feature on)", () => {
  it("never rewrites: tenant paths only exist on the school host", () => {
    for (const path of ["/", "/demo", "/demo/teacher", "/dashboard"]) {
      expect(schoolRoute({ schoolHostname: HOST, host: MAIN, path })).toEqual({ type: "pass" });
    }
  });
});

describe("schoolRoute — on the SCHOOL host", () => {
  const on = (path: string) => schoolRoute({ schoolHostname: HOST, host: HOST, path });

  it("rewrites / to the find-your-school page", () => {
    expect(on("/")).toEqual({ type: "rewrite", path: "/school" });
  });
  it("rewrites /{slug} and /{slug}/{role} into the internal /school routes", () => {
    expect(on("/demo")).toEqual({ type: "rewrite", path: "/school/demo" });
    expect(on("/demo/principal")).toEqual({ type: "rewrite", path: "/school/demo/principal" });
    expect(on("/st-marys-2")).toEqual({ type: "rewrite", path: "/school/st-marys-2" });
  });
  it("passes reserved app segments through (auth, api, post-login dashboards…)", () => {
    for (const seg of ["api", "auth", "dashboard", "login", "signup", "schoolsignup", "onboarding", "school"]) {
      expect(on(`/${seg}`)).toEqual({ type: "pass" });
      expect(on(`/${seg}/deeper/path`)).toEqual({ type: "pass" });
    }
  });
  it("passes non-slug-shaped segments (natural 404), instead of rewriting garbage", () => {
    for (const path of ["/Demo", "/-demo", "/demo_school", "/demo%20school", "/.well-known/x"]) {
      expect(on(path)).toEqual({ type: "pass" });
    }
  });
  it("treats the trailing-dot FQDN as the school host", () => {
    expect(schoolRoute({ schoolHostname: HOST, host: "school.sketchcast.app.", path: "/demo" })).toEqual({
      type: "rewrite",
      path: "/school/demo",
    });
    expect(schoolRoute({ schoolHostname: HOST, host: "School.SketchCast.app:443", path: "/demo" })).toEqual({
      type: "rewrite",
      path: "/school/demo",
    });
  });
});

describe("portal roles + slug shape", () => {
  it("accepts exactly the four portal roles", () => {
    for (const r of ["principal", "teacher", "student", "parent"]) expect(isPortalRole(r)).toBe(true);
    for (const r of ["admin", "coordinator", "", "PRINCIPAL"]) expect(isPortalRole(r)).toBe(false);
  });
  it("slug shape matches the DB constraint (0042 schools_slug_chk)", () => {
    for (const s of ["demo", "st-marys", "sk-taman-2"]) expect(SLUG_RE.test(s)).toBe(true);
    for (const s of ["-demo", "Demo", "demo school", ""]) expect(SLUG_RE.test(s)).toBe(false);
  });
  it("every top-level app segment is reserved (a school can never shadow a route)", () => {
    // If a new top-level route is added to src/app, add it to RESERVED_SEGMENTS.
    for (const seg of ["api", "auth", "console", "dashboard", "invite", "login", "signup", "schoolsignup", "onboarding", "staff-login", "school"]) {
      expect(RESERVED_SEGMENTS.has(seg)).toBe(true);
    }
  });
});
