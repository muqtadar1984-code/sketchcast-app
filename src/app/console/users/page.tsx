import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import { demoAccountPassword, partitionByDemo } from "@/utils/demo";

// User roster — search across name/username/email; rows open the account's
// detail page (activity, issues, ops controls). Two tabs: real users (default)
// and demo accounts (profiles.is_demo, migration 0081) — the seeded sales
// tenants live in their own tab so the real roster stays honest, and staff can
// read a demo login + its shared password mid-pitch without digging out the
// seeder's credentials file.

export const dynamic = "force-dynamic";

export default async function ConsoleUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string }>;
}) {
  const { q, tab } = await searchParams;
  const demoTab = tab === "demo";
  const admin = createAdminClient();

  const { data: profRaw } = await admin
    .from("profiles")
    .select("id, full_name, username, role, school_id, beta_tester, is_demo, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  type Prof = { id: string; full_name: string | null; username: string | null; role: string; school_id: string | null; beta_tester: boolean | null; is_demo: boolean | null; created_at: string };
  const { real, demo } = partitionByDemo((profRaw ?? []) as Prof[]);
  let profiles = demoTab ? demo : real;

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

  const tabs = [
    { href: "/console/users", label: `Users (${real.length})`, active: !demoTab },
    { href: "/console/users?tab=demo", label: `Demo (${demo.length})`, active: demoTab },
  ];

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Users</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-5">
        {profiles.length}{demoTab ? " demo" : ""} account{profiles.length === 1 ? "" : "s"}{needle ? ` matching “${q}”` : ""}. Click a row for detail + ops.
      </p>

      <div className="flex flex-wrap gap-2 mb-5">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`chip font-sans normal-case tracking-normal ${
              t.active ? "bg-[#14181F] text-white" : "bg-[#EEF0EC] text-[#5B6470]"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <form method="get" className="mb-5">
        {demoTab && <input type="hidden" name="tab" value="demo" />}
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search name, email, username, role, school…"
          className="field w-full sm:w-96 h-10 px-3"
        />
      </form>

      <div className="card divide-y divide-[#EEF0EC]">
        <div className="hidden sm:grid grid-cols-[2fr_2fr_1fr_1.5fr_1fr] gap-3 px-5 py-2 text-xs text-[#5B6470] font-medium">
          <span>Name</span><span>Email / username</span><span>Role</span><span>School</span>
          {demoTab ? <span>Password</span> : <span className="text-end">Joined</span>}
        </div>
        {profiles.map((p) => (
          <Link key={p.id} href={`/console/users/${p.id}`} className="grid sm:grid-cols-[2fr_2fr_1fr_1.5fr_1fr] gap-x-3 gap-y-1 px-5 py-2.5 text-sm items-center hover:bg-[#FAFBF9]">
            <span className="font-medium truncate">
              {p.full_name || p.username || "—"}
              {/* Every signup is auto-flagged (0012), so on the demo tab the
                  chip would sit on every row and mean nothing — real tab only. */}
              {!demoTab && p.beta_tester && <span className="chip font-sans bg-[#FFF1D6] text-[#9A6400] ms-2">trial</span>}
            </span>
            <span className="truncate text-[#5B6470]">
              {/* Students log in by username, adults by email — on the demo tab
                  show the identifier staff would actually type at the portal. */}
              {demoTab ? p.username || emails.get(p.id) || "—" : emails.get(p.id) || p.username || "—"}
            </span>
            <span className={p.role === "student" ? "text-[#98A0A9]" : ""}>{p.role}</span>
            <span className="truncate text-[#5B6470]">{p.school_id ? schoolName.get(p.school_id) ?? "—" : "—"}</span>
            {demoTab ? (
              <span className="font-mono text-xs text-[#5B6470]">{demoAccountPassword(emails.get(p.id), p.school_id) ?? "—"}</span>
            ) : (
              <span className="tabular sm:text-end text-xs text-[#5B6470]">{new Date(p.created_at).toLocaleDateString()}</span>
            )}
          </Link>
        ))}
        {profiles.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No matches.</div>}
      </div>
    </main>
  );
}
