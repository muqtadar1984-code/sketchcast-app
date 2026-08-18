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
  MYR_PER_USD,
  type CsvSection,
  type EntitlementRow,
  type FinGenRow,
  type FinJobRow,
  type PaymentRow,
} from "@/utils/financials";
import CsvButton from "./csv-button";

// Financials — what a kit costs us (measured), what we actually collect, and
// what the current user base could plausibly become. Three tables, every
// hardcoded assumption printed under its table, so a screenshot (or the CSV)
// stands on its own in an investor or partner thread. USD throughout.
// Server component, service role only; the layout has verified staff access.

export const dynamic = "force-dynamic";

const DAY = 86400000;

const TABLE1_FOOTER =
  "Measured from jobs.usage (AI generation cost only — infra excluded). Averages use cost-tracked rows only — some early jobs predate tracking, so AI spend ÷ kit count differs slightly. Demo accounts excluded.";
const TABLE2_FOOTER =
  `Prices: Teacher Pro $24/mo, Teacher Pro+ $49/mo, Home Basic (family_*) $9.99/mo, Homeschool $34/mo (annual plans at annual/12); ` +
  `school floor $3,000/yr → $250/mo. Stripe school payments (MYR) converted at RM${MYR_PER_USD.toFixed(2)}/USD. ` +
  `Update alongside pricing. Demo accounts excluded.`;
const TABLE3_B2C_FOOTER =
  "Prices: Teacher Pro $24 · Teacher Pro+ $49 · Home Basic $9.99 · Homeschool $34 per month; annual = 12×. " +
  "Teachers = active non-demo teacher accounts; parents = non-demo parent accounts (home educators included). " +
  "Each column assumes that share of the row's base converts to that plan — rows are ALTERNATIVE scenarios, " +
  "never additive. Estimates, not forecasts.";
const TABLE3_B2B_FOOTER =
  "Rate card: Band A ≤350 students $3,000 · Band B 351–700 $5,000 · Band C 701–1,200 $7,000 " +
  "per school per year; schools above 1,200 are priced individually (shown at Band C). " +
  "Assumes the entered number of new schools in year 1 — change it below or via ?pipeline=N " +
  "(the link carries the scenario). Estimates, not forecasts.";

function dash(v: number | null, fmt: (n: number) => string): string {
  return v === null ? "—" : fmt(v);
}

