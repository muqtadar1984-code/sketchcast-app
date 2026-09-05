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
import {
  PLAN_KITS_PER_MONTH,
  PLAN_KITS_COSTED_PER_MONTH,
  PLAN_GENERATION_CAPS,
  KIT_PIECES,
  KIT_CREDITS,
  SCHOOL_CURRICULUM_KITS_PER_YEAR,
  grossMarginPct,
  fmtPct,
} from "../financials";

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
  it("pins the ADVERTISED kit counts (0107 caps ÷ 7, the seven pieces)", () => {
    expect(PLAN_KITS_PER_MONTH).toEqual({ teacher_pro: 4, teacher_pro_plus: 12, family: 2, homeschool: 8 });
  });

  it("pins the caps and the two divisors a kit has", () => {
    expect(PLAN_GENERATION_CAPS).toEqual({ teacher_pro: 28, teacher_pro_plus: 84, family: 14, homeschool: 56 });
    expect(KIT_PIECES).toBe(7); // artefacts delivered
    expect(KIT_CREDITS).toBe(6); // artefacts CHARGED — the deck rides free (0103)
  });

  it("costs the allowance at caps ÷ 6, not the advertised ÷ 7", () => {
    // The bug this pins: 84 Pro+ credits fund 14 kits, and costing 12 of them
    // understates the allowance by exactly a sixth while the footer calls the
    // result "the conservative bound".
    for (const plan of ["teacher_pro", "teacher_pro_plus", "family", "homeschool"] as const) {
      expect(PLAN_KITS_COSTED_PER_MONTH[plan]).toBeCloseTo(PLAN_GENERATION_CAPS[plan] / KIT_CREDITS, 10);
      expect(PLAN_KITS_PER_MONTH[plan]).toBeCloseTo(PLAN_GENERATION_CAPS[plan] / KIT_PIECES, 10);
      // The cost basis is never below the advertised count, or the console
      // would be modelling a cheaper subscriber than the page promises.
      expect(PLAN_KITS_COSTED_PER_MONTH[plan]).toBeGreaterThan(PLAN_KITS_PER_MONTH[plan]);
    }
    expect(PLAN_KITS_COSTED_PER_MONTH.teacher_pro_plus).toBe(14);
    expect(PLAN_KITS_COSTED_PER_MONTH.homeschool).toBeCloseTo(56 / 6, 10);
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

// ── LTV and CAC (2026-08-22) ────────────────────────────────────────────────
// These tests exist because the business has almost no data: one subscription
// ever, cancelled inside the hour, and no recorded marketing spend at all. The
// expensive failure mode is not a wrong number, it is a CONFIDENT one — a $0.00
// CAC that reads as "acquisition is free", or an LTV built on a lifetime
// nobody measured. So the zero-data and insufficient-data paths are pinned
// harder than the happy paths.
import {
  AFFILIATE_COMMISSION_RATE,
  MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME,
  affiliateCac,
  affiliateCacForPlans,
  affiliateCommissionUsd,
  fmtMonths,
  fmtRatio,
  isConsumerSubscriptionPlan,
  isFinishedSubscriptionStatus,
  isPaidStatus,
  lifetimeEvidence,
  ltvToCac,
  measuredLifetimeMonths,
  minorUnitsToUsd,
  planCycleMonths,
  planLtv,
  resolveLifetime,
  type LifetimePaymentRow,
  type ReferralRow,
} from "../financials";

function ref(over: Partial<ReferralRow> = {}): ReferralRow {
  return {
    affiliate_id: "aff_1",
    plan_key: "family_monthly",
    referral_amount_minor: 200, // $2.00 — 20% of a $9.99 Home Basic sale, near enough
    currency: "usd",
    status: "paid",
    ...over,
  };
}

describe("affiliateCacForPlans — a per-plan denominator for a per-plan ratio", () => {
  const HOME = ["family_monthly", "family_annual"];
  const PRO_PLUS = ["teacher_pro_plus_monthly", "teacher_pro_plus_annual"];

  it("TODAY: no referred sale on any plan, so every plan's measured CAC is null", () => {
    expect(affiliateCacForPlans([], HOME).perReferredSaleUsd).toBeNull();
    expect(affiliateCacForPlans([], PRO_PLUS).perReferredSaleUsd).toBeNull();
  });

  it("does NOT let one plan's commission become another plan's CAC", () => {
    // $9.80 on a Teacher Pro+ sale, $2.00 on a Home Basic one. A blended mean
    // would be $5.90: it would understate Home Basic's cost (harmless) and
    // overstate Teacher Pro+'s LTV:CAC (the flattering, invisible error).
    const rows = [
      ref({ plan_key: "teacher_pro_plus_monthly", referral_amount_minor: 980 }),
      ref({ plan_key: "family_monthly", referral_amount_minor: 200 }),
    ];
    expect(affiliateCacForPlans(rows, PRO_PLUS).perReferredSaleUsd).toBeCloseTo(9.8, 10);
    expect(affiliateCacForPlans(rows, HOME).perReferredSaleUsd).toBeCloseTo(2, 10);
    // …and the business-wide figure on the acquisition table still sees both.
    expect(affiliateCac(rows).referredSales).toBe(2);
  });

  it("counts both billing cycles of a plan as the same product", () => {
    const rows = [
      ref({ plan_key: "family_annual", referral_amount_minor: 1980 }),
      ref({ plan_key: "family_monthly", referral_amount_minor: 200 }),
    ];
    const c = affiliateCacForPlans(rows, HOME);
    expect(c.referredSales).toBe(2);
    expect(c.perReferredSaleUsd).toBeCloseTo((19.8 + 2) / 2, 10);
  });

  it("drops sales with no plan attribution rather than charging them to a plan", () => {
    const c = affiliateCacForPlans([ref({ plan_key: null }), ref({ plan_key: "family_monthly" })], HOME);
    expect(c.referredSales).toBe(1);
    expect(c.perReferredSaleUsd).toBeCloseTo(2, 10);
  });

  it("still refuses when one of THAT plan's referred sales has no commission figure", () => {
    const c = affiliateCacForPlans(
      [ref({ referral_amount_minor: 200 }), ref({ referral_amount_minor: null })],
      HOME,
    );
    expect(c.salesMissingCommission).toBe(1);
    expect(c.perReferredSaleUsd).toBeNull();
  });
});

describe("affiliateCac — the only acquisition cost this app can ever measure", () => {
  it("TODAY'S STATE: no referred sale has happened, so cost per referred customer is null, NOT $0.00", () => {
    const c = affiliateCac([]);
    expect(c.referredSales).toBe(0);
    expect(c.commissionUsd).toBe(0);
    // 0/0 is undefined. A $0.00 here would render as "acquisition is free".
    expect(c.perReferredSaleUsd).toBeNull();
  });

  it("ignores sales with no affiliate attribution — an organic sale cost no commission", () => {
    const c = affiliateCac([ref({ affiliate_id: null }), ref({ affiliate_id: "" })]);
    expect(c.referredSales).toBe(0);
    expect(c.perReferredSaleUsd).toBeNull();
  });

  it("ignores refunded/pending sales on the same basis as Collected to date", () => {
    const c = affiliateCac([
      ref({ status: "refunded" }),
      ref({ status: "pending" }),
      ref({ status: "paid" }),
    ]);
    expect(c.referredSales).toBe(1);
    expect(c.commissionUsd).toBeCloseTo(2, 10);
  });

  it("converts MYR commission through the SAME rate the revenue side uses", () => {
    const c = affiliateCac([ref({ referral_amount_minor: 4300, currency: "myr" })]);
    expect(c.commissionUsd).toBeCloseTo(minorUnitsToUsd(4300, "myr"), 10);
    expect(c.commissionUsd).toBeCloseTo(43 / MYR_PER_USD, 10);
  });

  it("a referred sale with NO commission figure is a gap, not a zero — the per-sale cost refuses", () => {
    const c = affiliateCac([ref(), ref({ referral_amount_minor: null })]);
    expect(c.referredSales).toBe(2);
    expect(c.salesMissingCommission).toBe(1);
    expect(c.commissionUsd).toBeCloseTo(2, 10);
    // $2.00 / 2 sales = $1.00 would UNDERSTATE the cost — the flattering error.
    expect(c.perReferredSaleUsd).toBeNull();
  });

  it("computes per-referred-customer CAC once every referred sale carries its commission", () => {
    const c = affiliateCac([ref({ referral_amount_minor: 200 }), ref({ referral_amount_minor: 480 })]);
    expect(c.referredSales).toBe(2);
    expect(c.commissionUsd).toBeCloseTo(6.8, 10);
    expect(c.perReferredSaleUsd).toBeCloseTo(3.4, 10);
  });

  it("prices a referred customer's first payment at the live 20% program rate", () => {
    expect(AFFILIATE_COMMISSION_RATE).toBe(0.2);
    expect(affiliateCommissionUsd(9.99)).toBeCloseTo(1.998, 10);
    expect(affiliateCommissionUsd(24)).toBeCloseTo(4.8, 10);
  });

  it("isPaidStatus is one definition of 'the money moved', case- and space-insensitive", () => {
    expect(isPaidStatus("paid")).toBe(true);
    expect(isPaidStatus(" Succeeded ")).toBe(true);
    expect(isPaidStatus("refunded")).toBe(false);
    expect(isPaidStatus(null)).toBe(false);
  });
});

describe("lifetimeEvidence — retention measured, or admitted to be unmeasured", () => {
  function pay(over: Partial<LifetimePaymentRow> = {}): LifetimePaymentRow {
    return { user_id: "u1", plan_key: "family_monthly", status: "paid", ...over };
  }
  function ent2(over: Partial<EntitlementRow> = {}): EntitlementRow {
    return {
      user_id: "u1",
      school_id: null,
      plan_key: "family_monthly",
      active: false,
      status: "cancelled",
      current_period_end: null,
      ...over,
    };
  }

  it("THE LIVE 2026-08-22 SHAPE: one subscription ever, cancelled inside the hour, zero cycles recorded", () => {
    const ev = lifetimeEvidence([], [ent2()], []);
    expect(ev.entitlementsEver).toBe(1);
    expect(ev.activeNow).toBe(0);
    expect(ev.billedCycles).toBe(0);
    expect(ev.billedSubscriptions).toBe(0);
    expect(ev.renewals).toBe(0);
    expect(ev.endedSubscriptions).toBe(0);
    expect(ev.meanEndedMonths).toBeNull();
    // The whole point: no lifetime, therefore no LTV, therefore no ratio.
    expect(measuredLifetimeMonths(ev)).toBeNull();
  });

  it("no data at all is also no lifetime — never a zero, never a default", () => {
    const ev = lifetimeEvidence([], [], []);
    expect(ev.entitlementsEver).toBe(0);
    expect(measuredLifetimeMonths(ev)).toBeNull();
  });

  it("credit packs and school plans are not subscription cycles", () => {
    const ev = lifetimeEvidence(
      [pay({ plan_key: "pack_6" }), pay({ plan_key: "school_annual", user_id: "s1" }), pay()],
      [ent2(), ent2({ plan_key: "pack_6" }), ent2({ plan_key: "school_annual" })],
      [],
    );
    expect(ev.billedCycles).toBe(1);
    expect(ev.entitlementsEver).toBe(1); // consumer subscription plans only
    expect(isConsumerSubscriptionPlan("pack_6")).toBe(false);
    expect(isConsumerSubscriptionPlan("school_annual")).toBe(false);
    expect(isConsumerSubscriptionPlan("family_monthly")).toBe(true);
    expect(isConsumerSubscriptionPlan(null)).toBe(false);
  });

  it("counts renewals as cycles beyond the first — the only proof anyone survived a cycle", () => {
    const ev = lifetimeEvidence([pay(), pay(), pay()], [ent2()], []);
    expect(ev.billedCycles).toBe(3);
    expect(ev.billedSubscriptions).toBe(1);
    expect(ev.renewals).toBe(2);
    expect(ev.endedSubscriptions).toBe(1);
    expect(ev.meanEndedMonths).toBe(3);
  });

  it("a STILL-ACTIVE subscriber is excluded from the mean — their lifetime is not over yet", () => {
    const active = ent2({ active: true, status: "active" });
    const ev = lifetimeEvidence([pay(), pay()], [active], [active]);
    expect(ev.activeNow).toBe(1);
    expect(ev.renewals).toBe(1);
    expect(ev.endedSubscriptions).toBe(0); // censoring the mean downward is the failure mode
    expect(ev.unresolvedSubscriptions).toBe(0); // live, not unknown
    expect(ev.meanEndedMonths).toBeNull();
  });

  it("an annual cycle is twelve months of lifetime, not one payment of lifetime", () => {
    expect(planCycleMonths("teacher_pro_annual")).toBe(12);
    expect(planCycleMonths("teacher_pro_monthly")).toBe(1);
    const ev = lifetimeEvidence(
      [pay({ plan_key: "teacher_pro_annual" })],
      [ent2({ plan_key: "teacher_pro_annual" })],
      [],
    );
    expect(ev.meanEndedMonths).toBe(12);
  });

  // THE REGRESSION THIS BLOCK EXISTS FOR. "No live entitlement" was once read
  // as "the subscription ended", and entitlements.active is false for PAUSED and
  // UNPAID subscribers (ACTIVE_LS_STATUSES in lemonsqueezy/handlers.ts covers
  // only on_trial/active/past_due/cancelled). Five paused subscribers therefore
  // cleared MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME and printed a MEASURED 2-month
  // lifetime — and an LTV:CAC ratio — with nobody having cancelled anything.
  it("a PAUSED subscriber has not churned: no ended subscription, no measured lifetime", () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    const payments: LifetimePaymentRow[] = [];
    const ents: EntitlementRow[] = [];
    for (let i = 0; i < MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME; i++) {
      payments.push(pay({ user_id: `u${i}` }), pay({ user_id: `u${i}` }));
      ents.push(ent2({ user_id: `u${i}`, active: false, status: "paused", current_period_end: future }));
    }
    const ev = lifetimeEvidence(payments, ents, []);
    expect(ev.billedCycles).toBe(10);
    expect(ev.renewals).toBe(5); // they RENEWED — that much is real evidence
    expect(ev.endedSubscriptions).toBe(0);
    expect(ev.unresolvedSubscriptions).toBe(5);
    expect(ev.meanEndedMonths).toBeNull();
    expect(measuredLifetimeMonths(ev)).toBeNull();
    // …and with no measured lifetime there is no ratio, whatever the CAC.
    expect(ltvToCac(planLtv(9.99, 0.689, resolveLifetime(measuredLifetimeMonths(ev), null)), 1.998)).toBeNull();
  });

  it("dunning and trials are not churn either", () => {
    for (const status of ["unpaid", "past_due", "on_trial"]) {
      const ev = lifetimeEvidence([pay()], [ent2({ status })], []);
      expect(ev.endedSubscriptions).toBe(0);
      expect(ev.unresolvedSubscriptions).toBe(1);
    }
  });

  it("an ACTIVE subscriber whose period lapsed before the renewal webhook is not churn", () => {
    // active=true but current_period_end in the past ⇒ activePaidEntitlements
    // drops it, so it is not in activeEnts. Its status still says active, and a
    // lifetime that flickers between measured and unmeasured as webhooks land is
    // worse than one that waits.
    const lapsed = ent2({ active: true, status: "active", current_period_end: "2020-01-01T00:00:00Z" });
    const ev = lifetimeEvidence([pay(), pay(), pay()], [lapsed], []);
    expect(ev.renewals).toBe(2);
    expect(ev.endedSubscriptions).toBe(0);
    expect(ev.unresolvedSubscriptions).toBe(1);
  });

  it("a billed subscription with no entitlement row at all is unknown, not ended", () => {
    const ev = lifetimeEvidence([pay()], [], []);
    expect(ev.entitlementsEver).toBe(0);
    expect(ev.billedSubscriptions).toBe(1);
    expect(ev.endedSubscriptions).toBe(0);
    expect(ev.unresolvedSubscriptions).toBe(1);
  });

  it("expired and cancelled DO complete a lifetime — the gate must still be reachable", () => {
    const payments: LifetimePaymentRow[] = [];
    const ents: EntitlementRow[] = [];
    for (let i = 0; i < MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME; i++) {
      payments.push(pay({ user_id: `u${i}` }), pay({ user_id: `u${i}` }));
      ents.push(ent2({ user_id: `u${i}`, status: i % 2 ? "expired" : "cancelled" }));
    }
    const ev = lifetimeEvidence(payments, ents, []);
    expect(ev.endedSubscriptions).toBe(MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME);
    expect(ev.unresolvedSubscriptions).toBe(0);
    expect(measuredLifetimeMonths(ev)).toBe(2);
  });

  it("isFinishedSubscriptionStatus: terminal only, either spelling, any casing", () => {
    expect(isFinishedSubscriptionStatus("expired")).toBe(true);
    expect(isFinishedSubscriptionStatus(" Cancelled ")).toBe(true);
    expect(isFinishedSubscriptionStatus("canceled")).toBe(true); // Stripe's spelling
    expect(isFinishedSubscriptionStatus("paused")).toBe(false);
    expect(isFinishedSubscriptionStatus("unpaid")).toBe(false);
    expect(isFinishedSubscriptionStatus("active")).toBe(false);
    expect(isFinishedSubscriptionStatus(null)).toBe(false);
    expect(isFinishedSubscriptionStatus("")).toBe(false);
  });

  it("counts nothing at all when the payments query failed — the page passes [] and gets no lifetime", () => {
    // The page feeds lifetimeEvidence an empty payments array when its query
    // errors, so that the evidence line can say "unavailable" instead of "0".
    // What must never happen is that the empty array LOOKS like measured churn.
    const ev = lifetimeEvidence([], [ent2(), ent2({ user_id: "u2" })], []);
    expect(ev.billedCycles).toBe(0);
    expect(ev.billedSubscriptions).toBe(0);
    expect(ev.endedSubscriptions).toBe(0);
    expect(ev.unresolvedSubscriptions).toBe(0);
    expect(measuredLifetimeMonths(ev)).toBeNull();
  });

  it("refuses a mean below the disclosed minimum — one anecdote is not a churn rate", () => {
    const payments: LifetimePaymentRow[] = [];
    const ents: EntitlementRow[] = [];
    for (let i = 0; i < MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME - 1; i++) {
      payments.push(pay({ user_id: `u${i}` }));
      ents.push(ent2({ user_id: `u${i}` }));
    }
    const short = lifetimeEvidence(payments, ents, []);
    expect(short.endedSubscriptions).toBe(MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME - 1);
    expect(short.meanEndedMonths).toBe(1); // the mean EXISTS…
    expect(measuredLifetimeMonths(short)).toBeNull(); // …and is still not quotable

    payments.push(pay({ user_id: "uN" }), pay({ user_id: "uN" }));
    ents.push(ent2({ user_id: "uN" }));
    const enough = lifetimeEvidence(payments, ents, []);
    expect(enough.endedSubscriptions).toBe(MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME);
    // four 1-month lifetimes and one 2-month = 6/5
    expect(measuredLifetimeMonths(enough)).toBeCloseTo(1.2, 10);
  });
});

describe("resolveLifetime — measurement outranks assumption", () => {
  it("uses the measured months and marks them measured, ignoring anything typed in", () => {
    expect(resolveLifetime(7, 24)).toEqual({ months: 7, basis: "measured" });
  });

  it("falls back to the typed assumption ONLY while nothing is measured, and says so", () => {
    expect(resolveLifetime(null, 12)).toEqual({ months: 12, basis: "assumed" });
  });

  it("no measurement and no assumption ⇒ no lifetime (there is no default anywhere)", () => {
    expect(resolveLifetime(null, null)).toBeNull();
    expect(resolveLifetime(null, 0)).toBeNull(); // a 0-month lifetime is a fake $0 LTV
    expect(resolveLifetime(null, -3)).toBeNull();
  });
});

describe("planLtv", () => {
  const measured = { months: 10, basis: "measured" as const };

  it("contribution/mo is shown from measurements alone, even with no lifetime", () => {
    // Home Basic: $9.99 at the measured margin. LTV itself stays null.
    const ltv = planLtv(9.99, 0.5, null);
    expect(ltv.contributionPerMonthUsd).toBeCloseTo(4.995, 10);
    expect(ltv.revenueLtvUsd).toBeNull();
    expect(ltv.contributionLtvUsd).toBeNull();
  });

  it("no measured kit cost ⇒ no margin ⇒ no contribution, but revenue LTV still stands", () => {
    const ltv = planLtv(24, null, measured);
    expect(ltv.contributionPerMonthUsd).toBeNull();
    expect(ltv.contributionLtvUsd).toBeNull();
    expect(ltv.revenueLtvUsd).toBe(240);
  });

  it("multiplies price × margin × months, and carries the basis with the number", () => {
    const ltv = planLtv(24, 0.6, measured);
    expect(ltv.contributionPerMonthUsd).toBeCloseTo(14.4, 10);
    expect(ltv.contributionLtvUsd).toBeCloseTo(144, 10);
    expect(ltv.revenueLtvUsd).toBe(240);
    expect(ltv.lifetime).toEqual(measured);
  });
});

describe("ltvToCac — a ratio only when BOTH sides are real", () => {
  it("REFUSES on an assumed lifetime: the ratio would only restate the typed number", () => {
    const assumed = planLtv(24, 0.6, { months: 12, basis: "assumed" });
    expect(assumed.contributionLtvUsd).toBeCloseTo(172.8, 10);
    expect(ltvToCac(assumed, 4.8)).toBeNull();
  });

  it("refuses with no lifetime at all", () => {
    expect(ltvToCac(planLtv(24, 0.6, null), 4.8)).toBeNull();
  });

  it("refuses an absent, zero or negative CAC rather than dividing by nothing", () => {
    const ltv = planLtv(24, 0.6, { months: 12, basis: "measured" });
    expect(ltvToCac(ltv, null)).toBeNull();
    expect(ltvToCac(ltv, 0)).toBeNull(); // ∞ renders as "excellent"
    expect(ltvToCac(ltv, -1)).toBeNull();
  });

  it("refuses when the cost side is measured but the margin is not", () => {
    expect(ltvToCac(planLtv(24, null, { months: 12, basis: "measured" }), 4.8)).toBeNull();
  });

  it("computes contribution LTV ÷ CAC once the lifetime is measured", () => {
    const ltv = planLtv(24, 0.6, { months: 12, basis: "measured" });
    expect(ltvToCac(ltv, 4.8)).toBeCloseTo(172.8 / 4.8, 10);
  });

  // THE PAGE'S DENOMINATOR RULE, pinned here because it is the difference
  // between a verdict and a fabrication. The console divides by
  // affiliateCacForPlans(...).perReferredSaleUsd — commission actually RECORDED
  // against that plan's referred sales — and never by affiliateCommissionUsd(),
  // which is 20% of a list price and has never been paid to anybody.
  it("a measured lifetime is STILL not enough while no referred sale exists", () => {
    const ltv = planLtv(24, 0.741, { months: 12, basis: "measured" });
    const measured = affiliateCacForPlans([], ["teacher_pro_monthly", "teacher_pro_annual"]);
    expect(measured.perReferredSaleUsd).toBeNull();
    expect(ltvToCac(ltv, measured.perReferredSaleUsd)).toBeNull();
    // What the modelled figure would have printed instead, on today's numbers:
    // a 44.5× verdict against a cost nobody has incurred.
    expect(ltvToCac(ltv, affiliateCommissionUsd(24))).toBeCloseTo((24 * 0.741 * 12) / 4.8, 10);
  });

  it("computes once a referred sale of THAT plan has actually been paid for", () => {
    const ltv = planLtv(24, 0.741, { months: 12, basis: "measured" });
    const rows = [
      ref({ plan_key: "teacher_pro_monthly", referral_amount_minor: 480 }),
      ref({ plan_key: "family_monthly", referral_amount_minor: 200 }), // another plan's sale
    ];
    const measured = affiliateCacForPlans(rows, ["teacher_pro_monthly", "teacher_pro_annual"]);
    expect(measured.perReferredSaleUsd).toBeCloseTo(4.8, 10);
    expect(ltvToCac(ltv, measured.perReferredSaleUsd)).toBeCloseTo((24 * 0.741 * 12) / 4.8, 10);
  });
});

describe("LTV/CAC formatting", () => {
  it("a ratio carries its × so it cannot be read as dollars or percent", () => {
    expect(fmtRatio(36)).toBe("36.0×");
    expect(fmtRatio(1.25)).toBe("1.3×");
  });

  it("months are spelled out, singular when one", () => {
    expect(fmtMonths(12)).toBe("12 months");
    expect(fmtMonths(1)).toBe("1 month");
    expect(fmtMonths(1.24)).toBe("1.2 months");
  });
});
