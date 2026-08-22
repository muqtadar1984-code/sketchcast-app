// Pure math for the staff console's Financials tab: kit cost grouping, revenue
// mapping, scenario estimates and CSV assembly. No I/O here — the page fetches,
// these functions compute, the tests pin the arithmetic.
//
// "Kit" is the costing unit the founder thinks in: one distinct
// (book_id, chapter_ref, part) group among a non-demo owner's generations —
// the same slice the metering system charges one credit for, re-derived here
// from raw rows because cost lives on jobs, not credits.

// ── row shapes (subset of the DB rows the page selects) ─────────────────────

export type FinGenRow = {
  id: string;
  book_id: string | null;
  chapter_ref: string | null;
  params: Record<string, unknown> | null;
};

export type FinJobRow = {
  generation_id: string | null;
  usage: { cost_usd?: number } | null;
};

export type EntitlementRow = {
  user_id: string | null;
  school_id: string | null;
  plan_key: string;
  active: boolean | null;
  status: string | null;
  current_period_end: string | null;
};

export type PaymentRow = {
  amount: number; // provider minor units (Stripe: sen/cents)
  currency: string | null;
  status: string | null;
};

// ── kit grouping + measured cost ────────────────────────────────────────────

/** part = params->>'part', null → '0' (pre-parts generations are part 0). */
export function kitPart(params: Record<string, unknown> | null | undefined): string {
  const p = params?.["part"];
  return p === null || p === undefined || p === "" ? "0" : String(p);
}

/** Grouping key for the kit a generation belongs to. */
export function kitKey(g: Pick<FinGenRow, "book_id" | "chapter_ref" | "params">): string {
  return `${g.book_id ?? ""}|${g.chapter_ref ?? ""}|${kitPart(g.params)}`;
}

export type KitCostStats = {
  kits: number; // distinct (book, chapter, part) groups
  generations: number;
  /** Total tracked cost over ALL supplied jobs (incl. non-generation-linked
   * ones such as book indexing) — the true AI spend for the window. */
  aiSpendUsd: number;
  /** Averages only over kits/generations that HAVE tracked cost — a kit whose
   * jobs predate usage tracking would otherwise drag the average toward zero
   * and flatter us. */
  avgPerKitUsd: number | null;
  avgPerGenUsd: number | null;
  costedKits: number;
  costedGens: number;
};

/**
 * Measured kit economics for one window. Callers pass gens and jobs already
 * filtered to the window (and already demo-filtered); a job whose generation
 * is not in `gens` still counts toward aiSpendUsd but not toward the averages.
 */
export function kitCostStats(gens: FinGenRow[], jobs: FinJobRow[]): KitCostStats {
  const genIds = new Set(gens.map((g) => g.id));
  const costByGen = new Map<string, number>();
  let aiSpendUsd = 0;
  for (const j of jobs) {
    const c = j.usage?.cost_usd;
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    aiSpendUsd += c;
    if (j.generation_id && genIds.has(j.generation_id)) {
      costByGen.set(j.generation_id, (costByGen.get(j.generation_id) ?? 0) + c);
    }
  }

  const kitIds = new Set<string>();
  const costByKit = new Map<string, number>();
  for (const g of gens) {
    const key = kitKey(g);
    kitIds.add(key);
    const c = costByGen.get(g.id);
    if (c !== undefined) costByKit.set(key, (costByKit.get(key) ?? 0) + c);
  }

  const costedGens = costByGen.size;
  const costedKits = costByKit.size;
  const genTotal = [...costByGen.values()].reduce((a, b) => a + b, 0);
  const kitTotal = [...costByKit.values()].reduce((a, b) => a + b, 0);
  return {
    kits: kitIds.size,
    generations: gens.length,
    aiSpendUsd,
    avgPerKitUsd: costedKits ? kitTotal / costedKits : null,
    avgPerGenUsd: costedGens ? genTotal / costedGens : null,
    costedKits,
    costedGens,
  };
}

// ── model-route breakdown ───────────────────────────────────────────────────

/** Bucket params->>'coverage_model' for the "by model route" table. */
export function modelBucket(coverageModel: unknown): string {
  if (coverageModel === null || coverageModel === undefined || coverageModel === "") {
    return "earlier models (pre-tracking)";
  }
  const m = String(coverageModel);
  if (m.startsWith("claude")) return "Claude";
  if (m === "gemini-2.5-flash") return "Gemini 2.5 Flash";
  return m; // future routes (e.g. Kimi) surface under their own name, not hidden
}

