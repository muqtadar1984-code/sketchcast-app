import { describe, expect, it } from "vitest";
import {
  activePaidEntitlements,
  buildFinancialsCsv,
  collectedUsd,
  conversionScenario,
  csvField,
  fmtUsd,
  kitCostStats,
  kitKey,
  modelBucket,
  modelRouteBreakdown,
  mrrUsd,
  MYR_PER_USD,
  SCHOOL_BANDS,
  bandForStudents,
  type EntitlementRow,
  type FinGenRow,
  type FinJobRow,
} from "../financials";

// These numbers go in front of investors and partners via screenshot and CSV.
// The expensive mistake is a figure that flatters us — an average diluted by
// untracked rows, a kit split that double-counts — so the tests pin exactly
// which rows count toward which number.

function gen(id: string, over: Partial<FinGenRow> = {}): FinGenRow {
  return { id, book_id: "book-1", chapter_ref: "3", params: {}, ...over };
}

function job(generation_id: string | null, cost?: number): FinJobRow {
  return { generation_id, usage: cost === undefined ? null : { cost_usd: cost } };
}

// (grossEstimateUsd and friends are imported lazily below to keep the existing
// import block untouched by the 2026-08-18 additions.)
import { PLAN_KITS_PER_MONTH, SCHOOL_CURRICULUM_KITS_PER_YEAR, grossMarginPct, fmtPct } from "../financials";

describe("kitKey / kit grouping", () => {
  it("groups generations of the same (book, chapter, part) into one kit", () => {
    const a = gen("g1", { params: { part: 1 } });
    const b = gen("g2", { params: { part: 1 } });
    expect(kitKey(a)).toBe(kitKey(b));
  });

  it("separates parts of the same chapter — each part is its own kit (and its own credit)", () => {
    expect(kitKey(gen("g1", { params: { part: 1 } }))).not.toBe(kitKey(gen("g2", { params: { part: 2 } })));
  });

  it("treats a missing part as part 0 — pre-parts generations must not shatter into phantom kits", () => {
    expect(kitKey(gen("g1", { params: {} }))).toBe(kitKey(gen("g2", { params: { part: "0" } })));
    expect(kitKey(gen("g3", { params: null }))).toBe(kitKey(gen("g4", { params: { part: 0 } })));
  });

  it("separates chapters and books", () => {
    expect(kitKey(gen("g1", { chapter_ref: "3" }))).not.toBe(kitKey(gen("g2", { chapter_ref: "4" })));
    expect(kitKey(gen("g1", { book_id: "book-1" }))).not.toBe(kitKey(gen("g2", { book_id: "book-2" })));
  });
});

describe("kitCostStats", () => {
  it("sums job costs across a kit's generations", () => {
    const gens = [gen("g1", { params: { part: 1 } }), gen("g2", { params: { part: 1 } })];
    const jobs = [job("g1", 0.1), job("g1", 0.05), job("g2", 0.15)];
    const s = kitCostStats(gens, jobs);
    expect(s.kits).toBe(1);
    expect(s.generations).toBe(2);
    expect(s.avgPerKitUsd).toBeCloseTo(0.3, 10);
    expect(s.avgPerGenUsd).toBeCloseTo(0.15, 10);
  });

  it("keeps untracked rows OUT of the averages but IN the counts — missing usage must not dilute the average toward zero", () => {
    const gens = [
      gen("g1", { params: { part: 1 } }), // costed
      gen("g2", { params: { part: 2 } }), // job exists but has no usage
      gen("g3", { params: { part: 3 } }), // no jobs at all
    ];
    const jobs = [job("g1", 0.2), job("g2")];
    const s = kitCostStats(gens, jobs);
    expect(s.kits).toBe(3);
    expect(s.generations).toBe(3);
    expect(s.costedKits).toBe(1);
    expect(s.costedGens).toBe(1);
    expect(s.avgPerKitUsd).toBeCloseTo(0.2, 10); // NOT 0.2/3
    expect(s.avgPerGenUsd).toBeCloseTo(0.2, 10);
  });

  it("counts non-generation-linked cost (book indexing) in AI spend but never in kit averages", () => {
    const gens = [gen("g1")];
    const jobs = [job("g1", 0.1), job(null, 0.4)];
    const s = kitCostStats(gens, jobs);
    expect(s.aiSpendUsd).toBeCloseTo(0.5, 10);
    expect(s.avgPerKitUsd).toBeCloseTo(0.1, 10);
  });

  it("returns null averages when nothing is tracked, rather than 0 (which would read as 'free')", () => {
    const s = kitCostStats([gen("g1")], [job("g1")]);
    expect(s.avgPerKitUsd).toBeNull();
    expect(s.avgPerGenUsd).toBeNull();
    expect(s.aiSpendUsd).toBe(0);
  });
});

