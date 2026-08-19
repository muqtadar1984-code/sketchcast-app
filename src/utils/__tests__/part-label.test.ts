import { describe, expect, it } from "vitest";
import {
  cleanPartTitles,
  partAnchor,
  partHeading,
  partLabel,
  partOrdinal,
  type PartLabelMessages,
} from "../part-label";
import { LOCALES, type Locale } from "@/i18n/locales";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import te from "@/i18n/messages/te.json";
import mr from "@/i18n/messages/mr.json";
import hi from "@/i18n/messages/hi.json";
import msArab from "@/i18n/messages/ms-arab.json";

// The rule this file exists to defend, verbatim from the founder: "ensure that
// all parts carry the chapter name and part number and not just say part 1,
// part 2 etc". The Library card broke it by computing `titles[0] || "Part N"`,
// so the case that matters most — a part with no usable heading, which is the
// commonest case in production — rendered as exactly the forbidden string.
//
// These are the same cases as the worker's tests for shared/part_label.py. The
// two implementations are a mirrored pair; a test that only covers one of them
// is how they drifted apart in the first place.

const FSI = "\u2068";
const PDI = "\u2069";
/** What the reader sees: the isolates are invisible, so assertions strip them. */
const seen = (s: string) => s.split(FSI).join("").split(PDI).join("");

/** The four strings partLabel needs, and nothing else. Typed as a Pick of the
 *  English shape rather than the whole `typeof en`: a locale file is a SUBSET
 *  of English by contract (i18n/dictionaries.ts layers English underneath it),
 *  so demanding the complete dictionary here turned every English string that
 *  had not been translated yet — anywhere in the file, in any section — into a
 *  type error in a test that reads four keys. */
type PartLabelSource = {
  library: Pick<typeof en.library, "partOfTotal" | "partAnchored" | "partAnchoredTitled" | "untitled">;
};

const M = (m: PartLabelSource): PartLabelMessages => ({
  partOfTotal: m.library.partOfTotal,
  partAnchored: m.library.partAnchored,
  partAnchoredTitled: m.library.partAnchoredTitled,
  untitled: m.library.untitled,
});

const T = M(en);

const CATALOGUES: Record<Locale, PartLabelMessages> = {
  en: M(en),
  ms: M(ms),
  ar: M(ar),
  fr: M(fr),
  es: M(es),
  pt: M(pt),
  te: M(te),
  mr: M(mr),
  hi: M(hi),
  "ms-arab": M(msArab),
};

describe("partHeading", () => {
  it("takes the first heading that names something", () => {
    expect(partHeading(["Balancing loops", "Reinforcing loops"], "Feedback Loops")).toBe("Balancing loops");
  });

  it("drops the structurer's placeholders — the ones that were 47% of production", () => {
    for (const junk of ["Content", "contents", "TEXT", "body", "Untitled", "Chapter", "section"]) {
      expect(partHeading([junk], "Cells")).toBeNull();
    }
  });

  it("drops bare numerals, including the forms the old card-local filter missed", () => {
    for (const junk of ["1", "1.2", "(4)", "1 - ", "3 — ", "2 – 4"]) {
      expect(partHeading([junk], "Cells")).toBeNull();
    }
  });

  it("drops a heading that only echoes the chapter title", () => {
    expect(partHeading(["  cells  "], "Cells")).toBeNull();
    expect(partHeading(["Cells", "What a cell is"], "Cells")).toBe("What a cell is");
  });

  it("collapses whitespace in what it returns", () => {
    expect(partHeading(["  Balancing   loops "], "")).toBe("Balancing loops");
  });

  it("is null for an empty list — the case the worker now writes", () => {
    expect(partHeading([], "Cells")).toBeNull();
    expect(partHeading(null, "Cells")).toBeNull();
  });
});

describe("cleanPartTitles", () => {
  it("keeps the showable ones in order, deduped, capped", () => {
    expect(cleanPartTitles(["1", "Content", "A", "A", "B", "C", "D"], "Cells")).toEqual(["A", "B", "C"]);
  });

  it("honours an explicit limit", () => {
    expect(cleanPartTitles(["A", "B", "C"], "", 2)).toEqual(["A", "B"]);
  });
});