export default async function ConsoleFinancialsPage({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string }>;
}) {
  const { pipeline: pipelineRaw } = await searchParams;
  // ?pipeline=N — assumed new schools in year 1, carried in the URL so a
  // scenario link is shareable. Defaults to the founder's 10-schools-in-year-1
  // assumption; an explicit ?pipeline=0 zeroes it; junk is treated as absent.
  const parsed = Math.floor(Number(pipelineRaw));
  const pipeline = pipelineRaw === undefined || !Number.isFinite(parsed) ? 10 : Math.max(0, parsed);

  const admin = createAdminClient();

  // TODO: these are unbounded-ish selects capped well above today's volume
  // (197 costed jobs, 190 generations). PostgREST silently stops at its
  // default page on an uncapped select, so the caps are explicit; once volume
  // outgrows one page, move to DB-side grouped counts instead of raising them.
  const [profilesQ, booksQ, gensQ, entsQ, paymentsQ, jobsQ] = await Promise.all([
    admin.from("profiles").select("id, role, school_id, is_demo"),
    admin.from("books").select("id, owner_id"),
    admin
      .from("generations")
      .select("id, owner_id, book_id, chapter_ref, params, created_at")
      .limit(5000),
    admin.from("entitlements").select("user_id, school_id, plan_key, active, status, current_period_end"),
    admin.from("payments").select("user_id, school_id, plan_key, amount, currency, status, created_at"),
    admin.from("jobs").select("generation_id, book_id, usage, created_at").limit(5000),
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

  // ── Table 3: estimated revenue (annual) ───────────────────────────────────
  // One row per consumer plan, one column per conversion rate (founder,
  // 2026-08-18). Teachers convert to the teacher plans, parents (home
  // educators included) to the home plans; a row assumes that share of ITS
  // base converts to THAT plan, so rows are alternative scenarios — summing
  // them would double-count the same people.
  const teachers = profiles.filter((p) => p.role === "teacher").length;
  const parents = profiles.filter((p) => p.role === "parent").length;
  const B2C_RATES = [0.1, 0.25, 0.5];
  const b2cRows = [
    { plan: "Teacher Pro", monthly: PLAN_PRICES_USD_MONTHLY.teacher_pro_monthly, base: teachers, baseLabel: "teachers" },
    { plan: "Teacher Pro+", monthly: PLAN_PRICES_USD_MONTHLY.teacher_pro_plus_monthly, base: teachers, baseLabel: "teachers" },
    { plan: "Home Basic", monthly: PLAN_PRICES_USD_MONTHLY.family_monthly, base: parents, baseLabel: "parents" },
    { plan: "Homeschool", monthly: PLAN_PRICES_USD_MONTHLY.homeschool_monthly, base: parents, baseLabel: "parents" },
  ].map((p) => ({
    plan: p.plan,
    monthly: `$${p.monthly.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    base: `${p.base} ${p.baseLabel}`,
    cells: B2C_RATES.map((rate) => fmtUsd(conversionScenario(p.base, rate, p.monthly).annualUsd)),
  }));

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
  const b2bRows = [
    ...SCHOOL_BANDS.map((b) => ({
      band: `Band ${b.name}`,
      enrolment: `${b.range} students`,
      rate: `$${b.usdPerYear.toLocaleString("en-US")}`,
      schools: String(pipeline),
      value: fmtUsd(pipeline * b.usdPerYear),
    })),
    {
      band: "Live",
      enrolment: "actual enrolment",
      rate: "—",
      schools: String(schoolsWithReal.size),
      value: fmtUsd(liveUsd),
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
      title: "Estimated revenue — B2C (annual)",
      header: ["Plan", "Per month", "Base", "10% conv", "25% conv", "50% conv"],
      rows: b2cRows.map((r) => [r.plan, r.monthly, r.base, ...r.cells]),
      footer: TABLE3_B2C_FOOTER,
    },
    {
      title: "Estimated revenue — B2B schools (annual)",
      header: ["Band", "Enrolment", "Per school/yr", "Schools", "Annual USD"],
      rows: b2bRows.map((r) => [r.band, r.enrolment, r.rate, r.schools, r.value]),
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

      {/* ── Table 3a: B2C — plan × conversion matrix ─── */}
      <section className="mb-10">
        <h2 className="text-xl mb-3">Estimated revenue — B2C (annual)</h2>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[1.3fr_.8fr_1.1fr_1fr_1fr_1fr] gap-2 min-w-[640px]">
            <span className={th}>Plan</span>
            <span className={`${th} text-end`}>Per month</span>
            <span className={`${th} text-end`}>Base</span>
            <span className={`${th} text-end`}>10% conv</span>
            <span className={`${th} text-end`}>25% conv</span>
            <span className={`${th} text-end`}>50% conv</span>
          </div>
          {b2cRows.map((r) => (
            <div key={r.plan} className="grid grid-cols-[1.3fr_.8fr_1.1fr_1fr_1fr_1fr] gap-2 min-w-[640px]">
              <span className={`${td} font-medium`}>{r.plan}</span>
              <span className={`${td} tabular text-end`}>{r.monthly}</span>
              <span className={`${td} tabular text-end`}>{r.base}</span>
              {r.cells.map((c, i) => (
                <span key={i} className={`${td} tabular text-end`}>{c}</span>
              ))}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-[#98A0A9] mt-2">{TABLE3_B2C_FOOTER}</p>
      </section>

      {/* ── Table 3b: B2B schools ────────────────────── */}
      <section className="mb-10">
        <h2 className="text-xl mb-3">Estimated revenue — B2B schools (annual)</h2>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[.9fr_1.4fr_1.1fr_.8fr_1.2fr] gap-2 min-w-[560px]">
            <span className={th}>Band</span>
            <span className={th}>Enrolment</span>
            <span className={`${th} text-end`}>Per school/yr</span>
            <span className={`${th} text-end`}>Schools</span>
            <span className={`${th} text-end`}>Annual USD</span>
          </div>
          {b2bRows.map((r) => (
            <div key={r.band} className="grid grid-cols-[.9fr_1.4fr_1.1fr_.8fr_1.2fr] gap-2 min-w-[560px]">
              <span className={`${td} font-medium`}>{r.band}</span>
              <span className={td}>{r.enrolment}</span>
              <span className={`${td} tabular text-end`}>{r.rate}</span>
              <span className={`${td} tabular text-end`}>{r.schools}</span>
              <span className={`${td} tabular text-end`}>{r.value}</span>
            </div>
          ))}
        </div>
        <form method="get" className="print:hidden mt-3 flex items-center gap-2 text-sm">
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