describe("modelBucket", () => {
  it("buckets every claude-* model together and gemini-2.5-flash by name", () => {
    expect(modelBucket("claude-haiku-4-5")).toBe("Claude");
    expect(modelBucket("claude-sonnet-4-6")).toBe("Claude");
    expect(modelBucket("gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
  });

  it("labels null/missing as pre-tracking — most live rows predate coverage_model", () => {
    expect(modelBucket(null)).toBe("earlier models (pre-tracking)");
    expect(modelBucket(undefined)).toBe("earlier models (pre-tracking)");
    expect(modelBucket("")).toBe("earlier models (pre-tracking)");
  });

  it("passes an unknown route through by name instead of hiding it", () => {
    expect(modelBucket("kimi-k2")).toBe("kimi-k2");
  });
});

describe("modelRouteBreakdown", () => {
  it("averages per generation within each bucket, ignoring untracked generations", () => {
    const gens = [
      gen("g1", { params: { coverage_model: "gemini-2.5-flash" } }),
      gen("g2", { params: { coverage_model: "gemini-2.5-flash" } }), // untracked
      gen("g3", { params: { coverage_model: "claude-haiku-4-5" } }),
      gen("g4", { params: {} }), // pre-tracking
    ];
    const jobs = [job("g1", 0.2), job("g3", 0.6), job("g4", 1.0)];
    const rows = modelRouteBreakdown(gens, jobs);
    const byBucket = new Map(rows.map((r) => [r.bucket, r]));
    expect(byBucket.get("Gemini 2.5 Flash")).toMatchObject({ generations: 2, costedGens: 1 });
    expect(byBucket.get("Gemini 2.5 Flash")!.avgPerGenUsd).toBeCloseTo(0.2, 10);
    expect(byBucket.get("Claude")!.avgPerGenUsd).toBeCloseTo(0.6, 10);
    expect(byBucket.get("earlier models (pre-tracking)")!.totalUsd).toBeCloseTo(1.0, 10);
    // sorted by total spend, descending — the biggest line item leads
    expect(rows[0].bucket).toBe("earlier models (pre-tracking)");
  });
});

describe("entitlement revenue", () => {
  const now = Date.UTC(2026, 7, 17);
  function ent(plan_key: string, over: Partial<EntitlementRow> = {}): EntitlementRow {
    return {
      user_id: "u1",
      school_id: null,
      plan_key,
      active: true,
      status: "active",
      current_period_end: "2027-01-01T00:00:00Z",
      ...over,
    };
  }

  it("keeps only active + unexpired rows", () => {
    const rows = [
      ent("teacher_pro_monthly"),
      ent("teacher_pro_monthly", { active: false }),
      ent("teacher_pro_monthly", { current_period_end: "2026-01-01T00:00:00Z" }), // lapsed
      ent("teacher_pro_monthly", { current_period_end: null }), // no end = still on
    ];
    expect(activePaidEntitlements(rows, now)).toHaveLength(2);
  });

  it("prices annual plans at annual/12 so MRR means monthly", () => {
    expect(mrrUsd([ent("teacher_pro_monthly")])).toBe(24);
    expect(mrrUsd([ent("teacher_pro_annual")])).toBeCloseTo(20, 10);
    expect(mrrUsd([ent("teacher_pro_plus_monthly")])).toBe(49);
    expect(mrrUsd([ent("family_monthly")])).toBeCloseTo(9.99, 10);
    expect(mrrUsd([ent("school_annual")])).toBeCloseTo(250, 10);
  });

  it("prices the homeschool plans ($34/mo, $340/yr at annual/12)", () => {
    expect(mrrUsd([ent("homeschool_monthly")])).toBe(34);
    expect(mrrUsd([ent("homeschool_annual")])).toBeCloseTo(340 / 12, 10);
  });

  it("credit packs are NOT MRR — their keys price at 0 here", () => {
    // Packs are one-time purchases: they land in Collected to date via the
    // payments table, never in recurring revenue.
    expect(mrrUsd([ent("pack_6"), ent("pack_18"), ent("pack_36")])).toBe(0);
  });

  it("prices an unknown plan_key at 0 rather than guessing", () => {
    expect(mrrUsd([ent("mystery_plan")])).toBe(0);
  });
});

describe("collectedUsd", () => {
  it("counts only successful payments and converts MYR minor units", () => {
    const usd = collectedUsd([
      { amount: 2400, currency: "usd", status: "paid" },
      { amount: 43000, currency: "myr", status: "paid" }, // RM430 → $100 at 4.3
      { amount: 9900, currency: "usd", status: "refunded" }, // not collected
    ]);
    expect(usd).toBeCloseTo(24 + 43000 / 100 / MYR_PER_USD, 10);
  });
});

describe("bandForStudents — the founder's $3/5/7k rate card", () => {
  it("A up to 350, B to 700, C to 1,200 — boundaries exact", () => {
    expect(bandForStudents(1)?.usdPerYear).toBe(3000);
    expect(bandForStudents(350)?.usdPerYear).toBe(3000);
    expect(bandForStudents(351)?.usdPerYear).toBe(5000);
    expect(bandForStudents(700)?.usdPerYear).toBe(5000);
    expect(bandForStudents(701)?.usdPerYear).toBe(7000);
    expect(bandForStudents(1200)?.usdPerYear).toBe(7000);
  });

  it("above the top band prices at Band C (individually negotiated in reality)", () => {
    expect(bandForStudents(1500)?.usdPerYear).toBe(7000);
  });

  it("zero or garbage enrolment licenses nothing", () => {
    expect(bandForStudents(0)).toBeNull();
    expect(bandForStudents(-5)).toBeNull();
    expect(bandForStudents(NaN)).toBeNull();
  });

  it("the card itself: three bands at 3/5/7k", () => {
    expect(SCHOOL_BANDS.map((b) => b.usdPerYear)).toEqual([3000, 5000, 7000]);
    expect(SCHOOL_BANDS.map((b) => b.maxStudents)).toEqual([350, 700, 1200]);
  });
});

describe("conversionScenario", () => {
  it("rounds to whole teachers so the printed maths reproduces the figure", () => {
    // 36 teachers (today's live count) × 10% = 3.6 → 4 paying → 4 × $24 × 12
    expect(conversionScenario(36, 0.1)).toEqual({ paying: 4, annualUsd: 4 * 24 * 12 });
    expect(conversionScenario(36, 0.25)).toEqual({ paying: 9, annualUsd: 9 * 24 * 12 });
    expect(conversionScenario(36, 0.5)).toEqual({ paying: 18, annualUsd: 18 * 24 * 12 });
  });

  it("handles zero teachers", () => {
    expect(conversionScenario(0, 0.5)).toEqual({ paying: 0, annualUsd: 0 });
  });
});

describe("gross estimates (2026-08-18: revenue minus measured serving cost)", () => {
  it("pins the kit allowances the cost side assumes (0086 caps ÷ 6)", () => {
    expect(PLAN_KITS_PER_MONTH).toEqual({ teacher_pro: 4, teacher_pro_plus: 12, family: 2, homeschool: 8 });
  });

  it("pins the flat school cost basis (~940 chapter kits per school per year)", () => {
    expect(SCHOOL_CURRICULUM_KITS_PER_YEAR).toBe(940);
  });

  it("margin is a ratio — subscriber count cancels, so monthly and annual agree", () => {
    // Pro: $24/mo vs 4 kits × $2.11 = 64.83…% — same fraction at annual scale.
    expect(grossMarginPct(24, 4, 2.11)).toBeCloseTo((24 - 8.44) / 24, 6);
    expect(grossMarginPct(288, 48, 2.11)).toBeCloseTo(grossMarginPct(24, 4, 2.11)!, 10);
  });

  it("a loss-making band shows NEGATIVE, never clamped", () => {
    // Band A at a $4 kit: 940 kits = $3,760 against $3,000.
    expect(grossMarginPct(3000, 940, 4)).toBeCloseTo((3000 - 3760) / 3000, 6);
    expect(grossMarginPct(3000, 940, 4)!).toBeLessThan(0);
  });

  it("returns null (renders as —) for unmeasured cost or zero revenue", () => {
    expect(grossMarginPct(1000, 48, null)).toBeNull();
    expect(grossMarginPct(0, 48, 2.11)).toBeNull(); // a margin on nothing is not 100%
  });

  it("formats with one decimal, the memo convention", () => {
    expect(fmtPct(0.256)).toBe("25.6%");
    expect(fmtPct(-0.2533333)).toBe("-25.3%");
  });
});

describe("CSV building", () => {
  it("escapes commas and quotes — a title like 'Avg cost / kit, USD' must survive a spreadsheet round-trip", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("has, comma")).toBe('"has, comma"');
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
    expect(csvField(42)).toBe("42");
  });

  it("stacks sections with titles and assumption footers as comment lines", () => {
    const csv = buildFinancialsCsv([
      {
        title: "What a kit costs us",
        header: ["Metric", "Lifetime"],
        rows: [["Avg cost / kit, USD", "$0.258"]],
        footer: "Measured from jobs.usage. Demo accounts excluded.",
      },
      { title: "Actual revenue", header: ["Metric", "Total"], rows: [["MRR", "$0.00"]] },
    ]);
    expect(csv).toBe(
      [
        "# What a kit costs us",
        "Metric,Lifetime",
        '"Avg cost / kit, USD",$0.258',
        "# Measured from jobs.usage. Demo accounts excluded.",
        "",
        "# Actual revenue",
        "Metric,Total",
        "MRR,$0.00",
        "",
      ].join("\n"),
    );
  });
});

describe("fmtUsd", () => {
  it("keeps 3 decimals under a dollar (kit costs live there), 2 above", () => {
    expect(fmtUsd(0.258)).toBe("$0.258");
    expect(fmtUsd(2.11)).toBe("$2.11");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(1152)).toBe("$1,152.00");
    expect(fmtUsd(-3.5)).toBe("-$3.50");
  });
});
