import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";

// Read-only user roster (ops controls arrive with the next console phase).
// Search across name/username/email; students shown but marked — staff mostly
// works with adult accounts here.

export const dynamic = "force-dynamic";

export default async function ConsoleUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const admin = createAdminClient();

  const { data: profRaw } = await admin
    .from("profiles")
    .select("id, full_name, username, role, school_id, beta_tester, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  type Prof = { id: string; full_name: string | null; username: string | null; role: string; school_id: string | null; beta_tester: boolean | null; created_at: string };
  let profiles = (profRaw ?? []) as Prof[];

  const { data: schoolsRaw } = await admin.from("schools").select("id, name");
  const schoolName = new Map((schoolsRaw ?? []).map((s) => [s.id as string, (s.name as string) || "School"]));

  // Emails live in auth.users — fetch via the admin auth API (paged).
  const emails = new Map<string, string>();
  try {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) emails.set(u.id, u.email ?? "");
  } catch {
    // roster still renders without emails
  }

  const needle = (q ?? "").trim().toLowerCase();
  if (needle) {
    profiles = profiles.filter((p) =>
      [p.full_name, p.username, emails.get(p.id), p.role, schoolName.get(p.school_id ?? "")]
        .some((v) => (v ?? "").toLowerCase().includes(needle)),
    );
  }

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Users</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-5">{profiles.length} account{profiles.length === 1 ? "" : "s"}{needle ? ` matching “${q}”` : ""}. Read-only for now — ops controls land in the next phase.</p>

      <form method="get" className="mb-5">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search name, email, username, role, school…"
          className="field w-full sm:w-96 h-10 px-3"
        />
      </form>

      <div className="card divide-y divide-[#EEF0EC]">
        <div className="hidden sm:grid grid-cols-[2fr_2fr_1fr_1.5fr_1fr] gap-3 px-5 py-2 text-xs text-[#5B6470] font-medium">
          <span>Name</span><span>Email / username</span><span>Role</span><span>School</span><span className="text-right">Joined</span>
        </div>
        {profiles.map((p) => (
          <div key={p.id} className="grid sm:grid-cols-[2fr_2fr_1fr_1.5fr_1fr] gap-x-3 gap-y-1 px-5 py-2.5 text-sm items-center">
            <span className="font-medium truncate">
              {p.full_name || p.username || "—"}
              {p.beta_tester && <span className="chip font-sans bg-[#FFF1D6] text-[#9A6400] ml-2">beta</span>}
            </span>
            <span className="truncate text-[#5B6470]">{emails.get(p.id) || p.username || "—"}</span>
            <span className={p.role === "student" ? "text-[#98A0A9]" : ""}>{p.role}</span>
            <span className="truncate text-[#5B6470]">{p.school_id ? schoolName.get(p.school_id) ?? "—" : "—"}</span>
            <span className="tabular sm:text-right text-xs text-[#5B6470]">{new Date(p.created_at).toLocaleDateString()}</span>
          </div>
        ))}
        {profiles.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No matches.</div>}
      </div>
    </main>
  );
}
