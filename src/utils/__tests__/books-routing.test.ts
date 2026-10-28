import { describe, it, expect } from "vitest";
import { booksRoute, booksAllows, strongestRole, BOOKS_LOGIN_PATH, BOOKS_HOME } from "../books-routing";

const HOST = "books.sketchcast.app";
const MAIN = "app.sketchcast.app";

describe("booksRoute — app OFF (no host configured)", () => {
  const off = (path: string, hasUser: boolean, host = MAIN) => booksRoute({ booksHostname: null, host, path, hasUser });

  it("the book app does not exist anywhere", () => {
    expect(off("/books", true)).toEqual({ type: "redirect", path: "/dashboard" });
    expect(off("/books/cells", true, HOST)).toEqual({ type: "redirect", path: "/dashboard" });
    expect(off(BOOKS_LOGIN_PATH, false)).toEqual({ type: "redirect", path: "/dashboard" });
  });
  it("leaves everything else alone", () => {
    for (const path of ["/", "/dashboard", "/library", "/console", "/bookshelf", "/api/books/x"]) {
      expect(off(path, true)).toEqual({ type: "pass" });
    }
  });
});

describe("booksRoute — app ON", () => {
  const on = (path: string, hasUser: boolean, host = HOST) => booksRoute({ booksHostname: HOST, host, path, hasUser });

  it("serves the app to signed-in users on its host", () => {
    expect(on("/books", true)).toEqual({ type: "pass" });
    expect(on("/books/cells/chapters/3", true)).toEqual({ type: "pass" });
  });
  it("sends signed-out visitors to the book-app login, never the teacher login", () => {
    expect(on("/books", false)).toEqual({ type: "redirect", path: BOOKS_LOGIN_PATH });
    expect(on("/", false)).toEqual({ type: "redirect", path: BOOKS_LOGIN_PATH });
    expect(on("/login", false)).toEqual({ type: "redirect", path: BOOKS_LOGIN_PATH });
  });
  it("bounces other paths on its host into the app", () => {
    expect(on("/dashboard", true)).toEqual({ type: "redirect", path: BOOKS_HOME });
  });
  it("lets auth, api and the login through", () => {
    for (const path of ["/auth/signout", "/api/pub/file", BOOKS_LOGIN_PATH]) expect(on(path, false)).toEqual({ type: "pass" });
  });
  it("matches the host however it is written", () => {
    expect(on("/books", true, "Books.SketchCast.app.:443")).toEqual({ type: "pass" });
  });
  it("hides the app on every other host", () => {
    expect(on("/books", true, MAIN)).toEqual({ type: "redirect", path: "/dashboard" });
    expect(on(BOOKS_LOGIN_PATH, false, MAIN)).toEqual({ type: "redirect", path: "/dashboard" });
    expect(on("/dashboard", true, MAIN)).toEqual({ type: "pass" });
  });
});

describe("roles", () => {
  it("only owners grant; reviewers only read and report", () => {
    expect(booksAllows("owner", "grant")).toBe(true);
    expect(booksAllows("approver", "grant")).toBe(false);
    expect(booksAllows("approver", "approve")).toBe(true);
    expect(booksAllows("editor", "approve")).toBe(false);
    expect(booksAllows("reviewer", "run")).toBe(false);
    expect(booksAllows("reviewer", "read")).toBe(true);
    expect(booksAllows(null, "read")).toBe(false);
  });
  it("the strongest grant wins", () => {
    expect(strongestRole(["reviewer", "approver"])).toBe("approver");
    expect(strongestRole([])).toBeNull();
  });
});
