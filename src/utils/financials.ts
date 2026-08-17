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
export const PLAN_PRICES_USD_MONTHLY: Record<string, number> = {
  teacher_pro_monthly: 24,
  teacher_pro_annual: 240 / 12,
  teacher_pro_plus_monthly: 49,
  teacher_pro_plus_annual: 490 / 12,
  family_monthly: 9.99,
  family_annual: 99 / 12,
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

/** Sum of successfully collected payments, in USD. */
export function collectedUsd(payments: PaymentRow[]): number {
  let usd = 0;
  for (const p of payments) {
    if (!PAID_STATUSES.has((p.status ?? "").toLowerCase())) continue;
    const major = p.amount / 100;
    usd += (p.currency ?? "").toLowerCase() === "myr" ? major / MYR_PER_USD : major;
  }
  return usd;
}

// ── estimated revenue ───────────────────────────────────────────────────────

export const STUDENTS_PER_BLOCK = 350;
export const SCHOOL_FLOOR_USD_PER_YEAR = 3000;
export const TEACHER_PRO_USD_PER_MONTH = 24;

/** ceil(students / 350) licence blocks — 0 students ⇒ 0 blocks. */
export function schoolBlocks(students: number): number {
  if (!Number.isFinite(students) || students <= 0) return 0;
  return Math.ceil(students / STUDENTS_PER_BLOCK);
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
