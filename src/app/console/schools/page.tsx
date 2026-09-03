import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import {
  schoolLifecycle,
  daysUntil,
  duplicateFlags,
  sortSchools,
  type SchoolLifecycle,
  type DupFlag,
} from "@/utils/school-lifecycle";

// The registrations view (0100, Phase 2): one row per school with its derived
// lifecycle (mirrors plan_tier — never hand-set), the qualification data the
// form collected, usage, the founder's sales stage, and "same organisation?"
// flags. Default order is the hot/cold signal: live trials ending soonest on
// top. Click a row for the school page and its controls.

export const dynamic = "force-dynamic";

const CHIP: Record<SchoolLifecycle, string> = {
  trial: "bg-[#FFF1D6] text-[#9A6400]",
  expired: "bg-[#FFE9E3] text-[#B3401F]",
  paid: "bg-[#E2F4F1] text-[#0C8175]",
  suspended: "bg-[#FFE9E3] text-[#B3401F]",
  legacy: "bg-[#EEF0EC] text-[#5B6470]",
};

const FLAG_LABEL: Record<DupFlag["kind"], string> = {
  domain: "same domain",
  name: "same name",
  ip: "same IP",
};

type SchoolRow = {
  id: string;
  name: string | null;
  slug: string | null;
  status: string;
  country: string | null;
  contact_email: string | null;
  email_domain: string | null;
  created_at: string;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  meta: Record<string, unknown> | null;
};

