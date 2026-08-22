import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import { demoSchoolIds } from "@/utils/demo";
import {
  activePaidEntitlements,
  collectedUsd,
  conversionScenario,
  fmtUsd,
  isSchoolPlan,
  kitCostStats,
  modelRouteBreakdown,
  mrrUsd,
  bandForStudents,
  SCHOOL_BANDS,
  PLAN_PRICES_USD_MONTHLY,
  PLAN_KITS_PER_MONTH,
  SCHOOL_CURRICULUM_KITS_PER_YEAR,
  grossMarginPct,
  fmtPct,
  MYR_PER_USD,
  affiliateCac,
  affiliateCacForPlans,
  affiliateCommissionUsd,
  AFFILIATE_COMMISSION_RATE,
  isPaidStatus,
  lifetimeEvidence,
  measuredLifetimeMonths,
  resolveLifetime,
  planLtv,
  ltvToCac,
  fmtRatio,
  fmtMonths,
  MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME,
  type CsvSection,
  type EntitlementRow,
  type FinGenRow,
  type FinJobRow,
  type PaymentRow,
  type ReferralRow,
} from "@/utils/financials";
import CsvButton from "./csv-button";

// Financials — what a kit costs us (measured), what we actually collect, what
// acquiring a customer costs, and what the current user base could plausibly
// become. Every hardcoded assumption is printed under its table, so a
// screenshot (or the CSV) stands on its own in an investor or partner thread.
// USD throughout. Server component, service role only; the layout has verified
// staff access.
//
// THE ORDER OF THE PAGE IS THE ARGUMENT, and LTV/CAC were placed inside it
// rather than appended to it (founder, 2026-08-22):
//   1. what one kit costs        — the measurement everything else stands on
//   2. what we actually collect  — the money that has really moved
//   3. what acquisition costs    — money OUT per customer IN, the other real
//                                  cash fact, and CAC has to be established
//                                  before anything can be divided by it
//   4. B2C estimates             — per-plan gross margin … and directly under
//                                  it, LTV, because LTV is that margin
//                                  multiplied by a lifetime and belongs beside
//                                  the unit economics it is derived from
//   5. B2B schools               — the other rate card
//
// WHAT THIS PAGE REFUSES TO PRINT, and why that is the feature: as of
// 2026-08-22 one subscription has ever existed and was cancelled inside the
// hour, and no marketing spend is recorded anywhere in this codebase. So there
// is no churn signal and no acquisition-spend input. A confident LTV or a
// blended CAC here would be a number invented on this page and quoted at an
// investor tomorrow. Both therefore render as "—" beside the specific input
// that would make them real — the audience is one person who can go and create
// that input.

export const dynamic = "force-dynamic";

const DAY = 86400000;

const TABLE1_FOOTER =
  "Measured from jobs.usage (AI generation cost only — infra excluded). Averages use cost-tracked rows only — some early jobs predate tracking, so AI spend ÷ kit count differs slightly. Demo accounts excluded.";
const TABLE2_FOOTER =
  `Prices: Teacher Pro $24/mo, Teacher Pro+ $49/mo, Home Basic (family_*) $9.99/mo, Homeschool $34/mo (annual plans at annual/12); ` +
  `school floor $3,000/yr → $250/mo. Stripe school payments (MYR) converted at RM${MYR_PER_USD.toFixed(2)}/USD. ` +
  `Collected is GROSS of any affiliate commission — that cost is a separate line under Acquisition cost below. ` +
  `Update alongside pricing. Demo accounts excluded.`;
// Acquisition. Every "—" on this table is a missing INPUT, not a missing
// calculation, so the footer names the inputs rather than the formulas.
const CAC_FOOTER =
  `CAC = acquisition cost ÷ customers acquired. This app holds neither half of the paid-spend version: ` +
  `no table, column or import anywhere in the codebase records a marketing budget, so no paid CAC and no blended CAC is shown — ` +
  `"not recorded" and "$0 spent" are different claims and only one of them is true. ` +
  `The affiliate slice IS knowable per sale: Lemon Squeezy's affiliate program went live 2026-08-22 at ` +
  `${(AFFILIATE_COMMISSION_RATE * 100).toFixed(0)}%, and its order and invoice objects carry affiliate_id and referral_amount. ` +
  `Only paid, non-refunded sales count, on the same basis as Collected to date. Demo accounts excluded.`;
const TABLE3_B2C_FOOTER =
  "Prices: Teacher Pro $24 · Teacher Pro+ $49 · Home Basic $9.99 · Homeschool $34 per month; annual = 12×. " +
  "Teachers = active non-demo teacher accounts; parents = non-demo parent accounts (home educators included). " +
  "Each column assumes that share of the row's base converts to that plan — rows are ALTERNATIVE scenarios, " +
  "never additive. Gross margin = (price − allowance × measured lifetime avg kit cost) / price, with every " +
  "subscriber using their FULL kit allowance (Pro 4 · Pro+ 12 · Home Basic 2 · Homeschool 8 kits/mo) — the " +
  "conservative bound; a ratio, so it holds at any conversion. Estimates, not forecasts.";
