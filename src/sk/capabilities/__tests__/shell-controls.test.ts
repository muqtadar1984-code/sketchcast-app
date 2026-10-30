/**
 * The model's safety net for the no-model commands (2026-10-30): start_tour,
 * tour_control, set_answer_language, repeat_in_language. Each handler only
 * describes the control; the turn route performs it as the rule does.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/shell-controls.test.ts
 */
import { describe, expect, it } from "vitest";
import { languageTarget, repeatInLanguage, setAnswerLanguage, startTour, tourControl, SHELL_CONTROL_CAPABILITIES } from "../shell-controls";
import { allowedFor } from "@/sk/shell/registry";
import { makeCtx } from "@/sk/shell/__tests__/fixtures";
import type { SkCapabilityDeps } from "@/sk/shell/types";

const deps = { session: { from: () => null, rpc: () => null }, now: new Date("2026-10-30T09:00:00Z") } as unknown as SkCapabilityDeps;
const ctx = makeCtx({ role: "teacher" });
const NAMES = ["start_tour", "tour_control", "set_answer_language", "repeat_in_language"];

describe("the handlers", () => {
  it("start_tour → walkthrough 'start'", async () => {
    expect(await startTour.handler(ctx, {}, deps)).toMatchObject({ ok: true, walkthrough: "start" });
  });
  it("tour_control → the action; anything else is refused", async () => {
    for (const action of ["resume", "next", "back", "pause", "skip"]) {
      expect(await tourControl.handler(ctx, { action }, deps), action).toMatchObject({ ok: true, walkthrough: action });
    }
    for (const action of ["start", "explode", "", undefined]) {
      const r = await tourControl.handler(ctx, { action }, deps);
      expect(r.ok, String(action)).toBe(false);
      expect(r.walkthrough).toBeUndefined();
    }
  });
  it("set_answer_language → a 'back' command; repeat_in_language → a 'repeat' command", async () => {
    expect(await setAnswerLanguage.handler(ctx, { language: "Arabic" }, deps)).toMatchObject({ ok: true, langCommand: { kind: "back", target: { code: "ar" } } });
    expect(await repeatInLanguage.handler(ctx, { language: "ms" }, deps)).toMatchObject({ ok: true, langCommand: { kind: "repeat", target: { code: "ms" } } });
    expect(await setAnswerLanguage.handler(ctx, { language: "my language" }, deps)).toMatchObject({ ok: true, langCommand: { kind: "back", target: { mine: true } } });
    const none = await repeatInLanguage.handler(ctx, {}, deps);
    expect(none.ok).toBe(false);
    expect(none.langCommand).toBeUndefined();
  });
  it("languageTarget: names, codes and own names; an unsupported one stays unsupported", () => {
    expect(languageTarget("Bahasa Melayu")).toEqual({ code: "ms" });
    expect(languageTarget("Jawi")).toEqual({ code: "ms-arab" });
    expect(languageTarget("zh-CN")).toEqual({ code: "zh" });
    expect(languageTarget("हिन्दी")).toEqual({ code: "hi" });
    expect(languageTarget("Français")).toEqual({ code: "fr" });
    expect(languageTarget("pt-BR")).toEqual({ code: "pt" });
    expect(languageTarget("Tamil")).toEqual({ unsupported: "tamil" });
    expect(languageTarget("Klingon")).toEqual({ unsupported: "klingon" });
    expect(languageTarget("")).toBeNull();
    expect(languageTarget(42)).toBeNull();
  });
});

describe("who sees them", () => {
  it("every role and every hat, with or without the sk flag", () => {
    for (const o of [
      { role: "teacher" },
      { role: "teacher", hat: "teacher" as const },
      { role: "student" },
      { role: "parent", hat: "parent" as const },
      { role: "school_admin", hat: "principal" as const },
      { role: "teacher", scope: [{ grade: "5", subject: null }], hat: "coordinator" as const },
      { role: "student", flags: { sk: false } },
    ]) {
      const names = allowedFor(makeCtx(o)).map((c) => c.meta.name);
      expect(names, JSON.stringify(o)).toEqual(expect.arrayContaining(NAMES));
    }
  });
  it("API-safe names, immediate tier, and descriptions that name the paraphrases", () => {
    expect(SHELL_CONTROL_CAPABILITIES.map((c) => c.meta.name)).toEqual(NAMES);
    for (const c of SHELL_CONTROL_CAPABILITIES) {
      expect(c.meta.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(c.meta.tier).toBe("immediate");
      // The system prompt lists these descriptions; "guided tour" is reserved
      // for the running-tour line (walkPromptLine).
      expect(c.meta.description).not.toContain("guided tour");
    }
    for (const w of ["shown around", "tour", "demo", "walkthrough", "onboarding"]) expect(startTour.meta.description).toContain(w);
    for (const w of ["resume", "next", "back", "pause", "skip"]) expect(tourControl.meta.description).toContain(w);
  });
});
