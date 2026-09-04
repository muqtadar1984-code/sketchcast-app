import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import { buildFunnel, pct, STEPS, type FunnelSchool, type Step } from "@/utils/school-funnel";
import { schoolLifecycle } from "@/utils/school-lifecycle";

// The school acquisition funnel (Phase 5): registered → confirmed → first
// generation → lesson AND document → came back → asked to activate → invoiced
// → paid, overall and by weekly cohort. Computed from the tables that already
// exist — no event pipeline. Self-serve schools only: a seeded or staff-made
// school never went through the funnel.
//
// The step BEFORE this page — landing page → /schoolsignup — lives in Vercel
// Web Analytics, which has to be switched on in the Vercel dashboard.

export const dynamic = "force-dynamic";

const LABEL: Record<Step, string> = {
  registered: "Registered",
  confirmed: "Email confirmed",
  first_generation: "First generation",
  lesson_and_document: "Lesson + document",
  returned: "Came back (day 2+)",
  activation_requested: "Asked to activate",
  invoice_sent: "Invoiced",
  paid: "Paid",
};

export default async function ConsoleFunnelPage() {
  const admin = createAdminClient();
  const now = new Date();

  const [schoolsQ, regsQ, entsQ, profilesQ] = await Promise.all([
    admin.from("schools").select("id, status, created_at, created_by, trial_ends_at, meta"),
    admin.from("school_registrations").select("school_id, activation_requested_at, sales_stage, stripe_invoice_id"),
    admin.from("entitlements").select("school_id, active, plan_key, current_period_end").not("school_id", "is", null),
    admin.from("profiles").select("id, school_id"),
  ]);

  type SchoolRow = { id: string; status: string; created_at: string; created_by: string | null; trial_ends_at: string | null; meta: { source?: string } | null };
  const schools = ((schoolsQ.data ?? []) as SchoolRow[]).filter((s) => s.meta?.source === "self_serve");
  const regs = new Map(
    ((regsQ.data ?? []) as { school_id: string; activation_requested_at: string | null; sales_stage: string | null; stripe_invoice_id: string | null }[]).map(
      (r) => [r.school_id, r] as const,
    ),
  );
  const ents = new Map<string, { active: boolean; plan_key: string | null; current_period_end: string | null }[]>();
  for (const e of (entsQ.data ?? []) as { school_id: string; active: boolean; plan_key: string | null; current_period_end: string | null }[]) {
    ents.set(e.school_id, [...(ents.get(e.school_id) ?? []), e]);
  }
  const membersOf = new Map<string, string[]>();
  for (const p of (profilesQ.data ?? []) as { id: string; school_id: string | null }[]) {
    if (p.school_id) membersOf.set(p.school_id, [...(membersOf.get(p.school_id) ?? []), p.id]);
  }

  // Generations by every member of every self-serve school, in one query.
  const memberIds = schools.flatMap((s) => membersOf.get(s.id) ?? []);
  const ownerSchool = new Map<string, string>();
  for (const s of schools) for (const m of membersOf.get(s.id) ?? []) ownerSchool.set(m, s.id);
  const usage = new Map<string, { first: string | null; lessons: number; docs: number }>();
  if (memberIds.length) {
    const { data: gens } = await admin
      .from("generations")
      .select("owner_id, kind, status, created_at")
      .in("owner_id", memberIds)
      .neq("status", "error");
    for (const g of (gens ?? []) as { owner_id: string; kind: string; status: string; created_at: string }[]) {
      const sid = ownerSchool.get(g.owner_id);
      if (!sid) continue;
      const u = usage.get(sid) ?? { first: null, lessons: 0, docs: 0 };
      if (!u.first || g.created_at < u.first) u.first = g.created_at;
      if (g.status === "done") {
        if (g.kind === "presentation") u.lessons++;
        else u.docs++;
      }
      usage.set(sid, u);
    }
  }

  // The registrant's auth facts — one lookup per school; the cohort is small.
  const authFacts = new Map<string, { confirmed: string | null; lastSignIn: string | null }>();
  await Promise.all(
    schools.map(async (s) => {
      if (!s.created_by) return;
      try {
        const { data: u } = await admin.auth.admin.getUserById(s.created_by);
        authFacts.set(s.id, { confirmed: u?.user?.email_confirmed_at ?? null, lastSignIn: u?.user?.last_sign_in_at ?? null });
      } catch {
        // counted as unconfirmed
      }
    }),
  );

  const rows: FunnelSchool[] = schools.map((s) => {
    const reg = regs.get(s.id);
    const u = usage.get(s.id);
    const a = authFacts.get(s.id);
    return {
      id: s.id,
      created_at: s.created_at,
      confirmed_at: a?.confirmed ?? null,
      last_sign_in_at: a?.lastSignIn ?? null,
      first_generation_at: u?.first ?? null,
      lessons_done: u?.lessons ?? 0,
      docs_done: u?.docs ?? 0,
      activation_requested_at: reg?.activation_requested_at ?? null,
      invoice_sent: !!reg?.stripe_invoice_id || reg?.sales_stage === "invoice_sent",
      paid: schoolLifecycle({ status: s.status, trial_ends_at: s.trial_ends_at }, ents.get(s.id) ?? [], now) === "paid",
    };
  });
  const funnel = buildFunnel(rows);

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Funnel</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-6">
        Self-serve schools, from registration to payment. {rows.length} registered so far. The step before this —
        landing page → registration — is in Vercel Web Analytics.{" "}
        <Link href="/console/schools" className="text-[#0C8175] hover:underline">
          Open the schools list
        </Link>
        .
      </p>

      <div className="card px-5 py-4 mb-6">
        <p className="text-xs font-medium text-[#5B6470] mb-3">All time</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          {STEPS.map((step) => {
            const n = funnel.total[step];
            const p = pct(n, funnel.total.registered);
            return (
              <div key={step}>
                <p className="text-2xl tabular">{n}</p>
                <p className="text-xs text-[#5B6470]">{LABEL[step]}</p>
                {p !== null && step !== "registered" && <p className="text-[10px] text-[#98A0A9]">{p}%</p>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card divide-y divide-[#EEF0EC] overflow-x-auto">
        <div className="grid grid-cols-[1.2fr_repeat(8,1fr)] gap-3 px-5 py-2 text-xs text-[#5B6470] font-medium min-w-[56rem]">
          <span>Week of</span>
          {STEPS.map((step) => (
            <span key={step} className="text-end">
              {LABEL[step]}
            </span>
          ))}
        </div>
        {funnel.cohorts.map((c) => (
          <div key={c.week} className="grid grid-cols-[1.2fr_repeat(8,1fr)] gap-3 px-5 py-2.5 text-sm items-center min-w-[56rem]">
            <span className="font-mono text-xs">{c.week}</span>
            {STEPS.map((step) => {
              const n = c.counts[step];
              const p = pct(n, c.size);
              return (
                <span key={step} className="tabular text-end">
                  {n}
                  {step !== "registered" && p !== null && <span className="text-[10px] text-[#98A0A9]"> ({p}%)</span>}
                </span>
              );
            })}
          </div>
        ))}
        {funnel.cohorts.length === 0 && (
          <div className="px-5 py-6 text-sm text-[#5B6470]">No self-serve registrations yet — the funnel fills in from the first one.</div>
        )}
      </div>
    </main>
  );
}
