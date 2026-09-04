import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import { schoolLifecycle, daysUntil, type SchoolLifecycle } from "@/utils/school-lifecycle";
import SchoolControls from "./school-controls";

// One school (0101, Phase 2): what the form told us, the derived lifecycle,
// the licence, who is in it and what they made, the private registration
// half, the staff audit trail, and the levers.

export const dynamic = "force-dynamic";

const CHIP: Record<SchoolLifecycle, string> = {
  trial: "bg-[#FFF1D6] text-[#9A6400]",
  expired: "bg-[#FFE9E3] text-[#B3401F]",
  paid: "bg-[#E2F4F1] text-[#0C8175]",
  suspended: "bg-[#FFE9E3] text-[#B3401F]",
  legacy: "bg-[#EEF0EC] text-[#5B6470]",
};

const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : "—");

export default async function ConsoleSchoolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = createAdminClient();
  const now = new Date();

  const { data: schoolRaw } = await admin.from("schools").select("*").eq("id", id).maybeSingle();
  if (!schoolRaw) notFound();
  const s = schoolRaw as Record<string, unknown>;
  const meta = (s.meta ?? {}) as { school_type?: string; size_band?: string; curricula?: string[]; source?: string };

  const [regQ, entsQ, profilesQ, auditQ] = await Promise.all([
    admin.from("school_registrations").select("*").eq("school_id", id).maybeSingle(),
    admin.from("entitlements").select("user_id, active, plan_key, provider, status, current_period_end").eq("school_id", id),
    admin.from("profiles").select("id, role, full_name, created_at").eq("school_id", id),
    admin
      .from("platform_audit_log")
      .select("action, detail, created_at, actor_id")
      .eq("target_id", id)
      .order("created_at", { ascending: false })
      .limit(15),
  ]);

  const reg = (regQ.data ?? null) as Record<string, unknown> | null;
  const ents = (entsQ.data ?? []) as {
    user_id: string;
    active: boolean;
    plan_key: string | null;
    provider: string | null;
    status: string | null;
    current_period_end: string | null;
  }[];
  const lifecycle = schoolLifecycle(
    { status: s.status as string, trial_ends_at: (s.trial_ends_at as string | null) ?? null },
    ents,
    now,
  );
  const licence = ents.find(
    (e) =>
      e.active &&
      (e.plan_key ?? "").startsWith("school") &&
      (!e.current_period_end || new Date(e.current_period_end).getTime() > now.getTime()),
  );

  const profiles = (profilesQ.data ?? []) as { id: string; role: string; full_name: string | null; created_at: string }[];
  const count = (role: string) => profiles.filter((p) => p.role === role).length;
  const memberIds = profiles.map((p) => p.id);

  // Usage — by every member, split the way the trial KPI is worded: lessons vs documents.
  let lessonsDone = 0;
  let docsDone = 0;
  let books = 0;
  if (memberIds.length) {
    const [gensQ, booksQ] = await Promise.all([
      admin.from("generations").select("kind, status").in("owner_id", memberIds),
      admin.from("books").select("id", { count: "exact", head: true }).in("owner_id", memberIds),
    ]);
    for (const g of (gensQ.data ?? []) as { kind: string; status: string }[]) {
      if (g.status !== "done") continue;
      if (g.kind === "presentation") lessonsDone++;
      else docsDone++;
    }
    books = booksQ.count ?? 0;
  }

  // The registrant: the creator when self-serve, else the first admin.
  const adminProfile =
    profiles.find((p) => p.id === (s.created_by as string | null)) ??
    profiles.find((p) => p.role === "school_admin") ??
    null;
  let adminEmail = "";
  let lastSignIn: string | null = null;
  if (adminProfile) {
    try {
      const { data: u } = await admin.auth.admin.getUserById(adminProfile.id);
      adminEmail = u?.user?.email ?? "";
      lastSignIn = u?.user?.last_sign_in_at ?? null;
    } catch {
      // profile-only
    }
  }

  const days = daysUntil((s.trial_ends_at as string | null) ?? null, now);
  const trialLine =
    days === null
      ? "no clock (predates self-serve)"
      : days > 0
        ? `${fmtDate(s.trial_ends_at as string)} · ${days} day${days === 1 ? "" : "s"} left`
        : `ended ${fmtDate(s.trial_ends_at as string)} · ${-days} day${-days === 1 ? "" : "s"} ago`;

  const facts: { label: string; value: string }[] = [
    { label: "Portal", value: s.slug ? `school.sketchcast.app/${s.slug as string}` : "—" },
    { label: "Status", value: `${s.status as string} · ${lifecycle}` },
    { label: "Country", value: (s.country as string) || "—" },
    { label: "Contact", value: (s.contact_email as string) || "—" },
    { label: "Domain", value: (s.email_domain as string) || "—" },
    { label: "Type · size", value: `${meta.school_type || "—"} · ${meta.size_band || "—"}` },
    { label: "Curricula", value: meta.curricula?.length ? meta.curricula.join(", ") : "—" },
    { label: "Source", value: meta.source || "seeded / staff" },
    { label: "Created", value: fmtDate(s.created_at as string) },
    { label: "Trial", value: trialLine },
    {
      label: "Licence",
      value: licence
        ? `${licence.plan_key} · ${licence.provider ?? "?"} · ${licence.status ?? ""} · until ${fmtDate(licence.current_period_end)}`
        : "none",
    },
    {
      label: "People",
      value: `${count("school_admin")} admin · ${count("teacher") + count("coordinator")} teachers · ${count("student")} students · ${count("parent")} parents`,
    },
    { label: "Usage", value: `${lessonsDone} lessons · ${docsDone} documents · ${books} books` },
    {
      label: "Registrant",
      value: adminProfile ? `${adminProfile.full_name || "—"} <${adminEmail || "—"}>` : "— (no admin account)",
    },
    { label: "Last sign-in", value: lastSignIn ? new Date(lastSignIn).toLocaleString() : "never" },
  ];

  const privateFacts: { label: string; value: string }[] = reg
    ? [
        { label: "Their role", value: (reg.registrant_role as string) || "—" },
        { label: "Phone", value: (reg.phone as string) || "—" },
        { label: "Heard from", value: (reg.heard_from as string) || "—" },
        { label: "Registered from IP", value: (reg.reg_ip as string) || "—" },
        { label: "Asked to activate", value: reg.activation_requested_at ? new Date(reg.activation_requested_at as string).toLocaleString() : "no" },
        { label: "Invoice", value: (reg.hosted_invoice_url as string) || "none issued" },
      ]
    : [];

  const audit = (auditQ.data ?? []) as { action: string; detail: Record<string, unknown> | null; created_at: string; actor_id: string | null }[];

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <p className="mb-4 text-sm">
        <Link href="/console/schools" className="text-[#0C8175] hover:underline">
          <span className="rtl-flip">←</span> Schools
        </Link>
      </p>
      <h1 className="text-3xl mb-2">
        {(s.display_name as string) || (s.name as string) || "School"}
        <span className={`chip font-sans ms-3 align-middle ${CHIP[lifecycle]}`}>{lifecycle}</span>
        {!!reg?.activation_requested_at && (
          <span className="chip font-sans ms-2 align-middle bg-[#E2F4F1] text-[#0C8175]">wants activation</span>
        )}
      </h1>
      <InkUnderline className="block h-3 w-28 mb-6" />

      <div className="grid lg:grid-cols-[1.2fr_1fr] gap-6 items-start">
        <div className="space-y-4">
          <div className="card px-5 py-4 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {facts.map((f) => (
              <p key={f.label}>
                <span className="text-[#5B6470]">{f.label}: </span>
                <span className="font-medium break-all">{f.value}</span>
              </p>
            ))}
          </div>

          {privateFacts.length > 0 && (
            <div className="card px-5 py-4">
              <p className="text-xs font-medium text-[#5B6470] mb-2">Registration (console-only)</p>
              <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                {privateFacts.map((f) => (
                  <p key={f.label}>
                    <span className="text-[#5B6470]">{f.label}: </span>
                    <span className="font-medium break-all">{f.value}</span>
                  </p>
                ))}
              </div>
              {!!reg?.sales_notes && (
                <p className="mt-3 text-sm whitespace-pre-wrap border-t border-[#EEF0EC] pt-3">{reg.sales_notes as string}</p>
              )}
            </div>
          )}

          {profiles.length > 0 && (
            <div className="card divide-y divide-[#EEF0EC]">
              <p className="px-5 py-2 text-xs font-medium text-[#5B6470]">People</p>
              {profiles
                .filter((p) => p.role !== "student")
                .map((p) => (
                  <Link key={p.id} href={`/console/users/${p.id}`} className="px-5 py-2.5 flex items-center justify-between text-sm hover:bg-[#FAFBF9]">
                    <span className="truncate font-medium">{p.full_name || "—"}</span>
                    <span className="text-xs text-[#5B6470]">{p.role}</span>
                  </Link>
                ))}
              {count("student") > 0 && (
                <p className="px-5 py-2 text-xs text-[#5B6470]">+ {count("student")} students</p>
              )}
            </div>
          )}

          {audit.length > 0 && (
            <div className="card divide-y divide-[#EEF0EC]">
              <p className="px-5 py-2 text-xs font-medium text-[#5B6470]">Staff actions</p>
              {audit.map((a, i) => (
                <div key={i} className="px-5 py-2.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{a.action}</span>
                    <span className="text-xs text-[#5B6470]">{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                  {a.detail && Object.keys(a.detail).length > 0 && (
                    <p className="text-xs text-[#5B6470] font-mono break-all mt-0.5">{JSON.stringify(a.detail)}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <SchoolControls
          schoolId={id}
          status={s.status as string}
          lifecycle={lifecycle}
          trialEndsAt={(s.trial_ends_at as string | null) ?? null}
          licenceEnd={licence?.current_period_end ?? null}
          salesStage={(reg?.sales_stage as string | null) ?? null}
          salesNotes={(reg?.sales_notes as string | null) ?? null}
          stripeReady={!!process.env.STRIPE_SECRET_KEY}
          invoiceUrl={(reg?.hosted_invoice_url as string | null) ?? null}
        />
      </div>
    </main>
  );
}