describe("partOrdinal", () => {
  it("names the part AND its place", () => {
    expect(partOrdinal(T, 3, 7)).toBe("Part 3 of 7");
  });

  it("is null for a single-part chapter — 'Part 1 of 1' is noise", () => {
    expect(partOrdinal(T, 1, 1)).toBeNull();
  });

  it("is null when the total is unknown, rather than emitting a bare ordinal", () => {
    expect(partOrdinal(T, 3, 0)).toBeNull();
    expect(partOrdinal(T, 3, Number.NaN)).toBeNull();
  });

  it("is null for a nonsense part number", () => {
    expect(partOrdinal(T, 0, 7)).toBeNull();
  });
});

describe("partAnchor — the string that keeps the founder's rule", () => {
  it("carries the chapter name with the number", () => {
    expect(seen(partAnchor(T, "Feedback Loops", 3, 7))).toBe("Feedback Loops · Part 3 of 7");
  });

  it("degrades to the plain chapter name for a single-part chapter", () => {
    expect(seen(partAnchor(T, "Feedback Loops", 1, 1))).toBe("Feedback Loops");
  });

  it("falls back to the localised untitled name, never to a bare ordinal", () => {
    expect(seen(partAnchor(T, "   ", 3, 7))).toBe("Untitled lesson · Part 3 of 7");
  });

  it("is never a bare ordinal for ANY part of ANY multi-part chapter", () => {
    // The regression, stated as a property: whatever k and n are, the label
    // must not be the string the rule forbids.
    for (let n = 2; n <= 30; n++) {
      for (let k = 1; k <= n; k++) {
        const label = seen(partAnchor(T, "Cells", k, n));
        expect(label).not.toBe(`Part ${k}`);
        expect(label.startsWith("Cells")).toBe(true);
      }
    }
  });
});

describe("partLabel — the mirror of shared/part_label.py", () => {
  it("appends the heading when there is one", () => {
    expect(
      seen(partLabel(T, { chapterTitle: "Feedback Loops", part: 3, total: 7, titles: ["Balancing loops"] })),
    ).toBe("Feedback Loops · Part 3 of 7 — Balancing loops");
  });

  it("stops at the anchor when no heading survives", () => {
    expect(
      seen(partLabel(T, { chapterTitle: "Feedback Loops", part: 3, total: 7, titles: ["Content", "2."] })),
    ).toBe("Feedback Loops · Part 3 of 7");
  });

  it("is the chapter name alone for a single-part chapter, heading or not", () => {
    expect(
      seen(partLabel(T, { chapterTitle: "Feedback Loops", part: 1, total: 1, titles: ["Balancing loops"] })),
    ).toBe("Feedback Loops");
  });
});

describe("bidi", () => {
  // Without isolation, "Part 3 of 7" (Latin + digits, LTR) beside an Arabic
  // chapter name (RTL) reorders against it inside an RTL paragraph, and the
  // label is visually wrong rather than merely untranslated.
  it("isolates every substituted run", () => {
    const label = partLabel(CATALOGUES.ar, {
      chapterTitle: "الخلايا والأنسجة",
      part: 3,
      total: 7,
      titles: ["Balancing loops"],
    });
    expect(label.split(FSI).length - 1).toBe(3); // chapter, ordinal, heading
    expect(label.split(PDI).length - 1).toBe(3);
    // Balanced and properly nested: every isolate is closed before the next opens.
    expect(label.replace(new RegExp(`${FSI}[^${FSI}${PDI}]*${PDI}`, "g"), "")).not.toContain(FSI);
  });

  it("does not isolate a label that has nothing to isolate", () => {
    expect(partAnchor(CATALOGUES.ar, "الخلايا", 1, 1)).toBe("الخلايا");
  });
});

describe("every locale", () => {
  const codes = LOCALES.map((l) => l.value);

  it.each(codes)("%s composes a label that carries the chapter name and both numbers", (code) => {
    const t = CATALOGUES[code];
    const label = seen(partAnchor(t, "Feedback Loops", 3, 7));
    expect(label).toContain("Feedback Loops");
    expect(label).toContain("3");
    expect(label).toContain("7");
    // And it is translated: only English may read "Part 3 of 7".
    if (code !== "en") expect(label).not.toContain("Part 3 of 7");
  });

  it.each(codes)("%s leaves no unfilled placeholder", (code) => {
    const label = partLabel(CATALOGUES[code], {
      chapterTitle: "Feedback Loops",
      part: 3,
      total: 7,
      titles: ["Balancing loops"],
    });
    expect(label).not.toMatch(/\{\w+\}/);
  });
});