export default async function ConsoleSchoolsPage() {
  const admin = createAdminClient();
  const now = new Date();

  const [schoolsQ, regsQ, entsQ, profilesQ, gensQ, booksQ] = await Promise.all([
    admin
      .from("schools")
      .select("id, name, slug, status, country, contact_email, email_domain, created_at, trial_started_at, trial_ends_at, meta"),
    admin.from("school_registrations").select("school_id, registrant_role, reg_ip, sales_stage, activation_requested_at"),
    admin.from("entitlements").select("school_id, active, plan_key, current_period_end").not("school_id", "is", null),
    admin.from("profiles").select("id, role, school_id"),
    admin.from("generations").select("owner_id, status"),
    admin.from("books").select("owner_id"),
  ]);

  const schools = (schoolsQ.data ?? []) as SchoolRow[];
  const regs = new Map(
    ((regsQ.data ?? []) as {
      school_id: string;
      registrant_role: string | null;
      reg_ip: string | null;
      sales_stage: string | null;
      activation_requested_at: string | null;
    }[]).map((r) => [r.school_id, r] as const),
  );
  const entsBySchool = new Map<string, { active: boolean; plan_key: string | null; current_period_end: string | null }[]>();
  for (const e of (entsQ.data ?? []) as { school_id: string; active: boolean; plan_key: string | null; current_period_end: string | null }[]) {
    const list = entsBySchool.get(e.school_id) ?? [];
    list.push(e);
    entsBySchool.set(e.school_id, list);
  }

  const profiles = (profilesQ.data ?? []) as { id: string; role: string; school_id: string | null }[];
  const ownerSchool = new Map(profiles.map((p) => [p.id, p.school_id] as const));
  const members = new Map<string, number>();
  for (const p of profiles) if (p.school_id) members.set(p.school_id, (members.get(p.school_id) ?? 0) + 1);
  const gensDone = new Map<string, number>();
  for (const g of (gensQ.data ?? []) as { owner_id: string; status: string }[]) {
    const sid = ownerSchool.get(g.owner_id);
    if (sid && g.status === "done") gensDone.set(sid, (gensDone.get(sid) ?? 0) + 1);
  }
  const bookCount = new Map<string, number>();
  for (const b of (booksQ.data ?? []) as { owner_id: string }[]) {
    const sid = ownerSchool.get(b.owner_id);
    if (sid) bookCount.set(sid, (bookCount.get(sid) ?? 0) + 1);
  }

  const flags = duplicateFlags(
    schools.map((s) => ({
      id: s.id,
      email_domain: s.email_domain,
      name_key: ((s.meta?.name_key as string | undefined) ?? null) || null,
      reg_ip: regs.get(s.id)?.reg_ip ?? null,
      created_at: s.created_at,
    })),
  );
  const nameOf = new Map(schools.map((s) => [s.id, s.name || "School"] as const));

  const rows = sortSchools(
    schools.map((s) => ({
      ...s,
      lifecycle: schoolLifecycle(s, entsBySchool.get(s.id) ?? [], now),
      reg: regs.get(s.id) ?? null,
      days: daysUntil(s.trial_ends_at, now),
      members: members.get(s.id) ?? 0,
      gensDone: gensDone.get(s.id) ?? 0,
      books: bookCount.get(s.id) ?? 0,
      flags: flags.get(s.id) ?? [],
    })),
  );

  const independents = profiles.filter((p) => !p.school_id && p.role !== "student").length;
  const liveTrials = rows.filter((r) => r.lifecycle === "trial").length;
  const expired = rows.filter((r) => r.lifecycle === "expired").length;

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Schools</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-6">
        {rows.length} school{rows.length === 1 ? "" : "s"} · {liveTrials} on trial · {expired} expired ·{" "}
        {independents} independent adult account{independents === 1 ? "" : "s"} (no school).
      </p>

      <div className="card divide-y divide-[#EEF0EC]">
        <div className="hidden lg:grid grid-cols-[2.4fr_0.5fr_1.3fr_1.7fr_1fr_1fr_0.9fr_1.2fr] gap-3 px-5 py-2 text-xs text-[#5B6470] font-medium">
          <span>School</span>
          <span>Country</span>
          <span>Type · size</span>
          <span>Registrant</span>
          <span>Trial</span>
          <span className="text-end">Lessons · books · people</span>
          <span>Stage</span>
          <span>Flags</span>
        </div>
        {rows.map((r) => {
          const meta = (r.meta ?? {}) as { school_type?: string; size_band?: string };
          return (
            <Link
              key={r.id}
              href={`/console/schools/${r.id}`}
              className="grid lg:grid-cols-[2.4fr_0.5fr_1.3fr_1.7fr_1fr_1fr_0.9fr_1.2fr] gap-x-3 gap-y-1 px-5 py-2.5 text-sm items-center hover:bg-[#FAFBF9]"
            >
              <span className="min-w-0">
                <span className="font-medium truncate block">
                  {r.name || "School"}
                  <span className={`chip font-sans ms-2 align-middle ${CHIP[r.lifecycle]}`}>{r.lifecycle}</span>
                  {r.reg?.activation_requested_at && (
                    <span className="chip font-sans ms-1 align-middle bg-[#E2F4F1] text-[#0C8175]">wants activation</span>
                  )}
                </span>
                <span className="text-xs text-[#5B6470] font-mono">{r.slug || "—"}</span>
              </span>
              <span className="font-mono text-xs">{r.country || "—"}</span>
              <span className="text-xs text-[#5B6470] truncate">
                {meta.school_type || "—"}
                {meta.size_band ? ` · ${meta.size_band}` : ""}
              </span>
              <span className="min-w-0">
                <span className="truncate block text-xs">{r.contact_email || "—"}</span>
                <span className="text-xs text-[#5B6470]">{r.reg?.registrant_role || ""}</span>
              </span>
              <span className="text-xs">
                {r.days === null ? (
                  <span className="text-[#5B6470]">no clock</span>
                ) : r.days > 0 ? (
                  <span className={r.days <= 7 ? "text-[#9A6400] font-medium" : ""}>{r.days}d left</span>
                ) : (
                  <span className="text-[#B3401F]">ended {-r.days}d ago</span>
                )}
              </span>
              <span className="tabular lg:text-end text-xs">
                {r.gensDone} · {r.books} · {r.members}
              </span>
              <span className="text-xs">{r.reg?.sales_stage ?? (r.lifecycle === "legacy" ? "—" : "new")}</span>
              <span className="flex flex-wrap gap-1">
                {r.flags.map((f, i) => (
                  <span key={i} className="chip font-sans bg-[#FFF1D6] text-[#9A6400]" title={`${FLAG_LABEL[f.kind]} as ${nameOf.get(f.with) ?? f.with}`}>
                    {FLAG_LABEL[f.kind]}
                  </span>
                ))}
              </span>
            </Link>
          );
        })}
        {rows.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No schools yet.</div>}
      </div>
    </main>
  );
}
