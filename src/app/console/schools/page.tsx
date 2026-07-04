import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";

// Per-school rollup: people, classes, content volume, open issues.

export const dynamic = "force-dynamic";

export default async function ConsoleSchoolsPage() {
  const admin = createAdminClient();

  const [schoolsQ, profilesQ, classesQ, gensQ, issuesQ] = await Promise.all([
    admin.from("schools").select("id, name, created_at").order("created_at", { ascending: true }),
    admin.from("profiles").select("id, role, school_id"),
    admin.from("classes").select("id, school_id"),
    admin.from("generations").select("id, owner_id, status"),
    admin.from("platform_issues").select("id, school_id, status"),
  ]);

  const profiles = (profilesQ.data ?? []) as { id: string; role: string; school_id: string | null }[];
  const ownerSchool = new Map(profiles.map((p) => [p.id, p.school_id] as const));

  type Row = { teachers: number; students: number; classes: number; gensDone: number; openIssues: number };
  const rows = new Map<string, Row>();
  const blank = (): Row => ({ teachers: 0, students: 0, classes: 0, gensDone: 0, openIssues: 0 });

  for (const p of profiles) {
    if (!p.school_id) continue;
    const r = rows.get(p.school_id) ?? blank();
    if (p.role === "student") r.students++;
    else if (p.role !== "school_admin") r.teachers++;
    rows.set(p.school_id, r);
  }
  for (const c of (classesQ.data ?? []) as { id: string; school_id: string | null }[]) {
    if (!c.school_id) continue;
    const r = rows.get(c.school_id) ?? blank();
    r.classes++;
    rows.set(c.school_id, r);
  }
  for (const g of (gensQ.data ?? []) as { id: string; owner_id: string; status: string }[]) {
    const sid = ownerSchool.get(g.owner_id);
    if (!sid || g.status !== "done") continue;
    const r = rows.get(sid) ?? blank();
    r.gensDone++;
    rows.set(sid, r);
  }
  for (const i of (issuesQ.data ?? []) as { id: string; school_id: string | null; status: string }[]) {
    if (!i.school_id || i.status === "resolved") continue;
    const r = rows.get(i.school_id) ?? blank();
    r.openIssues++;
    rows.set(i.school_id, r);
  }

  const schools = (schoolsQ.data ?? []) as { id: string; name: string | null; created_at: string }[];
  const independents = profiles.filter((p) => !p.school_id && p.role !== "student").length;

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Schools</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-6">
        {schools.length} school{schools.length === 1 ? "" : "s"} · {independents} independent adult
        account{independents === 1 ? "" : "s"} (no school).
      </p>

      <div className="card divide-y divide-[#EEF0EC]">
        <div className="hidden sm:grid grid-cols-[2fr_repeat(5,1fr)] gap-3 px-5 py-2 text-xs text-[#5B6470] font-medium">
          <span>School</span><span className="text-right">Teachers</span><span className="text-right">Students</span>
          <span className="text-right">Classes</span><span className="text-right">Lessons done</span><span className="text-right">Open issues</span>
        </div>
        {schools.map((s) => {
          const r = rows.get(s.id) ?? blank();
          return (
            <div key={s.id} className="grid sm:grid-cols-[2fr_repeat(5,1fr)] gap-x-3 gap-y-1 px-5 py-2.5 text-sm items-center">
              <span className="font-medium truncate">{s.name || "School"}</span>
              <span className="tabular sm:text-right">{r.teachers}</span>
              <span className="tabular sm:text-right">{r.students}</span>
              <span className="tabular sm:text-right">{r.classes}</span>
              <span className="tabular sm:text-right">{r.gensDone}</span>
              <span className={`tabular sm:text-right ${r.openIssues ? "text-[#9A6400]" : ""}`}>{r.openIssues}</span>
            </div>
          );
        })}
        {schools.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No schools yet.</div>}
      </div>
    </main>
  );
}
