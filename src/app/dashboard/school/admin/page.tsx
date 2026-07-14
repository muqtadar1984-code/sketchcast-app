import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { schoolAnalyticsEnabledFor } from "@/utils/flags";
import CoordinatorAdmin, { type Member, type Scope } from "../coordinator-admin";
import ResetPasswordButton from "../../reset-password-button";

// Admin settings (school_admin only): roster role management + the
// coordinator → (grade, subject) scope mapping that drives the whole permission
// model, plus the DPDP access-audit trail. Behind FEATURE_SCHOOL_ANALYTICS.
export default async function SchoolAdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, school_id")
    .eq("id", user.id)
    .single();
  // Global env flag OR this school's config override (the sales-demo tenant).
  if (!(await schoolAnalyticsEnabledFor(supabase, profile?.school_id as string | null)))
    redirect("/dashboard");
  const role = (profile?.role as string | null) ?? null;
  if (role === "coordinator") redirect("/dashboard/school");
  if (role !== "school_admin") redirect("/dashboard");

  // School roster (teachers + coordinators), scope rows, and the option lists.
  const { data: peopleRaw } = await supabase
    .from("profiles")
    .select("id, full_name, username, role")
    .eq("school_id", profile!.school_id);
  const people = (peopleRaw ?? []) as { id: string; full_name: string | null; username: string | null; role: string }[];
  const nameOf = new Map(people.map((p) => [p.id, p.full_name || p.username || "User"] as const));
  const members: Member[] = people
    .filter((p) => p.role === "teacher" || p.role === "coordinator")
    .map((p) => ({ id: p.id, name: p.full_name || p.username || "User", role: p.role as "teacher" | "coordinator" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const { data: scopesRaw } = await supabase
    .from("coordinator_scope")
    .select("id, coordinator_id, grade, subject");
  const scopes = (scopesRaw ?? []) as Scope[];

  const { data: classesRaw } = await supabase.from("classes").select("grade");
  const grades = [...new Set((classesRaw ?? []).map((c) => (c.grade as string | null)?.trim()).filter(Boolean) as string[])].sort();

  const { data: booksRaw } = await supabase.from("books").select("subject");
  const subjects = [...new Set((booksRaw ?? []).map((b) => (b.subject as string | null)?.trim()).filter(Boolean) as string[])].sort();

  type LogRow = { id: string; actor_id: string; actor_role: string | null; scope: string; target_kind: string | null; detail: { at_risk?: number; students?: number } | null; created_at: string };
  const { data: logRaw } = await supabase
    .from("analytics_access_log")
    .select("id, actor_id, actor_role, scope, target_kind, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(25);
  const log = (logRaw ?? []) as LogRow[];

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">School admin</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">
          Roles &amp; oversight scopes — who can see which slice of the school, and a log of who looked.
        </p>

        <CoordinatorAdmin members={members} scopes={scopes} grades={grades} subjects={subjects} />

        <h2 className="text-xl mt-10 mb-1">Members</h2>
        <p className="text-sm text-[#5B6470] mb-3">
          Teachers &amp; coordinators in your school. Resetting hands you a temporary password to
          pass on — it&apos;s shown once, and they must choose a new one at their next sign-in.
        </p>
        {members.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">No teachers yet.</div>
        ) : (
          <div className="card divide-y divide-[#EEF0EC]">
            {members.map((m) => (
              <div key={m.id} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{m.name}</span>
                  <span className="text-[#5B6470]"> · {m.role}</span>
                </span>
                <ResetPasswordButton targetId={m.id} name={m.name} />
              </div>
            ))}
          </div>
        )}

        <h2 className="text-xl mt-10 mb-1">Access audit</h2>
        <p className="text-sm text-[#5B6470] mb-3">
          Every leadership view of student data is logged here for the data-protection trail.
        </p>
        {log.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">No access recorded yet.</div>
        ) : (
          <div className="card divide-y divide-[#EEF0EC]">
            {log.map((l) => (
              <div key={l.id} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{nameOf.get(l.actor_id) || "User"}</span>
                  <span className="text-[#5B6470]"> · {l.actor_role}</span>
                </span>
                <span className="flex items-center gap-3 shrink-0 text-xs text-[#5B6470]">
                  <span className="chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal">{l.scope}</span>
                  {l.detail?.at_risk != null && <span className="tabular">{l.detail.at_risk} at-risk</span>}
                  <span className="tabular">{new Date(l.created_at).toLocaleString()}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
