/**
 * 2026-10-30: the second, frame-stripped routing pass may navigate only when
 * the message still carries a move verb — "I want to know about the board" is
 * a question, "can you open the board please" is a move.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/intent-framed-nav.test.ts
 */
import { describe, expect, it } from "vitest";
import { routeByRules } from "../rules";
import { makeCtx } from "./fixtures";

const NOW = new Date("2026-10-28T08:30:00.000Z");

describe("framed messages navigate only with a move verb", () => {
  const ctx = makeCtx();
  it.each(["I want to know about the board", "I'd like to know about the diary", "can you tell me about analytics"])("%s → not a page move", (text) => {
    expect(routeByRules(text, ctx, NOW).intent).not.toBe("navigate");
  });
  it.each(["Hi SK, can you open the board please?", "please take me to the diary", "could you open analytics"])("%s → a page move", (text) => {
    expect(routeByRules(text, ctx, NOW).intent).toBe("navigate");
  });
});
