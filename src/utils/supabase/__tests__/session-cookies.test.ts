import { describe, it, expect } from "vitest";
import { sessionScoped } from "../session-cookies";

describe("sessionScoped — session-only login cookies", () => {
  it("drops a long-lived maxAge so the cookie becomes session-only", () => {
    expect(sessionScoped({ maxAge: 400 * 24 * 60 * 60, path: "/", sameSite: "lax" })).toEqual({
      path: "/",
      sameSite: "lax",
    });
  });
  it("KEEPS maxAge 0 so sign-out still deletes the cookie immediately", () => {
    expect(sessionScoped({ maxAge: 0, path: "/" })).toEqual({ maxAge: 0, path: "/" });
  });
  it("leaves options that have no maxAge untouched", () => {
    expect(sessionScoped({ path: "/", secure: true })).toEqual({ path: "/", secure: true });
  });
  it("tolerates undefined options", () => {
    expect(sessionScoped(undefined)).toEqual({});
  });
  it("does not mutate the caller's options object", () => {
    const input = { maxAge: 100, path: "/" };
    sessionScoped(input);
    expect(input).toEqual({ maxAge: 100, path: "/" });
  });
});
