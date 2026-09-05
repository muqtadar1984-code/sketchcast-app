/**
 * What a click COSTS, as the controls describe it.
 *
 * The bug this pins: "documents free, one credit per rendered lesson part" sat
 * on the Generate-full-kit tooltip in all ten locales, and "Generate (n) — free"
 * on the add-back button, long after 0075 made every artefact a credit. A
 * Teacher Pro clicking four kits spends 24 of 28 credits; the control told them
 * they had spent four. Since 0103 exactly ONE piece of the kit is free — the
 * slide deck — and that is the only free claim any of this copy may make.
 *
 * The same sentence lives in three places (the i18n hint, and two hardcoded
 * English title= attributes on per-part rows), which is how one of them was
 * updated and the others were not. All three are checked here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import en from "../i18n/messages/en.json";
import ms from "../i18n/messages/ms.json";
import ar from "../i18n/messages/ar.json";
import fr from "../i18n/messages/fr.json";
import es from "../i18n/messages/es.json";
import pt from "../i18n/messages/pt.json";
import te from "../i18n/messages/te.json";
import mr from "../i18n/messages/mr.json";
import hi from "../i18n/messages/hi.json";
import msArab from "../i18n/messages/ms-arab.json";

const LOCALES = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as const;

/** The clause every surface that prices a kit click must carry. Compared
 * case-insensitively only because it starts a sentence in one of them. */
const BILLING_CLAUSE = "the slide deck is free; every other piece costs one credit";
const carriesClause = (s: string) => s.toLowerCase().includes(BILLING_CLAUSE);

const src = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf-8");

describe("kit billing copy", () => {
  it("the English kit hint prices the click correctly", () => {
    const hint = en.library.kit.generateFullKitHint;
    expect(carriesClause(hint), "kit hint lost the billing clause").toBe(true);
    // The claim that was false for a year, in both spellings it appeared in.
    expect(hint).not.toContain("documents free");
    expect(hint).not.toContain("documents are free");
    // A chapter-length lesson is charged per rendered part, and the tooltip has
    // to say so or the biggest charge on the screen is the unexplained one.
    expect(hint).toContain("one per rendered part");
    // All seven pieces are named, so the reader can count what they are buying.
    for (const piece of ["slide deck", "plan", "activities", "worksheet", "test paper", "case study"]) {
      expect(hint, `hint does not name the ${piece}`).toContain(piece);
    }
  });

  it("the add-back button no longer calls a charged click free", () => {
    // pendingKinds (chapter-generate.tsx) offers the deck AND the five
    // documents; five of those six are a credit each, so the LABEL cannot say
    // "free". Structural, so it holds in every language: the label is the verb
    // plus the count, with no qualifier clause hanging off a dash.
    for (const [loc, msgs] of Object.entries(LOCALES)) {
      const label = msgs.library.kit.generateFree;
      expect(label, `${loc}: label must carry the count`).toContain("{n}");
      expect(label, `${loc}: label must not qualify itself`).not.toMatch(/[—–]/);
    }
    expect(en.library.kit.generateFree).toBe("Generate ({n})");
    expect(carriesClause(en.library.kit.generateFreeHint), "add-back hint lost the clause").toBe(true);
  });

  it("the fair-use meter and the kit hint agree about the free piece", () => {
    // The meter enumerates the six BILLABLE kinds — the same six
    // credit_ledger_write names — and now says which piece is not among them.
    const kitFree = en.fairUse.kitFree;
    for (const kind of ["lesson", "plan", "activities", "worksheet", "test paper", "case study"]) {
      expect(kitFree, `meter does not name ${kind}`).toContain(kind);
    }
    expect(kitFree).toContain("The slide deck is free.");
  });

  it("the two hardcoded per-part tooltips carry the same clause as the i18n one", () => {
    // These are English title= attributes on generate-kit-button.tsx, duplicated
    // once for each of the two button shapes. They drifted from the translated
    // hint once already.
    const file = src("app/dashboard/generate-kit-button.tsx");
    const titles = [...file.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
    expect(titles.length).toBe(2);
    for (const title of titles) {
      expect(carriesClause(title), "tooltip lost the billing clause").toBe(true);
      expect(title).not.toContain("documents free");
    }
    expect(new Set(titles).size, "the two tooltips must stay identical").toBe(1);
  });

  it("the whole-book confirm says the deck is the free one", () => {
    // generate-all-button.tsx queues a kit per chapter part behind a confirm();
    // it is the single largest spend in the product.
    const file = src("app/dashboard/generate-all-button.tsx");
    expect(file).toContain("The deck is free; every other item costs one credit");
    expect(file).not.toContain("documents are free");
  });

  it("no user-facing string anywhere claims documents are free", () => {
    for (const [loc, msgs] of Object.entries(LOCALES)) {
      const flat = JSON.stringify(msgs).toLowerCase();
      for (const lie of ["documents free", "documents are free", "document kit is free"]) {
        expect(flat, `${loc} still says "${lie}"`).not.toContain(lie);
      }
    }
  });
});
