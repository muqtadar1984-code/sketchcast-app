// SK B2 — the board's DOM gate (plan §14): tags and attributes are
// allow-listed, image sources are local paths, nothing can carry a script,
// a style, a handler or an external reference onto the board. The checks are
// pure, so they run without a DOM.
import { describe, expect, it } from "vitest";
import { ALLOWED_ATTRS, ALLOWED_TAGS, assertAttr, assertImageHref, assertTag, BoardError } from "../dom";

describe("tags", () => {
  it("allows the drawing primitives and nothing that executes or embeds", () => {
    for (const t of ["svg", "g", "path", "text", "image", "mask"]) expect(() => assertTag(t)).not.toThrow();
    for (const t of ["foreignObject", "script", "a", "use", "style", "iframe", "animate", "set"]) expect(() => assertTag(t)).toThrow(BoardError);
    expect(ALLOWED_TAGS.has("foreignObject")).toBe(false);
  });
});

describe("attributes", () => {
  it("refuses handlers, style, href and anything outside the allow-list", () => {
    for (const k of ["onload", "onclick", "style", "href", "xlink:href", "filter", "clip-path", "xmlns", "class"]) expect(() => assertAttr(k, "x")).toThrow(BoardError);
    expect(ALLOWED_ATTRS.has("onload")).toBe(false);
    expect(ALLOWED_ATTRS.has("style")).toBe(false);
  });
  it("accepts numbers only when finite", () => {
    expect(() => assertAttr("x", 12.5)).not.toThrow();
    expect(() => assertAttr("x", Number.NaN)).toThrow(BoardError);
    expect(() => assertAttr("cy", Number.POSITIVE_INFINITY)).toThrow(BoardError);
  });
  it("keeps url() to an internal mask reference", () => {
    expect(() => assertAttr("mask", "url(#b-mask-mic)")).not.toThrow();
    expect(() => assertAttr("mask", "url(https://evil.example/m.svg#m)")).toThrow(BoardError);
    expect(() => assertAttr("mask", "url(#x) url(javascript:1)")).toThrow(BoardError);
    expect(() => assertAttr("fill", "url(#grad)")).toThrow(BoardError);
    expect(() => assertAttr("fill", "url(javascript:alert(1))")).toThrow(BoardError);
  });
  it("validates colours, ids, keywords and geometry strings", () => {
    expect(() => assertAttr("fill", "#14181F")).not.toThrow();
    expect(() => assertAttr("stroke", "none")).not.toThrow();
    expect(() => assertAttr("fill", "red; background: url(x)")).toThrow(BoardError);
    expect(() => assertAttr("data-id", "w1")).not.toThrow();
    expect(() => assertAttr("data-id", 'w1" onload="alert(1)')).toThrow(BoardError);
    expect(() => assertAttr("id", "<svg>")).toThrow(BoardError);
    expect(() => assertAttr("text-anchor", "start")).not.toThrow();
    expect(() => assertAttr("text-anchor", "start;x")).toThrow(BoardError);
    expect(() => assertAttr("transform", "translate(1.5 2) rotate(-9 10 10) scale(-0.5 0.5)")).not.toThrow();
    expect(() => assertAttr("transform", "url(#x)")).toThrow(BoardError);
    expect(() => assertAttr("d", "M0 0L10 10z")).not.toThrow();
    expect(() => assertAttr("d", "M0 0<script>")).toThrow(BoardError);
    expect(() => assertAttr("font-family", "Caveat, ui-sans-serif")).not.toThrow();
    expect(() => assertAttr("font-family", "x;src:url(y)")).toThrow(BoardError);
    expect(() => assertAttr("width", "100%")).not.toThrow();
    expect(() => assertAttr("width", "calc(100vw)")).toThrow(BoardError);
  });
});

describe("image sources", () => {
  it("accepts a site-local path and refuses everything else", () => {
    expect(() => assertImageHref("/sk/rig/sk-a/body.png")).not.toThrow();
    expect(() => assertImageHref("/sk/figures/light_microscope.png")).not.toThrow();
    for (const bad of ["https://evil.example/x.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "/sk/rig/../../etc/passwd.png", "//cdn.example/x.png", "sk/rig/x.png", "/x.svg", "/x.png?x=1", ""]) {
      expect(() => assertImageHref(bad), bad).toThrow(BoardError);
    }
  });
});