const LTV_FOOTER =
  `LTV = contribution per subscriber-month × subscriber lifetime. Contribution/mo = list price (in the table above) × the gross margin above, ` +
  `so it carries the MEASURED kit cost and nothing else — it is the half of an LTV this business can already prove. ` +
  `The lifetime is the half it cannot: it is typed in above, echoed everywhere as an assumption, and replaced automatically ` +
  `by a measured mean once ${MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME} subscriptions have run their full course (measurement outranks assumption — the box stops mattering that day). ` +
  `Two properties of that measured mean, stated here rather than left in the code, because both overstate tenure and therefore LTV: tenure is counted as BILLED CYCLES × cycle length, ` +
  `so a cancellation inside a paid period still counts that whole period (a whole year on an annual plan); and public.payments carries no subscription identifier, ` +
  `so an account that cancelled and later re-subscribed to the same plan reads as one longer subscription rather than two short ones. ` +
  `A paused or dunning subscriber is NOT counted as ended — only a terminal entitlement status completes a lifetime, and anything in between is listed above as neither live nor finished. ` +
  `LTV (revenue) is shown next to LTV (contribution) only so the gap between them is visible; the contribution figure is the one that belongs opposite a cost. ` +
  `Affiliate CAC (modelled) = ${(AFFILIATE_COMMISSION_RATE * 100).toFixed(0)}% of ONE month's price — what a referred customer's first payment WILL cost at the live program rate, ` +
  `and NOT a cost anyone has yet paid: no referred sale has ever happened. If the program commissions renewals too (a Lemon Squeezy dashboard setting this app cannot read), ` +
  `the real cost is ${(AFFILIATE_COMMISSION_RATE * 100).toFixed(0)}% of lifetime revenue instead and that column understates it. ` +
  `LTV : affiliate CAC (measured) divides the contribution LTV by the commission actually RECORDED against referred sales of that plan (Acquisition cost, above) — never by the modelled column beside it. ` +
  `So it stays "—" until BOTH halves are real: a measured lifetime, and a referred sale someone has actually been paid for. On an assumed lifetime the ratio would only restate the number you typed, dressed as a verdict. ` +
  `Even once it computes, it counts affiliate commission ONLY: all other acquisition spend is unrecorded rather than zero, so it is an upper bound on this business's LTV : CAC and never that ratio itself.`;
const TABLE3_B2B_FOOTER =
  "Rate card: Band A ≤350 students $3,000 · Band B 351–700 $5,000 · Band C 701–1,200 $7,000 " +
  "per school per year; schools above 1,200 are priced individually (shown at Band C). " +
  "Gross margin = (rate − ~940 chapter kits × measured lifetime avg kit cost) / rate — full-curriculum " +
  "coverage per school per year, FLAT in enrolment, which is why the bigger bands carry the margin. " +
  "Assumes the entered number of new schools in year 1 — change it below or via ?pipeline=N " +
  "(the link carries the scenario). No school LTV is shown: it would need recorded annual renewals per school, " +
  "which is a shape the payments table has never carried for a school. Estimates, not forecasts.";

function dash(v: number | null, fmt: (n: number) => string): string {
  return v === null ? "—" : fmt(v);
}

