/**
 * SK's walkthrough (founder 2026-10-30): the "Show me around" rule (no model,
 * every app language, anchored so a real question is never taken for it), its
 * fixed reply held equal to the tour's own copy, and every line the stops can
 * say present in all ten message files.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/walkthrough-rule.test.ts
 */
import { describe, expect, it } from "vitest";
import { isWalkthroughRequest, routeByRules } from "../rules";
import { WALKTHROUGH_START } from "../walkthrough-lines";
import { NOW, makeCtx } from "./fixtures";
import { WALK_ROLES, WALK_STOPS, lineKeysFor } from "@/sk/walkthrough/stops";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import msArab from "@/i18n/messages/ms-arab.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import hi from "@/i18n/messages/hi.json";
import mr from "@/i18n/messages/mr.json";
import te from "@/i18n/messages/te.json";

const FILES = { en, ms, "ms-arab": msArab, ar, fr, es, pt, hi, mr, te } as const;

describe("isWalkthroughRequest: the replay phrase", () => {
  it("English phrasings", () => {
    for (const t of ["Show me around", "show me around please", "Give me the tour", "give me a demo", "Take the tour", "start the tour again", "demo", "the tour", "walk me through the app"]) {
      expect(isWalkthroughRequest(t), t).toBe(true);
    }
  });
  it("the phrase each language's last stop teaches", () => {
    for (const t of ["Tunjukkan sekeliling", "tunjukkan saya", "تونجوقکن سکليليڠ", "عرّفني بالمكان", "خذني في جولة", "Fais-moi visiter", "Enséñame la app", "Me mostra o app", "मुझे सब दिखाओ", "मला सगळे दाखव", "నాకు అన్నీ చూపించు"]) {
      expect(isWalkthroughRequest(t), t).toBe(true);
    }
  });
  it("a real question is never the tour", () => {
    for (const t of ["show me around the cell membrane", "what is a tour of duty", "show me my analytics", "how are my classes", "explain photosynthesis", "tour the solar system with me"]) {
      expect(isWalkthroughRequest(t), t).toBe(false);
    }
  });
  it("routeByRules decides it with no model, for every role", () => {
    for (const role of ["teacher", "student", "parent", "school_admin"]) {
      expect(routeByRules("Show me around", makeCtx({ role }), NOW).intent).toBe("tour");
    }
    expect(routeByRules("show me the diary", makeCtx({ role: "teacher" }), NOW).intent).toBe("navigate");
  });
  it("the reply is the tour's own start line, in every locale", () => {
    for (const [code, file] of Object.entries(FILES)) {
      expect(WALKTHROUGH_START[code], code).toBe(file.sk.walkthrough.ui.startLine);
    }
  });
});

describe("every line, chip and Example card the tour can show is in all ten files", () => {
  it("lines per role", () => {
    for (const [code, file] of Object.entries(FILES)) {
      for (const role of WALK_ROLES) {
        const table = file.sk.walkthrough[role] as Record<string, string>;
        for (const key of lineKeysFor(role)) expect(table[key]?.trim(), `${code} sk.walkthrough.${role}.${key}`).toBeTruthy();
      }
    }
  });
  it("chips and demos the stops name", () => {
    for (const [code, file] of Object.entries(FILES)) {
      for (const defs of Object.values(WALK_STOPS)) {
        for (const d of defs) {
          for (const c of d.chips ?? []) expect(file.sk.walkthrough.chips[c]?.trim(), `${code} chips.${c}`).toBeTruthy();
          if (d.demo) {
            const demo = file.sk.walkthrough.demo[d.demo];
            expect(demo.title.trim(), `${code} demo.${d.demo}.title`).toBeTruthy();
            // Every row is "Label: value".
            for (const row of demo.rows.split("\n")) expect(row.indexOf(": "), `${code} demo.${d.demo}: ${row}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });
  it("credits are never quoted as a number (founder decision 11)", () => {
    for (const [code, file] of Object.entries(FILES)) {
      expect(file.sk.walkthrough.demo.lessonPrepare.rows, code).not.toMatch(/[0-9٠-٩०-९౦-౯]+\s*(?:credit|kredit|رصيد|crédit|crédito|क्रेडिट|క్రెడిట్)/iu);
    }
  });
});