export type ModelRouteRow = {
  bucket: string;
  generations: number;
  costedGens: number;
  avgPerGenUsd: number | null;
  totalUsd: number;
};

/** Avg cost per GENERATION per bucket — kits can mix models mid-life, so a
 * per-kit split would lie; per-generation is the honest cut. */
export function modelRouteBreakdown(gens: FinGenRow[], jobs: FinJobRow[]): ModelRouteRow[] {
  const genIds = new Set(gens.map((g) => g.id));
  const costByGen = new Map<string, number>();
  for (const j of jobs) {
    const c = j.usage?.cost_usd;
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    if (j.generation_id && genIds.has(j.generation_id)) {
      costByGen.set(j.generation_id, (costByGen.get(j.generation_id) ?? 0) + c);
    }
  }
  const buckets = new Map<string, { generations: number; costedGens: number; totalUsd: number }>();
  for (const g of gens) {
    const bucket = modelBucket(g.params?.["coverage_model"]);
    const row = buckets.get(bucket) ?? { generations: 0, costedGens: 0, totalUsd: 0 };
    row.generations++;
    const c = costByGen.get(g.id);
    if (c !== undefined) {
      row.costedGens++;
      row.totalUsd += c;
    }
    buckets.set(bucket, row);
  }
  return [...buckets.entries()]
    .map(([bucket, r]) => ({
      bucket,
      generations: r.generations,
      costedGens: r.costedGens,
      avgPerGenUsd: r.costedGens ? r.totalUsd / r.costedGens : null,
      totalUsd: r.totalUsd,
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
}

// ── actual revenue ──────────────────────────────────────────────────────────

// Monthly-equivalent USD per plan_key — update alongside pricing (the landing
// repo's pricing.config.js is the price source of truth; plan keys live in
// src/utils/stripe/plans.ts). Annual plans count at annual/12 so MRR means
// what it says. NOTE: Teacher Pro+ is $49/mo on the pricing page — 72 is its
// generations-per-month CAP, not a price. School = floor $3,000/yr → $250/mo.
// family_* is SOLD as "Home Basic" (display rename, homeschool release) — the
// plan_key stays 'family_*' here because billing identifiers never rename.
// One-time credit packs are deliberately absent: they are not recurring
// revenue, so they show up in "Collected to date" (payments) but never in MRR.
export const PLAN_PRICES_USD_MONTHLY: Record<string, number> = {
  teacher_pro_monthly: 24,
  teacher_pro_annual: 240 / 12,
  teacher_pro_plus_monthly: 49,
  teacher_pro_plus_annual: 490 / 12,
  family_monthly: 9.99,
  family_annual: 99 / 12,
  homeschool_monthly: 34,
  homeschool_annual: 340 / 12,
  school_annual: 3000 / 12,
  school_onetime: 3000 / 12,
};

/** B2B = school plans; everything else on the entitlements table is B2C. */
export function isSchoolPlan(planKey: string): boolean {
  return planKey.startsWith("school");
}

export function monthlyPriceUsd(planKey: string): number {
  return PLAN_PRICES_USD_MONTHLY[planKey] ?? 0;
}

/** Active + unexpired entitlements — what "a paying account" means here. */
export function activePaidEntitlements(rows: EntitlementRow[], nowMs: number): EntitlementRow[] {
  return rows.filter(
    (r) =>
      r.active === true &&
      (r.current_period_end === null || new Date(r.current_period_end).getTime() >= nowMs),
  );
}

export function mrrUsd(rows: EntitlementRow[]): number {
  return rows.reduce((sum, r) => sum + monthlyPriceUsd(r.plan_key), 0);
}

// Stripe school payments are recorded in MYR minor units (sen); the console is
// USD throughout, so they convert here at a hardcoded rate — update alongside
// pricing. Lemon Squeezy (B2C) settles in USD.
export const MYR_PER_USD = 4.3;

const PAID_STATUSES = new Set(["paid", "succeeded", "complete", "completed"]);

/** Did this row's money actually change hands? Exported because every figure
 * that touches money — collected revenue, affiliate commission, billed cycles —
 * has to answer it the SAME way; two definitions of "paid" is how a refunded
 * sale ends up counted on one line and not on another. */
export function isPaidStatus(status: string | null | undefined): boolean {
  return PAID_STATUSES.has((status ?? "").trim().toLowerCase());
}

/** Provider minor units → USD. The ONE currency conversion in this file: MYR
 * (Stripe, schools) at the hardcoded rate, everything else already USD (Lemon
 * Squeezy). Extracted from collectedUsd so the CAC side cannot drift onto a
 * second rate — a commission converted differently from the sale it came off
 * would produce a CAC ratio that is wrong in a way nobody can see. */
export function minorUnitsToUsd(amountMinor: number, currency: string | null | undefined): number {
  const major = amountMinor / 100;
  return (currency ?? "").toLowerCase() === "myr" ? major / MYR_PER_USD : major;
}

/** Sum of successfully collected payments, in USD. */
export function collectedUsd(payments: PaymentRow[]): number {
  let usd = 0;
  for (const p of payments) {
    if (!isPaidStatus(p.status)) continue;
    usd += minorUnitsToUsd(p.amount, p.currency);
  }
  return usd;
}

// ── estimated revenue ───────────────────────────────────────────────────────

export const TEACHER_PRO_USD_PER_MONTH = 24;

/** The school rate card (founder, 2026-08-17): the India-card enrolment bands
 * (A ≤350, B 351–700, C 701–1,200) at USD $3k/$5k/$7k per school per year —
 * each one $1k above the original ₹2/4/7-lakh-derived levels. Schools above
 * 1,200 students are priced individually; estimates show them at Band C. */
export const SCHOOL_BANDS = [
  { name: "A", maxStudents: 350, usdPerYear: 3000, range: "≤350" },
  { name: "B", maxStudents: 700, usdPerYear: 5000, range: "351–700" },
  { name: "C", maxStudents: 1200, usdPerYear: 7000, range: "701–1,200" },
] as const;

export type SchoolBand = (typeof SCHOOL_BANDS)[number];

/** The band covering an enrolment. 0 students ⇒ null (nothing to license);
 * above the top band ⇒ Band C (priced individually in reality — the footer
 * says so; the estimate needs a number, and understating is the safe error). */
export function bandForStudents(students: number): SchoolBand | null {
  if (!Number.isFinite(students) || students <= 0) return null;
  for (const b of SCHOOL_BANDS) if (students <= b.maxStudents) return b;
  return SCHOOL_BANDS[SCHOOL_BANDS.length - 1];
}

/** Monthly kit allowance per consumer plan (the 0086 generation caps ÷ 6 —
 * a kit is six generations). The estimate tables cost a subscriber at FULL
 * allowance: the conservative bound, and the steady state too (rollover only
 * shifts kits between adjacent months; the two-month total never exceeds
 * 2× cap, so average use converges on the cap). */
export const PLAN_KITS_PER_MONTH = {
  teacher_pro: 4,
  teacher_pro_plus: 12,
  family: 2,
  homeschool: 8,
} as const;

/** The documented school cost basis (2026-08 memo): content cost is FLAT in
 * enrolment — a school consumes full-curriculum coverage, ~940 chapter kits a
 * year (the CBSE 1–12 count the rate card was built against), whatever its
 * size. That flatness is exactly why the bigger bands carry the margin. */
export const SCHOOL_CURRICULUM_KITS_PER_YEAR = 940;

/** Gross margin as a FRACTION (0.648 = 64.8%): (revenue − kits × measured
 * avg kit cost) / revenue. A ratio, so it is independent of subscriber count
 * — one margin per plan, not per conversion scenario. Null when no kit cost
 * has been measured yet OR revenue is zero (a margin on nothing is not 100%)
 * — "—" beats a fake number. Can be negative: a loss-making band must SHOW
 * as one. */
export function grossMarginPct(
  revenueUsd: number,
  kitsForThatRevenue: number,
  avgKitUsd: number | null,
): number | null {
  if (avgKitUsd === null || revenueUsd <= 0) return null;
  return (revenueUsd - kitsForThatRevenue * avgKitUsd) / revenueUsd;
}

/** Display form: one decimal, the memo convention ("25.6%"). */
export function fmtPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export type ConversionScenario = { paying: number; annualUsd: number };

/** N teachers × rate, rounded to whole teachers so the printed maths is the
 * maths (4 × $24 × 12 must equal the figure shown). */
export function conversionScenario(
  teachers: number,
  rate: number,
  monthlyUsd: number = TEACHER_PRO_USD_PER_MONTH,
): ConversionScenario {
  const paying = Math.round(teachers * rate);
  return { paying, annualUsd: paying * monthlyUsd * 12 };
}

// ── acquisition cost (CAC) ──────────────────────────────────────────────────
//
// WHAT THIS APP CAN AND CANNOT KNOW ABOUT ACQUISITION (checked against the
// schema on 2026-08-22, not assumed). CAC is what it costs to win one paying
// customer, and it has exactly two possible inputs here:
//
//   1. PAID ACQUISITION SPEND — ads, sponsorships, paid content. Nothing in
//      this codebase records a marketing budget: no table, no column, no
//      console entry, no import, not even an env-backed constant. That is NOT
//      the same as "we spent nothing", and the two are indistinguishable from
//      inside the app. So this file computes no paid-spend CAC at all — an
//      unrecorded denominator turns every downstream ratio into fiction — and
//      the page prints what would make it computable instead.
//
//   2. AFFILIATE COMMISSION — a genuine, per-sale acquisition cost, and the
//      only one Lemon Squeezy can hand us as data. The program went live on
//      2026-08-22 at 20%. LS order and subscription-invoice objects carry
//      `affiliate_id` and `referral_amount`, so a referred sale's commission is
//      knowable per sale the moment one happens. What does NOT exist yet, and
//      was verified column by column before this was written: public.payments
//      (0022/0023/0093), public.credit_purchases (0086/0092) and
//      public.subscription_invoices (0093) store NEITHER field, and handlers.ts
//      never reads them. So there is nothing to sum today, and printing
//      "$0.00 commission" would read as "acquisition is free" rather than as
//      "we do not record it".
//
// affiliateCac() is therefore written against the row shape the webhook WOULD
// stamp once those columns exist; the page probes for them in an isolated query
// so their absence renders as an explicit "not wired yet" instead of a zero.

/** The live Lemon Squeezy affiliate rate (dashboard setting, switched on at
 * 20% on 2026-08-22). A MIRROR of a setting this app cannot read — same
 * contract as PLAN_PRICES_USD_MONTHLY above: update it here when it changes in
 * LS. It is printed under the table so a screenshot carries its own basis. */
export const AFFILIATE_COMMISSION_RATE = 0.2;

/** Commission on ONE payment of `amountUsd` at the program rate. This is the
 * FIRST-payment cost of a referred customer, which is the only part of it this
 * app can state: whether LS is configured to commission renewals as well is a
 * dashboard setting with no API surface here, and if it is, the true cost is a
 * revenue share across the whole lifetime rather than a one-off CAC. The page
 * footnote says exactly that, rather than letting the number imply otherwise. */
export function affiliateCommissionUsd(amountUsd: number): number {
  return amountUsd * AFFILIATE_COMMISSION_RATE;
}

/** The shape the LS webhook would stamp per referred sale — every field
 * nullable, because this describes columns that do not exist yet and a row that
 * arrives half-filled must never be readable as a complete one. */
export type ReferralRow = {
  affiliate_id: string | null;
  /** The plan the referred sale was for. Already a real column on
   * public.payments (0022), and carried here because the LTV table is PER PLAN:
   * dividing a Teacher Pro+ LTV by a commission mean that includes $9.99 Home
   * Basic sales would overstate the expensive plans' ratios — flattering, and
   * invisible. Null when the sale carries no plan attribution. */
  plan_key: string | null;
  /** Commission in MINOR UNITS of `currency`, the units payments.amount already
   * uses (LS reports money in minor units everywhere — see 0093). */
  referral_amount_minor: number | null;
  currency: string | null;
  status: string | null;
};

export type AffiliateCac = {
  /** Collected sales carrying an affiliate attribution. */
  referredSales: number;
  /** Commission on the referred sales whose amount IS recorded, in USD. */
  commissionUsd: number;
  /** Referred sales with no commission figure — a recorded gap, not a zero. */
  salesMissingCommission: number;
  /** commission ÷ referred sales, or null. Null when there are no referred
   * sales (0/0 is undefined, not $0.00) and null when any referred sale is
   * missing its commission — dividing a partial numerator by a full
   * denominator understates the cost, which is the flattering direction. */
  perReferredSaleUsd: number | null;
};

/** Recorded affiliate acquisition cost. Only successfully collected sales
 * count, on the same PAID_STATUSES basis as collectedUsd — a refunded sale
 * earns no commission and must not enter either side of the fraction. */
export function affiliateCac(rows: ReferralRow[]): AffiliateCac {
  let referredSales = 0;
  let commissionUsd = 0;
  let salesMissingCommission = 0;
  for (const r of rows) {
    if (!isPaidStatus(r.status)) continue;
    if (!r.affiliate_id) continue; // no attribution ⇒ not a referred sale
    referredSales++;
    const minor = r.referral_amount_minor;
    if (typeof minor === "number" && Number.isFinite(minor)) {
      commissionUsd += minorUnitsToUsd(minor, r.currency);
    } else {
      salesMissingCommission++;
    }
  }
  const complete = referredSales > 0 && salesMissingCommission === 0;
  return {
    referredSales,
    commissionUsd,
    salesMissingCommission,
    perReferredSaleUsd: complete ? commissionUsd / referredSales : null,
  };
}

/** The recorded affiliate CAC for ONE plan's referred sales.
 *
 * Per plan rather than blended, because it is the denominator of a PER-PLAN
 * ratio: a 20%-of-price commission is $2.00 on Home Basic and $9.80 on Teacher
 * Pro+, so one cross-plan mean would understate the cheap plans' LTV:CAC and
 * OVERSTATE the expensive ones — the flattering direction, and invisible on a
 * screenshot. Both cycles of a plan belong to the same row (planKeys is a list)
 * because monthly and annual are one product at one monthly-equivalent price,
 * the same basis PLAN_PRICES_USD_MONTHLY uses.
 *
 * A row with no plan attribution is dropped rather than pooled: it would add a
 * commission to a plan that may not have earned it. It still counts in the
 * business-wide affiliateCac() on the acquisition table, so nothing vanishes. */
export function affiliateCacForPlans(rows: ReferralRow[], planKeys: readonly string[]): AffiliateCac {
  const keys = new Set(planKeys);
  return affiliateCac(rows.filter((r) => r.plan_key !== null && keys.has(r.plan_key)));
}

// ── lifetime: the measurement LTV needs and does not have ───────────────────
//
// LTV = contribution per month × how many months a subscriber stays. The first
// factor is MEASURED here (list price × the gross margin the B2C table already
// computes from the measured kit cost). The second is a RETENTION fact, and
// retention is measured exactly one way: by watching subscriptions survive
// billing cycles. As of 2026-08-22 one subscription has ever existed (Home
// Basic monthly), it was cancelled within the hour, and it completed zero
// billing cycles — so there is no churn signal at all, not merely a weak one.
//
// These functions exist to say that from DATA rather than from a comment: they
// count the cycles that were actually billed, and refuse to return a lifetime
// until enough subscriptions have ended for a mean to mean anything.

/** Months covered by one billing cycle of a plan. An annual plan bills once for
 * twelve months, so counting its payments as months would divide a real
 * lifetime by twelve. */
export function planCycleMonths(planKey: string): number {
  return planKey.endsWith("_annual") ? 12 : 1;
}

/** A consumer subscription plan (the LTV table's subjects): priced in
 * PLAN_PRICES_USD_MONTHLY and not a school plan. Excludes credit packs —
 * pack_* is absent from the price map, and a pack is a one-off, never a cycle. */
export function isConsumerSubscriptionPlan(planKey: string | null | undefined): boolean {
  if (!planKey) return false;
  return planKey in PLAN_PRICES_USD_MONTHLY && !isSchoolPlan(planKey);
}

/** The payment fields the cycle count needs. One row = one billed cycle: since
 * 0093 subscription revenue lands one payments row per LS invoice, and an
 * invoice covers the initial charge AND every renewal — which is precisely what
 * makes renewals countable from this table at all. */
export type LifetimePaymentRow = {
  user_id: string | null;
  plan_key: string | null;
  status: string | null;
};

export type LifetimeEvidence = {
  /** Consumer subscription entitlements ever written, active or not. */
  entitlementsEver: number;
  /** …of which still active and unexpired. */
  activeNow: number;
  /** Collected payments on a consumer subscription plan. */
  billedCycles: number;
  /** Distinct (account, plan) subscriptions that were ever billed. Can be lower
   * than entitlementsEver — a subscription whose revenue was never recorded
   * (every one of them before 0093 shipped) is an entitlement with no cycles,
   * and that gap is worth seeing rather than smoothing over. */
  billedSubscriptions: number;
  /** Cycles beyond the first, per subscription: the ONLY evidence anybody has
   * ever survived to a renewal. Zero here means churn is unmeasured, full stop. */
  renewals: number;
  /** Billed subscriptions that have genuinely FINISHED: no live entitlement AND
   * a terminal entitlement status. Including live subscribers would censor the
   * mean downward (they have not finished yet); including paused or dunning
   * ones would invent churn that never happened — see unresolvedSubscriptions
   * and isFinishedSubscriptionStatus for why that distinction is load-bearing. */
  endedSubscriptions: number;
  /** Billed subscriptions that are neither live nor finished: paused, in
   * dunning (past_due/unpaid), on trial, an entitlement whose period lapsed an
   * hour before its renewal webhook landed, or a billed group with no
   * entitlement row at all. Counted and SHOWN rather than swept into
   * endedSubscriptions — sweeping them there is precisely how a churn rate gets
   * printed for a business where nobody has churned. */
  unresolvedSubscriptions: number;
  /** Mean BILLED tenure in months among the finished ones, null when none have
   * finished. Billed, not elapsed: it is cycles x cycle length, so a subscriber
   * who paid once and cancelled the same hour still contributes a whole month —
   * a whole YEAR on an annual plan. That runs in the flattering direction, so
   * the page footnote states it rather than letting "tenure" imply clock time. */
  meanEndedMonths: number | null;
};

/** Entitlement statuses that mean a subscription is genuinely OVER.
 *
 * WHY A WHITELIST RATHER THAN "not active right now". entitlements.active is
 * written by lsActiveFromStored() (src/utils/lemonsqueezy/handlers.ts), whose
 * ACTIVE_LS_STATUSES is ["on_trial","active","past_due","cancelled"] — so a
 * PAUSED or UNPAID (dunning) subscriber stores active=false while still being a
 * customer who has not churned, and an ACTIVE subscriber whose
 * current_period_end lapses in the gap before the renewal webhook lands reads
 * inactive for those minutes. Treating "no live entitlement" as "the lifetime
 * completed" therefore manufactures churn out of a pause and out of webhook
 * lag: five paused subscribers used to clear
 * MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME and print a MEASURED lifetime, teal LTV
 * columns and an LTV:CAC ratio with nobody having cancelled anything (probed
 * against these functions on 2026-08-22: endedSubscriptions 5, "measured" 2
 * months, 6.9x).
 *
 * "cancelled" is terminal here only in combination with the active check in
 * lifetimeEvidence: LS keeps a cancelled subscription entitled until ends_at,
 * so during that grace window it is still live and is excluded before this
 * runs. Both spellings are accepted because Stripe writes "canceled". */
export const FINISHED_SUBSCRIPTION_STATUSES = new Set(["expired", "cancelled", "canceled"]);

/** Same trim/case discipline as isPaidStatus — one definition, so "Cancelled"
 * and "cancelled" cannot land on opposite sides of a lifetime. */
export function isFinishedSubscriptionStatus(status: string | null | undefined): boolean {
  return FINISHED_SUBSCRIPTION_STATUSES.has((status ?? "").trim().toLowerCase());
}

/** How many ended subscriptions before a mean tenure may be quoted. Arbitrary,
 * and deliberately VISIBLE (printed in the page footnote) rather than a silent
 * constant: its whole job is to stop one anecdote — today literally n = 1 —
 * from being screenshotted as a churn rate. */
export const MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME = 5;

/**
 * What the data actually says about retention. `payments` are the collected
 * rows (already demo-filtered by the caller); `ents` every consumer
 * subscription entitlement ever written; `activeEnts` the currently-paying
 * subset (activePaidEntitlements output).
 */
export function lifetimeEvidence(
  payments: LifetimePaymentRow[],
  ents: EntitlementRow[],
  activeEnts: EntitlementRow[],
): LifetimeEvidence {
  const consumerEnts = ents.filter((e) => isConsumerSubscriptionPlan(e.plan_key));
  const activeKeys = new Set(
    activeEnts
      .filter((e) => isConsumerSubscriptionPlan(e.plan_key))
      .map((e) => `${e.user_id ?? ""}|${e.plan_key}`),
  );
  // The entitlement's own status, keyed the same way. entitlements is unique on
  // (user_id, plan_key), so this cannot collide. It is what separates "this
  // subscription ended" from "this subscription is paused / in dunning / one
  // renewal webhook away" — a distinction `active` alone cannot make.
  const statusByKey = new Map<string, string | null>(
    consumerEnts.map((e) => [`${e.user_id ?? ""}|${e.plan_key}`, e.status]),
  );

  // One group per (account, plan) — the same key entitlements is unique on, so
  // a subscriber who cancelled and re-subscribed to the SAME plan reads as ONE
  // subscription with both runs' cycles summed: two two-month lives become one
  // four-month life. That undercounts churn and OVERSTATES tenure, which
  // enlarges every LTV built on it. That is the FLATTERING direction, not the
  // conservative one — an earlier version of this comment claimed the opposite,
  // and a disclosure pointing the wrong way is worse than none, because it tells
  // the reader the error is safe in exactly the case where it is not.
  //
  // It cannot be fixed from this table: public.payments carries ls_order_id and
  // ls_invoice_id (0022/0093) and NO subscription identifier, so two runs of one
  // plan by one account are indistinguishable here. The durable per-subscription
  // id lives on public.subscription_invoices (ls_subscription_id, 0093) —
  // joining that in is what would split them apart. Until then the bias is
  // stated in the page footnote instead of being left silent.
  const cyclesByGroup = new Map<string, { plan: string; cycles: number }>();
  let billedCycles = 0;
  for (const p of payments) {
    if (!isPaidStatus(p.status)) continue;
    if (!isConsumerSubscriptionPlan(p.plan_key)) continue;
    billedCycles++;
    const key = `${p.user_id ?? ""}|${p.plan_key}`;
    const row = cyclesByGroup.get(key) ?? { plan: p.plan_key as string, cycles: 0 };
    row.cycles++;
    cyclesByGroup.set(key, row);
  }

  let renewals = 0;
  let endedSubscriptions = 0;
  let unresolvedSubscriptions = 0;
  let endedMonths = 0;
  for (const [key, row] of cyclesByGroup) {
    renewals += Math.max(0, row.cycles - 1);
    if (activeKeys.has(key)) continue; // still running — its lifetime is not complete
    // Not live, but "not live" is not "over". Only a terminal status completes a
    // lifetime; a pause, a dunning cycle, a lapsed period awaiting its renewal
    // webhook, or a billed group with no entitlement row at all is UNKNOWN, and
    // unknown must never be counted as a finished life — it would both clear the
    // MIN_ENDED gate and drag the mean down, and the gate is the half that gets
    // screenshotted.
    if (!isFinishedSubscriptionStatus(statusByKey.get(key))) {
      unresolvedSubscriptions++;
      continue;
    }
    endedSubscriptions++;
    endedMonths += row.cycles * planCycleMonths(row.plan);
  }

  return {
    entitlementsEver: consumerEnts.length,
    activeNow: activeKeys.size,
    billedCycles,
    billedSubscriptions: cyclesByGroup.size,
    renewals,
    endedSubscriptions,
    unresolvedSubscriptions,
    meanEndedMonths: endedSubscriptions ? endedMonths / endedSubscriptions : null,
  };
}

/** The measured mean subscriber lifetime in months, or null. Null while fewer
 * than MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME subscriptions have run their full
 * course — today that is 0 of 5, and the null renders as "—" beside a sentence
 * naming what would fill it. The months are BILLED months (cycles x cycle
 * length), never elapsed ones — see LifetimeEvidence.meanEndedMonths. */
export function measuredLifetimeMonths(ev: LifetimeEvidence): number | null {
  if (ev.endedSubscriptions < MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME) return null;
  return ev.meanEndedMonths;
}

// ── lifetime value (LTV) ────────────────────────────────────────────────────

/** Where the months in an LTV came from. This travels WITH the number because
 * it decides what may be done with it: a ratio may be formed against a
 * "measured" lifetime and never against an "assumed" one. */
export type LifetimeBasis = "measured" | "assumed";

export type SubscriberLifetime = { months: number; basis: LifetimeBasis };

/** Measurement outranks assumption, always — an assumed lifetime is a stand-in
 * for a measurement, not a competing opinion. So the typed-in months are used
 * only while nothing has been measured, and stop mattering the day
 * measuredLifetimeMonths() returns a number. */
export function resolveLifetime(
  measuredMonths: number | null,
  assumedMonths: number | null,
): SubscriberLifetime | null {
  if (measuredMonths !== null) return { months: measuredMonths, basis: "measured" };
  if (assumedMonths !== null && assumedMonths > 0) return { months: assumedMonths, basis: "assumed" };
  return null;
}

export type PlanLtv = {
  /** Price × gross margin: gross profit per subscriber per month. Fully derived
   * from measurements (the margin carries the measured kit cost), so it shows
   * even when no lifetime exists — it is the honest half of an LTV. */
  contributionPerMonthUsd: number | null;
  /** Price × months. Revenue, not profit — kept separate because quoting a
   * revenue LTV against a cost-based CAC is the classic overstatement. */
  revenueLtvUsd: number | null;
  /** Contribution × months — the figure that belongs opposite a CAC. */
  contributionLtvUsd: number | null;
  lifetime: SubscriberLifetime | null;
};

/**
 * LTV for one plan. Every null is a refusal with a reason:
 *   · no measured kit cost ⇒ no margin ⇒ no contribution (nothing to project);
 *   · no lifetime ⇒ no LTV at all, measured margin or not.
 * There is no default lifetime anywhere in this file. That is the point: a
 * plausible-looking "12 months" is indistinguishable, on a screenshot, from a
 * measured one.
 */
export function planLtv(
  monthlyUsd: number,
  marginFraction: number | null,
  lifetime: SubscriberLifetime | null,
): PlanLtv {
  const contributionPerMonthUsd = marginFraction === null ? null : monthlyUsd * marginFraction;
  if (lifetime === null) {
    return { contributionPerMonthUsd, revenueLtvUsd: null, contributionLtvUsd: null, lifetime: null };
  }
  return {
    contributionPerMonthUsd,
    revenueLtvUsd: monthlyUsd * lifetime.months,
    contributionLtvUsd:
      contributionPerMonthUsd === null ? null : contributionPerMonthUsd * lifetime.months,
    lifetime,
  };
}

/**
 * LTV : CAC — the single most misleading number on a founder's dashboard if
 * either side is invented, because the ratio LOOKS like a verdict. So it is
 * computed only when BOTH sides are real:
 *   · the LTV rests on a MEASURED lifetime (on an assumed one the ratio is a
 *     restatement of the assumption — pick 24 months instead of 12 and it
 *     doubles, with nothing in the world having changed);
 *   · the CAC is an actual cost above zero (a null or zero CAC would divide by
 *     nothing and print ∞ as "excellent").
 * Contribution LTV, never revenue LTV: the denominator is a cost, so the
 * numerator has to be profit.
 */
export function ltvToCac(ltv: PlanLtv, cacUsd: number | null): number | null {
  if (ltv.lifetime?.basis !== "measured") return null;
  if (ltv.contributionLtvUsd === null) return null;
  if (cacUsd === null || !Number.isFinite(cacUsd) || cacUsd <= 0) return null;
  return ltv.contributionLtvUsd / cacUsd;
}

/** Display form for a ratio: "3.4×" — the unit is what stops it being read as
 * dollars or as a percentage. */
export function fmtRatio(n: number): string {
  return `${n.toFixed(1)}×`;
}

/** "12 months" / "1 month" — months are spelled out next to LTV so a bare
 * integer can never be mistaken for money. */
export function fmtMonths(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded} ${rounded === 1 ? "month" : "months"}`;
}

// ── CSV assembly ────────────────────────────────────────────────────────────

export type CsvSection = {
  title: string;
  header: string[];
  rows: (string | number)[][];
  /** Assumption footers ride along as comment lines so a forwarded file is as
   * self-explanatory as a screenshot. */
  footer?: string;
};

/** RFC-4180-ish field escaping: quote when a comma, quote or newline appears;
 * double any embedded quotes. */
export function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** All sections stacked in one file; titles and footers as # comment lines. */
export function buildFinancialsCsv(sections: CsvSection[]): string {
  const out: string[] = [];
  for (const s of sections) {
    if (out.length) out.push("");
    out.push(`# ${s.title}`);
    out.push(s.header.map(csvField).join(","));
    for (const row of s.rows) out.push(row.map(csvField).join(","));
    if (s.footer) out.push(`# ${s.footer}`);
  }
  return out.join("\n") + "\n";
}

// ── formatting ──────────────────────────────────────────────────────────────

/** USD for display: sub-dollar magnitudes keep 3 decimals (kit costs live
 * there), everything else the usual 2. */
export function fmtUsd(n: number): string {
  const digits = Math.abs(n) > 0 && Math.abs(n) < 1 ? 3 : 2;
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${n < 0 ? "-" : ""}$${abs}`;
}