export default async function ConsoleFinancialsPage({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string; lifetime?: string }>;
}) {
  const { pipeline: pipelineRaw, lifetime: lifetimeRaw } = await searchParams;
  // ?pipeline=N — assumed new schools in year 1, carried in the URL so a
  // scenario link is shareable. Defaults to the founder's 10-schools-in-year-1
  // assumption; an explicit ?pipeline=0 zeroes it; junk is treated as absent.
  const parsed = Math.floor(Number(pipelineRaw));
  const pipeline = pipelineRaw === undefined || !Number.isFinite(parsed) ? 10 : Math.max(0, parsed);

  // ?lifetime=N — assumed subscriber lifetime in MONTHS, the one input an LTV
  // needs and this business has no measurement for.
  //
  // IT HAS NO DEFAULT, and that is the whole design. Every other assumption on
  // this page defaults to something because a plausible default is harmless
  // there: nobody mistakes "10 assumed schools" for a fact. A default lifetime
  // is different — "12 months" would render as a confident LTV on a page whose
  // other figures are measured, and a screenshot cannot show which is which.
  // So the page ships with NO LTV at all, and the reader who wants one has to
  // type the assumption in, which is also what makes it visible: it is echoed
  // in the row heading, the status line and the footer.
  // Junk, zero and negatives are treated as absent (a 0-month lifetime is an
  // LTV of $0.00, which is a fake number in the other direction).
  const lifetimeParsed = Math.floor(Number(lifetimeRaw));
  const assumedLifetimeMonths =
    lifetimeRaw === undefined || !Number.isFinite(lifetimeParsed) || lifetimeParsed <= 0
      ? null
      : lifetimeParsed;

  const admin = createAdminClient();

  // TODO: these are unbounded-ish selects capped well above today's volume
  // (197 costed jobs, 190 generations). PostgREST silently stops at its
  // default page on an uncapped select, so the caps are explicit; once volume
  // outgrows one page, move to DB-side grouped counts instead of raising them.
  // THE AFFILIATE PROBE (referralQ, last in this list) IS A SEPARATE QUERY ON
  // PURPOSE, and it is expected to FAIL today. Nothing stores an affiliate
  // attribution yet: public.payments (0022/0023/0093), credit_purchases
  // (0086/0092) and subscription_invoices (0093) were each read column by
  // column before this was written and none of them has affiliate_id or a
  // referral amount. Asking PostgREST for a column that does not exist returns
  // 42703 for the WHOLE select — so adding these two fields to the payments
  // select above would have taken "Collected to date" down with them and turned
  // real revenue into "payment records unavailable". Its own query keeps the
  // blast radius at one row of one table, exactly like the existing paymentsOk
  // branch. When a migration adds the columns and handlers.ts stamps them from
  // the LS order/invoice, this query starts succeeding and the affiliate CAC
  // becomes real with no change to this page. plan_key rides along in the same
  // select because it is an EXISTING column (0022) and adds no 42703 risk of
  // its own: it is what lets the LTV table measure a CAC per plan instead of
  // dividing one plan's LTV by another plan's commission.
  const [profilesQ, booksQ, gensQ, entsQ, paymentsQ, jobsQ, referralQ] = await Promise.all([
    admin.from("profiles").select("id, role, school_id, is_demo"),
    admin.from("books").select("id, owner_id"),
    admin
      .from("generations")
      .select("id, owner_id, book_id, chapter_ref, params, created_at")
      .limit(5000),
    admin.from("entitlements").select("user_id, school_id, plan_key, active, status, current_period_end"),
    admin.from("payments").select("user_id, school_id, plan_key, amount, currency, status, created_at"),
    admin.from("jobs").select("generation_id, book_id, usage, created_at").limit(5000),
    admin
      .from("payments")
      .select("user_id, school_id, plan_key, status, currency, affiliate_id, referral_amount_minor"),
  ]);

  type ProfileRow = { id: string; role: string; school_id: string | null; is_demo: boolean | null };
  type GenRow = FinGenRow & { owner_id: string; created_at: string };
  type JobRow = FinJobRow & { book_id: string | null; created_at: string };

  const allProfiles = (profilesQ.data ?? []) as ProfileRow[];
  const allBooks = (booksQ.data ?? []) as { id: string; owner_id: string }[];
  const allGens = (gensQ.data ?? []) as GenRow[];
  const allJobs = (jobsQ.data ?? []) as JobRow[];

  // Demo exclusion — same basis as the Overview page: profiles.is_demo marks
  // seeded sales props; jobs carry no owner, so they attribute through their
  // generation or book and fail open when neither resolves.
  const demoIds = new Set(allProfiles.filter((p) => p.is_demo === true).map((p) => p.id));
  const demoSchools = demoSchoolIds(allProfiles);
  const profiles = allProfiles.filter((p) => !demoIds.has(p.id));
  const gens = allGens.filter((g) => !demoIds.has(g.owner_id));
  const genOwner = new Map(allGens.map((g) => [g.id, g.owner_id]));
  const bookOwner = new Map(allBooks.map((b) => [b.id, b.owner_id]));
  const jobs = allJobs.filter((j) => {
    const owner =
      (j.generation_id ? genOwner.get(j.generation_id) : undefined) ??
      (j.book_id ? bookOwner.get(j.book_id) : undefined);
    return owner === undefined || !demoIds.has(owner);
  });

  // (server component, rendered once per request — Date.now is fine here)
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const cutoff30 = now - 30 * DAY;
  const in30 = (iso: string) => new Date(iso).getTime() >= cutoff30;

  // ── Table 1: what a kit costs us ──────────────────────────────────────────
  const statsLife = kitCostStats(gens, jobs);
  const stats30 = kitCostStats(gens.filter((g) => in30(g.created_at)), jobs.filter((j) => in30(j.created_at)));
  const routes = modelRouteBreakdown(gens, jobs);

  const kitRows: { label: string; d30: string; life: string }[] = [
    { label: "Avg cost / kit", d30: dash(stats30.avgPerKitUsd, fmtUsd), life: dash(statsLife.avgPerKitUsd, fmtUsd) },
    {
      label: "Avg cost / generation",
      d30: dash(stats30.avgPerGenUsd, fmtUsd),
      life: dash(statsLife.avgPerGenUsd, fmtUsd),
    },
    { label: "AI spend", d30: fmtUsd(stats30.aiSpendUsd), life: fmtUsd(statsLife.aiSpendUsd) },
    { label: "Kits generated", d30: String(stats30.kits), life: String(statsLife.kits) },
    { label: "Generations", d30: String(stats30.generations), life: String(statsLife.generations) },
  ];

  // ── Table 2: actual revenue ───────────────────────────────────────────────
  const allEnts = (entsQ.data ?? []) as EntitlementRow[];
  const ents = allEnts.filter(
    (e) =>
      !(e.user_id && demoIds.has(e.user_id)) && !(e.school_id && demoSchools.has(e.school_id)),
  );
  const paid = activePaidEntitlements(ents, now);
  const paidB2B = paid.filter((e) => isSchoolPlan(e.plan_key));
  const paidB2C = paid.filter((e) => !isSchoolPlan(e.plan_key));

  type PayRow = PaymentRow & { user_id: string | null; school_id: string | null; plan_key: string | null; created_at: string };
  const paymentsOk = !paymentsQ.error;
  const allPayments = (paymentsQ.data ?? []) as PayRow[];
  const payments = allPayments.filter(
    (p) =>
      !(p.user_id && demoIds.has(p.user_id)) && !(p.school_id && demoSchools.has(p.school_id)),
  );
  const isB2BPayment = (p: PayRow) => (p.plan_key ? isSchoolPlan(p.plan_key) : p.school_id !== null);
  const collectedB2B = collectedUsd(payments.filter(isB2BPayment));
  const collectedB2C = collectedUsd(payments.filter((p) => !isB2BPayment(p)));
  const collected30 = collectedUsd(payments.filter((p) => in30(p.created_at)));

  // Gross margin (30d) = 30d collected revenue − 30d AI spend. Splitting the
  // AI spend across B2C/B2B would be invented precision, so it lives in the
  // Total column only.
  const grossMargin30 = collected30 - stats30.aiSpendUsd;

  const NO_PAYMENTS_YET = "— (payment records unavailable right now)";
  const revenueRows: { label: string; b2c: string; b2b: string; total: string }[] = [
    {
      label: "Active paid accounts",
      b2c: String(paidB2C.length),
      b2b: String(paidB2B.length),
      total: String(paid.length),
    },
    {
      label: "MRR",
      b2c: fmtUsd(mrrUsd(paidB2C)),
      b2b: fmtUsd(mrrUsd(paidB2B)),
      total: fmtUsd(mrrUsd(paid)),
    },
    paymentsOk
      ? {
          label: "Collected to date",
          b2c: fmtUsd(collectedB2C),
          b2b: fmtUsd(collectedB2B),
          total: fmtUsd(collectedB2C + collectedB2B),
        }
      : { label: "Collected to date", b2c: "—", b2b: "—", total: NO_PAYMENTS_YET },
    { label: "Gross margin (30d)", b2c: "—", b2b: "—", total: fmtUsd(grossMargin30) },
  ];

  // ── Table 2b: acquisition cost (CAC) ──────────────────────────────────────
  // Placed straight after actual revenue because it is the same KIND of number
  // — cash that has really moved — and because the LTV table below divides by
  // it. Most of these rows are refusals today, and each one names the specific
  // input that would turn it into a figure — the only reader of this page is
  // the person who can go and create that input.
  const referralOk = !referralQ.error;
  // 42703 = undefined_column. Distinguishing it from any other failure matters:
  // "the column does not exist yet" is an instruction to write a migration,
  // while a transient error is an instruction to reload. Saying "unavailable"
  // for both would waste the one useful thing this row can say.
  const referralColumnsMissing = referralQ.error?.code === "42703";
  type ReferralPayRow = ReferralRow & { user_id: string | null; school_id: string | null };
  const referralRows = ((referralQ.data ?? []) as ReferralPayRow[]).filter(
    (p) => !(p.user_id && demoIds.has(p.user_id)) && !(p.school_id && demoSchools.has(p.school_id)),
  );
  const cac = referralOk ? affiliateCac(referralRows) : null;

  // The denominator a blended CAC would use — REAL, and shown for exactly that
  // reason: it makes the missing numerator concrete rather than abstract.
  //
  // …but only while the payments query actually answered. `payments` falls back
  // to [] on any error (paymentsOk, above), and 0 is ALSO the true zero-data
  // count — so without this guard an outage and an empty table print the same
  // glyph under a basis line calling it real, one row below a row that
  // correctly says the records are unavailable. Unknown is not zero, and this
  // table is the last place on the page that should blur the two.
  const payingAccounts = paymentsOk
    ? new Set(
        payments.filter((p) => isPaidStatus(p.status)).map((p) => p.user_id ?? p.school_id ?? "?"),
      ).size
    : null;

  const NOT_RECORDED = "—";
  const affiliateBasis = referralOk
    ? `From payments.referral_amount_minor on sales carrying an affiliate_id.${
        cac && cac.salesMissingCommission > 0
          ? ` ${cac.salesMissingCommission} referred sale(s) carry no commission figure, so the per-customer cost stays "—" rather than dividing a partial total by a full count.`
          : ""
      }`
    : referralColumnsMissing
      ? "Not stored. Lemon Squeezy sends affiliate_id and referral_amount on every order and invoice; nothing persists them. Computable as soon as public.payments carries affiliate_id + referral_amount_minor (minor units, same currency as amount) and the LS webhook stamps both — this page already reads them."
      : `Payment records unavailable right now (${referralQ.error?.code ?? "unknown error"}).`;

  const cacRows: { label: string; value: string; basis: string }[] = [
    {
      label: "Paid acquisition spend",
      value: NOT_RECORDED,
      basis:
        "No input exists. Nothing in this app records a marketing budget — no table, no column, no import. Computable once spend is recorded per channel and period; until then this is unmeasured, which is NOT the same as zero.",
    },
    {
      label: "Affiliate commission paid",
      value: cac ? fmtUsd(cac.commissionUsd) : NOT_RECORDED,
      basis: affiliateBasis,
    },
    {
      label: "Referred sales",
      value: cac ? String(cac.referredSales) : NOT_RECORDED,
      basis: cac
        ? "Collected, non-refunded sales carrying an affiliate attribution."
        : "Same missing input as the row above.",
    },
    {
      label: "CAC per referred customer",
      value: dash(cac?.perReferredSaleUsd ?? null, fmtUsd),
      basis:
        "Commission ÷ referred sales. Real the moment the first referred sale lands — no assumption in it, and the only CAC this business can currently ever measure.",
    },
    {
      label: "Paying accounts to date",
      value: payingAccounts === null ? NOT_RECORDED : String(payingAccounts),
      basis:
        payingAccounts === null
          ? `Payment records unavailable right now (${paymentsQ.error?.code ?? "unknown error"}), so this is UNKNOWN rather than zero. Reload; nothing on this table derived from payments can be read as a count until it answers.`
          : "Distinct accounts with a collected payment — the denominator a blended CAC would divide by. It is real; the numerator above is not, so no blended CAC is printed. Upper bound: migration 0093 records that three legacy credit-pack rows are test-mode rehearsals, and no column here can tell them apart.",
    },
    {
      label: "Blended CAC",
      value: NOT_RECORDED,
      basis:
        "(paid spend + affiliate commission) ÷ new paying customers. Two of those three inputs are unavailable above, and a ratio built on an invented denominator is the most misleading figure a dashboard can carry.",
    },
  ];

  // ── Table 3: estimated revenue (annual) ───────────────────────────────────
  // One row per consumer plan, one column per conversion rate (founder,
  // 2026-08-18). Teachers convert to the teacher plans, parents (home
  // educators included) to the home plans; a row assumes that share of ITS
  // base converts to THAT plan, so rows are alternative scenarios — summing
  // them would double-count the same people.
  const teachers = profiles.filter((p) => p.role === "teacher").length;
  const parents = profiles.filter((p) => p.role === "parent").length;
  const B2C_RATES = [0.1, 0.25, 0.5];
  // Gross uses the MEASURED lifetime avg kit cost (the "actual" from Table 1)
  // at each plan's full monthly kit allowance — see PLAN_KITS_PER_MONTH.
  const avgKitLife = statsLife.avgPerKitUsd;
  // Hoisted out of the .map() below because the LTV table under it prices the
  // SAME four plans off the SAME margin — one list, so a price or an allowance
  // can never disagree between two tables on one screen.
  // planKeys = the BILLING identifiers each display plan is sold under (both
  // cycles), so the LTV table can find that plan's own referred sales. Monthly
  // and annual share a row because they are one product at one monthly-
  // equivalent price — the same basis PLAN_PRICES_USD_MONTHLY already uses.
  const b2cPlans = [
    { plan: "Teacher Pro", planKeys: ["teacher_pro_monthly", "teacher_pro_annual"], monthly: PLAN_PRICES_USD_MONTHLY.teacher_pro_monthly, base: teachers, baseLabel: "teachers", kitsMo: PLAN_KITS_PER_MONTH.teacher_pro },
    { plan: "Teacher Pro+", planKeys: ["teacher_pro_plus_monthly", "teacher_pro_plus_annual"], monthly: PLAN_PRICES_USD_MONTHLY.teacher_pro_plus_monthly, base: teachers, baseLabel: "teachers", kitsMo: PLAN_KITS_PER_MONTH.teacher_pro_plus },
    { plan: "Home Basic", planKeys: ["family_monthly", "family_annual"], monthly: PLAN_PRICES_USD_MONTHLY.family_monthly, base: parents, baseLabel: "parents", kitsMo: PLAN_KITS_PER_MONTH.family },
    { plan: "Homeschool", planKeys: ["homeschool_monthly", "homeschool_annual"], monthly: PLAN_PRICES_USD_MONTHLY.homeschool_monthly, base: parents, baseLabel: "parents", kitsMo: PLAN_KITS_PER_MONTH.homeschool },
  ];
  const b2cRows = b2cPlans.map((p) => {
    // Margin is a ratio — subscriber count cancels out — so it is ONE number
    // per plan, from unit economics: monthly price vs the allowance's cost.
    const margin = grossMarginPct(p.monthly, p.kitsMo, avgKitLife);
    return {
      plan: p.plan,
      monthly: `$${p.monthly.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
      base: `${p.base} ${p.baseLabel}`,
      margin: margin === null ? "—" : fmtPct(margin),
      cells: B2C_RATES.map((rate) => fmtUsd(conversionScenario(p.base, rate, p.monthly).annualUsd)),
    };
  });

  // ── Table 3a-ii: lifetime value, directly under the margins it is made of ──
  // LTV = (price × margin) × months. The first bracket is the row immediately
  // above in the same section — that adjacency IS the placement decision: LTV
  // is not a new subject, it is the per-plan margin extended over time, and
  // reading it anywhere else would hide which measurement it rests on.
  //
  // The months are the problem, and lifetimeEvidence() is here to state the
  // problem from data rather than from a comment that will rot.
  //
  // Same guard as the CAC denominator above, and for the same reason: a billed
  // cycle exists only as a payments row, so a failed payments query makes every
  // cycle-derived count UNKNOWN. Feeding it [] keeps the arithmetic honest (no
  // lifetime can be measured from nothing) and the evidence line below then says
  // "unavailable" instead of printing "0 billed cycles recorded" — which is a
  // measurement claim, and would be a fabricated one. Entitlements come from a
  // different query, so they get their own guard rather than sharing this one.
  const entsOk = !entsQ.error;
  const lifeEv = lifetimeEvidence(paymentsOk ? payments : [], ents, paid);
  const measuredMonths = measuredLifetimeMonths(lifeEv);
  const lifetime = resolveLifetime(measuredMonths, assumedLifetimeMonths);

  // The one sentence that has to survive being screenshotted: what the retention
  // record actually contains. Every number in it is counted, none is narrated —
  // and where a query failed it says so rather than counting to zero.
  const entEvidence = entsOk
    ? `${lifeEv.entitlementsEver} consumer subscription${lifeEv.entitlementsEver === 1 ? "" : "s"} ever ` +
      `(${lifeEv.activeNow} active now)`
    : `entitlement records unavailable right now (${entsQ.error?.code ?? "unknown error"})`;
  const cycleEvidence = paymentsOk
    ? `${lifeEv.billedCycles} billed cycle${lifeEv.billedCycles === 1 ? "" : "s"} recorded ` +
      `· ${lifeEv.renewals} renewal${lifeEv.renewals === 1 ? "" : "s"} · ${lifeEv.endedSubscriptions} of ` +
      `${MIN_ENDED_SUBSCRIPTIONS_FOR_LIFETIME} completed subscriptions needed before a mean lifetime is quoted` +
      // Only when it is non-zero: a standing "0 in limbo" is noise, but even one
      // is the difference between a subscription that ENDED and one that is
      // merely paused, in dunning, or waiting on a renewal webhook.
      (lifeEv.unresolvedSubscriptions > 0
        ? ` · ${lifeEv.unresolvedSubscriptions} billed subscription${lifeEv.unresolvedSubscriptions === 1 ? " is" : "s are"} neither live nor finished (paused, in dunning, or awaiting a renewal webhook) and ${lifeEv.unresolvedSubscriptions === 1 ? "is" : "are"} excluded from the mean rather than counted as churn`
        : "")
    : "billed cycles, renewals and completed subscriptions unavailable right now (the payment records did not load) — unknown, not zero, so nothing can be measured this request";
  const evidenceLine = `Retention record: ${entEvidence} · ${cycleEvidence}.`;
  const lifetimeLine =
    lifetime === null
      ? `Subscriber lifetime: — neither measured nor assumed, so no LTV is computed. ${evidenceLine} Type an assumed lifetime below to model it; it will be labelled an assumption everywhere it appears.`
      : lifetime.basis === "measured"
        ? `Subscriber lifetime: ${fmtMonths(lifetime.months)} — MEASURED, as the mean BILLED tenure (cycles × cycle length, so a cancellation inside a paid period counts that whole period) of ${lifeEv.endedSubscriptions} completed subscriptions. ${evidenceLine}`
        : `Subscriber lifetime: ${fmtMonths(lifetime.months)} — YOUR ASSUMPTION, typed into the box below, not measured and not implied by anything in the data. ${evidenceLine}`;
  // The heading states the basis, because it is the one label that survives
  // being cropped out of a screenshot or pasted into a spreadsheet: an LTV
  // column with no stated lifetime is an LTV that will be quoted as a fact.
  const ltvHeading =
    lifetime === null
      ? "no lifetime assumed"
      : `${fmtMonths(lifetime.months)} (${lifetime.basis})`;

  // The commission actually PAID per referred sale of this plan, from the same
  // rows the Acquisition cost table sums. Per plan, not blended across plans: a
  // 20%-of-price commission is $2.00 on Home Basic and $9.80 on Teacher Pro+, so
  // one cross-plan mean would understate the cheap plans' ratios and OVERSTATE
  // the expensive ones — flattering, and invisible on the page. Null until a
  // referred sale of that plan has actually been collected, which is the whole
  // point: this is the denominator, and a denominator must be a real cost.
  const measuredAffiliateCacUsd = (planKeys: readonly string[]): number | null =>
    referralOk ? affiliateCacForPlans(referralRows, planKeys).perReferredSaleUsd : null;

  const ltvRows = b2cPlans.map((p) => {
    const margin = grossMarginPct(p.monthly, p.kitsMo, avgKitLife);
    const ltv = planLtv(p.monthly, margin, lifetime);
    // TWO affiliate CACs, and the difference between them is the difference
    // between a projection and a fact:
    //   · MODELLED — 20% of one month's list price. Arithmetic on a live program
    //     rate and a known price, so it is the right forward-looking number for
    //     "what will a referred customer cost"; but nobody has ever paid it,
    //     because no referred sale has ever happened. Shown, and labelled.
    //   · MEASURED — commission recorded against real referred sales of this
    //     plan. Null today. This is the ONLY one the ratio may divide by.
    // The ratio uses the measured one because a ratio is read as a verdict: a
    // verdict against a cost nobody has incurred is the single most misleading
    // figure this page could carry, and the LTV numerator is already gated on a
    // MEASURED lifetime for exactly the same reason (see ltvToCac). Both halves
    // real, or "—".
    const modelledAffCac = affiliateCommissionUsd(p.monthly);
    const measuredAffCac = measuredAffiliateCacUsd(p.planKeys);
    return {
      plan: p.plan,
      contributionMo: dash(ltv.contributionPerMonthUsd, fmtUsd),
      revenueLtv: dash(ltv.revenueLtvUsd, fmtUsd),
      contributionLtv: dash(ltv.contributionLtvUsd, fmtUsd),
      affiliateCac: fmtUsd(modelledAffCac),
      ratio: dash(ltvToCac(ltv, measuredAffCac), fmtRatio),
    };
  });

  // B2B: the assumed new-schools count priced at each band of the rate card
  // (one row per band — "if the assumed schools land this size"), plus the
  // live row for schools already on the platform, priced by real enrolment.
  const schoolsWithReal = new Set(
    profiles.filter((p) => p.school_id !== null).map((p) => p.school_id as string),
  );
  let liveUsd = 0;
  for (const schoolId of schoolsWithReal) {
    const students = profiles.filter((p) => p.school_id === schoolId && p.role === "student").length;
    liveUsd += bandForStudents(students)?.usdPerYear ?? 0;
  }
  // School gross margin: content cost is FLAT in enrolment (the 2026-08
  // cost-basis memo) — every school costs full-curriculum coverage at the
  // measured kit cost, whatever its band. Flat cost is why the bigger bands
  // carry the margin, and a percentage shows it starkly.
  const schoolGross = (revenueUsd: number, schools: number): string => {
    const g = grossMarginPct(revenueUsd, schools * SCHOOL_CURRICULUM_KITS_PER_YEAR, avgKitLife);
    return g === null ? "—" : fmtPct(g);
  };
  const b2bRows = [
    ...SCHOOL_BANDS.map((b) => ({
      band: `Band ${b.name}`,
      enrolment: `${b.range} students`,
      rate: `$${b.usdPerYear.toLocaleString("en-US")}`,
      schools: String(pipeline),
      value: fmtUsd(pipeline * b.usdPerYear),
      gross: schoolGross(pipeline * b.usdPerYear, pipeline),
    })),
    {
      band: "Live",
      enrolment: "actual enrolment",
      rate: "—",
      schools: String(schoolsWithReal.size),
      value: fmtUsd(liveUsd),
      gross: schoolGross(liveUsd, schoolsWithReal.size),
    },
  ];

  // ── CSV (same rows the tables show, footers as comment lines) ─────────────
  const csvSections: CsvSection[] = [
    {
      title: "What a kit costs us",
      header: ["Metric", "Last 30 days", "Lifetime"],
      rows: kitRows.map((r) => [r.label, r.d30, r.life]),
      footer: TABLE1_FOOTER,
    },
    {
      title: "By model route (avg cost per generation, lifetime)",
      header: ["Model route", "Generations", "With tracked cost", "Avg / generation", "Total"],
      rows: routes.map((r) => [
        r.bucket,
        r.generations,
        r.costedGens,
        r.avgPerGenUsd === null ? "—" : fmtUsd(r.avgPerGenUsd),
        fmtUsd(r.totalUsd),
      ]),
      footer: "Route = params.coverage_model on each generation; kits can mix models, so this is per generation.",
    },
    {
      title: "Actual revenue",
      header: ["Metric", "B2C", "B2B schools", "Total"],
      rows: revenueRows.map((r) => [r.label, r.b2c, r.b2b, r.total]),
      footer: TABLE2_FOOTER,
    },
    {
      // The basis column travels into the CSV verbatim: a forwarded file that
      // shows "—" without saying why is exactly the artefact that gets a number
      // invented to fill the gap.
      title: "Acquisition cost (CAC)",
      header: ["Input", "Amount", "Basis"],
      rows: cacRows.map((r) => [r.label, r.value, r.basis]),
      footer: CAC_FOOTER,
    },
    {
      title: "Estimated revenue — B2C (annual)",
      header: ["Plan", "Per month", "Base", "Gross margin", "10% conv", "25% conv", "50% conv"],
      rows: b2cRows.map((r) => [r.plan, r.monthly, r.base, r.margin, ...r.cells]),
      footer: TABLE3_B2C_FOOTER,
    },
    {
      // The title carries the lifetime AND its basis, because a CSV row of
      // dollar figures with no heading is precisely how an assumed LTV escapes
      // this page and turns into a quoted fact.
      title: `Lifetime value per subscriber (B2C) — ${ltvHeading}`,
      // Byte-identical to the rendered headers below. They used to differ —
      // the CSV said "affiliate CAC" where the screen said "CAC" — which put the
      // unqualified label on the artefact most likely to be cropped into a deck.
      header: [
        "Plan",
        "Contribution / mo",
        "LTV (revenue)",
        "LTV (contribution)",
        "Affiliate CAC (modelled)",
        "LTV : affiliate CAC (measured)",
      ],
      rows: ltvRows.map((r) => [
        r.plan,
        r.contributionMo,
        r.revenueLtv,
        r.contributionLtv,
        r.affiliateCac,
        r.ratio,
      ]),
      footer: `${lifetimeLine} ${LTV_FOOTER}`,
    },
    {
      title: "Estimated revenue — B2B schools (annual)",
      header: ["Band", "Enrolment", "Per school/yr", "Schools", "Annual USD", "Gross margin"],
      rows: b2bRows.map((r) => [r.band, r.enrolment, r.rate, r.schools, r.value, r.gross]),
      footer: TABLE3_B2B_FOOTER,
    },
  ];

  const dateStr = new Date(now).toISOString().slice(0, 10);

  const th = "px-5 py-2 text-xs text-[#5B6470] font-medium";
  const td = "px-5 py-2.5 text-sm";

  return (
    <main className="max-w-5xl mx-auto px-6 py-10 print:py-2">
      {/* Page-scoped print rule: the console header is rendered by the layout,
          so a print:hidden on the component would bleed into every console
          page. This <style> only exists while THIS page is mounted. */}
      <style>{`@media print { header { display: none !important } }`}</style>
      <p className="hidden print:block text-sm text-[#5B6470] mb-4">
        SketchCast financials — {dateStr}
      </p>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl mb-2">Financials</h1>
          <InkUnderline className="block h-3 w-28 mb-3 print:hidden" />
          <p className="text-xs text-[#98A0A9] mb-7">
            USD throughout. Excludes demo accounts. Assumptions printed under each table.
          </p>
        </div>
        <CsvButton sections={csvSections} />
      </div>

      {/* ── Table 1 ─────────────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-xl mb-3">What a kit costs us</h2>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[2fr_1fr_1fr] gap-2">
            <span className={th}>Measured</span>
            <span className={`${th} text-end`}>Last 30 days</span>
            <span className={`${th} text-end`}>Lifetime</span>
          </div>
          {kitRows.map((r) => (
            <div key={r.label} className="grid grid-cols-[2fr_1fr_1fr] gap-2">
              <span className={`${td} font-medium`}>{r.label}</span>
              <span className={`${td} tabular text-end`}>{r.d30}</span>
              <span className={`${td} tabular text-end`}>{r.life}</span>
            </div>
          ))}
        </div>

        <h3 className="text-sm font-medium mt-4 mb-2">By model route (avg cost per generation, lifetime)</h3>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-2">
            <span className={th}>Route</span>
            <span className={`${th} text-end`}>Generations</span>
            <span className={`${th} text-end`}>Avg / generation</span>
            <span className={`${th} text-end`}>Total</span>
          </div>
          {routes.map((r) => (
            <div key={r.bucket} className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-2">
              <span className={`${td} font-medium`}>{r.bucket}</span>
              <span className={`${td} tabular text-end`}>{r.generations}</span>
              <span className={`${td} tabular text-end`}>
                {r.avgPerGenUsd === null ? "—" : fmtUsd(r.avgPerGenUsd)}
              </span>
              <span className={`${td} tabular text-end`}>{fmtUsd(r.totalUsd)}</span>
            </div>
          ))}
          {routes.length === 0 && <div className="px-5 py-4 text-sm text-[#5B6470]">No generations yet.</div>}
        </div>
        <p className="text-[11px] text-[#98A0A9] mt-2">{TABLE1_FOOTER}</p>
      </section>

      {/* ── Table 2 ─────────────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-xl mb-3">Actual revenue</h2>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-2">
            <span className={th}>Metric</span>
            <span className={`${th} text-end`}>B2C</span>
            <span className={`${th} text-end`}>B2B schools</span>
            <span className={`${th} text-end`}>Total</span>
          </div>
          {revenueRows.map((r) => (
            <div key={r.label} className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-2">
              <span className={`${td} font-medium`}>{r.label}</span>
              <span className={`${td} tabular text-end`}>{r.b2c}</span>
              <span className={`${td} tabular text-end`}>{r.b2b}</span>
              <span
                className={`${td} tabular text-end ${
                  r.label === "Gross margin (30d)" && grossMargin30 < 0 ? "text-[#B4231F]" : ""
                }`}
              >
                {r.total}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-[#98A0A9] mt-2">{TABLE2_FOOTER}</p>
      </section>

      {/* ── Table 2b: acquisition cost ───────────────────────────────────── */}
      {/* Three columns rather than two: the "Basis" column is the point of the
          table today, since most of the Amount column is "—". A dash on its own
          invites a guess; a dash next to the missing input invites a fix. */}
      <section className="mb-10">
        <h2 className="text-xl mb-3">Acquisition cost (CAC)</h2>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[1.3fr_.7fr_3fr] gap-2 min-w-[680px]">
            <span className={th}>Input</span>
            <span className={`${th} text-end`}>Amount</span>
            <span className={th}>Basis / what would make it computable</span>
          </div>
          {cacRows.map((r) => (
            <div key={r.label} className="grid grid-cols-[1.3fr_.7fr_3fr] gap-2 min-w-[680px]">
              <span className={`${td} font-medium`}>{r.label}</span>
              <span className={`${td} tabular text-end`}>{r.value}</span>
              <span className="px-5 py-2.5 text-[11px] text-[#5B6470]">{r.basis}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-[#98A0A9] mt-2">{CAC_FOOTER}</p>
      </section>

      {/* ── Table 3a: B2C — plan × conversion matrix ─── */}
      <section className="mb-10">
        <h2 className="text-xl mb-3">Estimated revenue — B2C (annual)</h2>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[1.2fr_.8fr_1fr_.9fr_1fr_1fr_1fr] gap-2 min-w-[680px]">
            <span className={th}>Plan</span>
            <span className={`${th} text-end`}>Per month</span>
            <span className={`${th} text-end`}>Base</span>
            <span className={`${th} text-end`}>Gross margin</span>
            <span className={`${th} text-end`}>10% conv</span>
            <span className={`${th} text-end`}>25% conv</span>
            <span className={`${th} text-end`}>50% conv</span>
          </div>
          {b2cRows.map((r) => (
            <div key={r.plan} className="grid grid-cols-[1.2fr_.8fr_1fr_.9fr_1fr_1fr_1fr] gap-2 min-w-[680px]">
              <span className={`${td} font-medium`}>{r.plan}</span>
              <span className={`${td} tabular text-end`}>{r.monthly}</span>
              <span className={`${td} tabular text-end`}>{r.base}</span>
              <span className={`${td} tabular text-end text-[#0C8175] font-medium`}>{r.margin}</span>
              {r.cells.map((c, i) => (
                <span key={i} className={`${td} tabular text-end`}>{c}</span>
              ))}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-[#98A0A9] mt-2">{TABLE3_B2C_FOOTER}</p>

        {/* LTV lives INSIDE this section, as a sub-table of the margins above —
            same pattern as "By model route" under the kit-cost table. It is the
            Gross margin column multiplied by a lifetime, so it belongs against
            it and nowhere else. */}
        {/* SIX columns, at the same 680px the other cards use, so the whole
            table survives a print (Letter/A4 leave ~670–690px inside <main>'s
            padding, and a .card scrolls rather than paginating — at 760px the
            rightmost column, the ratio, simply vanished from paper). The column
            dropped to get there is "Per month": the table directly above prints
            the identical price for the identical plans in the identical order,
            from the same hoisted b2cPlans list.

            Every header carries its own basis — "(modelled)" vs "(measured)" —
            because these two are the labels that must survive being cropped
            into a deck, and they are the same strings the CSV exports. */}
        <h3 className="text-sm font-medium mt-6 mb-2">Lifetime value per subscriber — {ltvHeading}</h3>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[1.1fr_1fr_1fr_1.1fr_1.1fr_1.2fr] gap-2 min-w-[680px]">
            <span className={th}>Plan</span>
            <span className={`${th} text-end`}>Contribution / mo</span>
            <span className={`${th} text-end`}>LTV (revenue)</span>
            <span className={`${th} text-end`}>LTV (contribution)</span>
            <span className={`${th} text-end`}>Affiliate CAC (modelled)</span>
            <span className={`${th} text-end`}>LTV : affiliate CAC (measured)</span>
          </div>
          {ltvRows.map((r) => (
            <div
              key={r.plan}
              className="grid grid-cols-[1.1fr_1fr_1fr_1.1fr_1.1fr_1.2fr] gap-2 min-w-[680px]"
            >
              <span className={`${td} font-medium`}>{r.plan}</span>
              {/* Teal, unconditionally and on the same rule as the Gross margin
                  cell it is derived from one table up: price × a measured
                  margin, with no assumption in it at all. planLtv() returns null
                  when no kit cost has been measured, so this renders "—" rather
                  than a coloured fake. */}
              <span className={`${td} tabular text-end text-[#0C8175] font-medium`}>{r.contributionMo}</span>
              <span className={`${td} tabular text-end`}>{r.revenueLtv}</span>
              {/* Only the MEASURED half is coloured. An assumed LTV is printed
                  in the same plain ink as everything provisional — the teal is
                  reserved for figures that rest on a measurement. */}
              <span
                className={`${td} tabular text-end ${
                  lifetime?.basis === "measured" ? "text-[#0C8175] font-medium" : ""
                }`}
              >
                {r.contributionLtv}
              </span>
              {/* Plain ink on purpose: a modelled cost that has never been
                  incurred must not print with the weight of the measured
                  contribution beside it. Its header carries "(modelled)". */}
              <span className={`${td} tabular text-end`}>{r.affiliateCac}</span>
              <span className={`${td} tabular text-end`}>{r.ratio}</span>
            </div>
          ))}
        </div>

        {/* The assumption, stated above its own input so it cannot be read
            without its basis. Amber while it is an assumption; plain once a
            measurement replaces it. */}
        <p
          className={`text-[11px] mt-2 ${
            lifetime?.basis === "assumed" ? "text-[#8A6100]" : "text-[#98A0A9]"
          }`}
        >
          {lifetimeLine}
        </p>

        <form method="get" className="print:hidden mt-3 flex items-center gap-2 text-sm">
          {/* Each GET form submits ONLY its own fields, so without this carrier
              modelling a lifetime would silently reset the school pipeline
              scenario (and vice versa below). Only carried when the reader
              actually set it — otherwise the default stays implicit in the URL. */}
          {pipelineRaw !== undefined && <input type="hidden" name="pipeline" value={String(pipeline)} />}
          <label htmlFor="lifetime" className="text-[#5B6470]">
            Assumed subscriber lifetime (months)
          </label>
          <input
            id="lifetime"
            name="lifetime"
            type="number"
            min={1}
            step={1}
            placeholder="none"
            defaultValue={assumedLifetimeMonths ?? ""}
            className="w-24 rounded-lg border border-[#E6E8E4] bg-white px-2 py-1 tabular"
          />
          <button className="rounded-lg border border-[#E6E8E4] bg-white px-3 py-1 hover:border-[#1FB8A6]">
            Model it
          </button>
          <span className="text-[11px] text-[#98A0A9]">Empty = no LTV shown.</span>
        </form>
        <p className="text-[11px] text-[#98A0A9] mt-2">{LTV_FOOTER}</p>
      </section>

      {/* ── Table 3b: B2B schools ────────────────────── */}
      <section className="mb-10">
        <h2 className="text-xl mb-3">Estimated revenue — B2B schools (annual)</h2>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[.8fr_1.3fr_1fr_.7fr_1.1fr_1.1fr] gap-2 min-w-[640px]">
            <span className={th}>Band</span>
            <span className={th}>Enrolment</span>
            <span className={`${th} text-end`}>Per school/yr</span>
            <span className={`${th} text-end`}>Schools</span>
            <span className={`${th} text-end`}>Annual USD</span>
            <span className={`${th} text-end`}>Gross margin</span>
          </div>
          {b2bRows.map((r) => (
            <div key={r.band} className="grid grid-cols-[.8fr_1.3fr_1fr_.7fr_1.1fr_1.1fr] gap-2 min-w-[640px]">
              <span className={`${td} font-medium`}>{r.band}</span>
              <span className={td}>{r.enrolment}</span>
              <span className={`${td} tabular text-end`}>{r.rate}</span>
              <span className={`${td} tabular text-end`}>{r.schools}</span>
              <span className={`${td} tabular text-end`}>{r.value}</span>
              <span className={`${td} tabular text-end text-[#0C8175]`}>{r.gross}</span>
            </div>
          ))}
        </div>
        <form method="get" className="print:hidden mt-3 flex items-center gap-2 text-sm">
          {/* Carries the lifetime assumption across this submit — see the note
              on the lifetime form above. */}
          {assumedLifetimeMonths !== null && (
            <input type="hidden" name="lifetime" value={String(assumedLifetimeMonths)} />
          )}
          <label htmlFor="pipeline" className="text-[#5B6470]">
            Assumed new schools in year 1
          </label>
          <input
            id="pipeline"
            name="pipeline"
            type="number"
            min={0}
            step={1}
            defaultValue={pipeline}
            className="w-24 rounded-lg border border-[#E6E8E4] bg-white px-2 py-1 tabular"
          />
          <button className="rounded-lg border border-[#E6E8E4] bg-white px-3 py-1 hover:border-[#1FB8A6]">
            Update
          </button>
        </form>
        <p className="text-[11px] text-[#98A0A9] mt-2">{TABLE3_B2B_FOOTER}</p>
      </section>
    </main>
  );
}
