/**
 * markup.ts — tool-call markup never reaches the bubble, the voice or the
 * memory (production 2026-10-30: the reply was an `invoke` element naming
 * board.explain_selection, and nothing else).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/markup.test.ts
 */
import { describe, expect, it } from "vitest";
import { COULD_NOT_DO, cleanReply, stripToolMarkup } from "../markup";

// Tags are built, not typed, so the test reads the way a model writes them.
const open = (tag: string, attrs = "") => `<${tag}${attrs ? ` ${attrs}` : ""}>`;
const close = (tag: string) => `</${tag}>`;
const el = (tag: string, attrs: string, inner: string) => `${open(tag, attrs)}${inner}${close(tag)}`;
const PRODUCTION = el("invoke", 'name="board.explain_selection"', " ");

describe("stripToolMarkup", () => {
  it("the production reply strips to nothing", () => {
    expect(stripToolMarkup(PRODUCTION)).toEqual({ text: "", stripped: true });
  });

  it("whole blocks go with their parameters, nested or not; the words around them stay", () => {
    const call = el("function_calls", "", `\n${el("invoke", 'name="board.page"', `\n${el("parameter", 'name="to"', "next")}\n`)}\n`);
    expect(stripToolMarkup(`Here is page 31.\n${call}\nAnything else?`)).toEqual({ text: "Here is page 31.\nAnything else?", stripped: true });
    expect(stripToolMarkup(`Done.${el("invoke", 'name="x"', el("parameter", 'name="a"', "1"))} Next?`).text).toBe("Done. Next?");
  });

  it("a namespaced form, stray tags and a tag cut off at the end", () => {
    const ns = el("antml:invoke", 'name="kit.documents"', el("antml:parameter", 'name="doc"', "deck"));
    expect(stripToolMarkup(`Reading it. ${ns}`).text).toBe("Reading it.");
    expect(stripToolMarkup(`${close("invoke")} Page 31. ${open("parameter", 'name="to"')}`).text).toBe("Page 31.");
    expect(stripToolMarkup('Moving on. <invoke name="board.page"').text).toBe("Moving on.");
    expect(stripToolMarkup(`${el("tool_use", "", '{"name":"board.page"}')}`).text).toBe("");
  });

  it("ordinary text — and the tool results' own data element — is untouched", () => {
    for (const t of ["Page 31 / 54.", "Use a < b and b > c.", "The <b>bold</b> word.", "I can't do that just now."]) expect(stripToolMarkup(t)).toEqual({ text: t, stripped: false });
  });
});

describe("cleanReply", () => {
  it("nothing left → the honest line in her language, and the warning is told once", () => {
    let warned = 0;
    expect(cleanReply(PRODUCTION, "en", () => warned++)).toBe(COULD_NOT_DO.en);
    expect(cleanReply(PRODUCTION, "ms")).toBe(COULD_NOT_DO.ms);
    expect(cleanReply(PRODUCTION, "zz")).toBe(COULD_NOT_DO.en);
    expect(warned).toBe(1);
  });
  it("words left → the words; no markup → the text as it was, no warning", () => {
    let warned = 0;
    expect(cleanReply(`Page 31. ${PRODUCTION}`, "en", () => warned++)).toBe("Page 31.");
    expect(cleanReply("Page 31.", "en", () => warned++)).toBe("Page 31.");
    expect(warned).toBe(1);
  });
  it("the honest line exists in all ten locales", () => {
    expect(Object.keys(COULD_NOT_DO).sort()).toEqual(["ar", "en", "es", "fr", "hi", "mr", "ms", "ms-arab", "pt", "te"]);
  });
});
