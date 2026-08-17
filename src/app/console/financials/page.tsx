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
  schoolBlocks,
  SCHOOL_FLOOR_USD_PER_YEAR,
  STUDENTS_PER_BLOCK,
  TEACHER_PRO_USD_PER_MONTH,
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
  `Prices: Teacher Pro $24/mo, Teacher Pro+ $49/mo, Family $9.99/mo (annual plans at annual/12); ` +
  `school floor $3,000/yr → $250/mo. Stripe school payments (MYR) converted at RM${MYR_PER_USD.toFixed(2)}/USD. ` +
  `Update alongside pricing. Demo accounts excluded.`;
const TABLE3_FOOTER =
  "Assumptions: Teacher Pro $24/mo; school floor $3,000/yr per 350 students (ceil); " +
  "teachers counted = all active non-demo teacher accounts. Estimates, not forecasts.";

function dash(v: number | null, fmt: (n: number) => string): string {
  return v === null ? "—" : fmt(v);
}

export default async function ConsoleFinancialsPage({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string }>;
}) {
  const { pipeline: pipelineRaw } = await searchParams;
  // ?pipeline=N — schools in discussion, carried in the URL so a scenario link
  // is shareable. Anything unparseable is just 0, never an error.
  const pipeline = Math.max(0, Math.floor(Number(pipelineRaw)) || 0);

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
  const teachers = profiles.filter((p) => p.role === "teacher").length;
  const scenarios = [0.1, 0.25, 0.5].map((rate) => ({ rate, ...conversionScenario(teachers, rate) }));

  // B2B floor: schools with at least one real (non-demo) member, priced by
  // their real student count in 350-student blocks.
  const schoolsWithReal = new Set(
    profiles.filter((p) => p.school_id !== null).map((p) => p.school_id as string),
  );
  let floorBlocks = 0;
  for (const schoolId of schoolsWithReal) {
    const students = profiles.filter((p) => p.school_id === schoolId && p.role === "student").length;
    floorBlocks += schoolBlocks(students);
  }
  const floorUsd = floorBlocks * SCHOOL_FLOOR_USD_PER_YEAR;
  const pipelineUsd = pipeline * SCHOOL_FLOOR_USD_PER_YEAR;

  const estimateRows: { label: string; value: string }[] = [
    ...scenarios.map((s) => ({
      label: `${Math.round(s.rate * 100)}% conversion — ${s.paying} of ${teachers} active teachers × $${TEACHER_PRO_USD_PER_MONTH}/mo × 12`,
      value: fmtUsd(s.annualUsd),
    })),
    {
      label: `B2B floor — ceil(students/${STUDENTS_PER_BLOCK}) × $${SCHOOL_FLOOR_USD_PER_YEAR.toLocaleString("en-US")}/yr across ${schoolsWithReal.size} school${schoolsWithReal.size === 1 ? "" : "s"} with real members (${floorBlocks} block${floorBlocks === 1 ? "" : "s"})`,
      value: fmtUsd(floorUsd),
    },
    {
      label: `B2B pipeline — ${pipeline} school${pipeline === 1 ? "" : "s"} in discussion × $${SCHOOL_FLOOR_USD_PER_YEAR.toLocaleString("en-US")}/yr`,
      value: fmtUsd(pipelineUsd),
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
      title: "Estimated revenue (annual)",
      header: ["Scenario", "Annual USD"],
      rows: estimateRows.map((r) => [r.label, r.value]),
      footer: TABLE3_FOOTER,
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

      {/* ── Table 3 ─────────────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-xl mb-3">Estimated revenue (annual)</h2>
        <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
          <div className="grid grid-cols-[3fr_1fr] gap-2">
            <span className={th}>Scenario</span>
            <span className={`${th} text-end`}>Annual USD</span>
          </div>
          {estimateRows.map((r) => (
            <div key={r.label} className="grid grid-cols-[3fr_1fr] gap-2">
              <span className={td}>{r.label}</span>
              <span className={`${td} tabular text-end`}>{r.value}</span>
            </div>
          ))}
        </div>
        {/* GET form — the scenario rides in the URL (?pipeline=N), so the link
            itself carries it into a chat or an email. Input chrome hidden on
            print; the pipeline ROW above still prints with its N. */}
        <form method="get" className="print:hidden mt-3 flex items-center gap-2 text-sm">
          <label htmlFor="pipeline" className="text-[#5B6470]">
            Schools in discussion
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
        <p className="text-[11px] text-[#98A0A9] mt-2">{TABLE3_FOOTER}</p>
      </section>
    </main>
  );
}
